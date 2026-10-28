import {
  LedgerError,
  type Clock,
  type CommandRepository,
  type LedgerGateway,
  type StoredCommand,
} from '../ports/index.js';

export interface ExecutorDeps {
  commands: CommandRepository;
  gateway: LedgerGateway;
  clock: Clock;
  /**
   * Anropas när ett kommando blivit permanent misslyckat (dött). Används för att markera
   * utbetalningen som ofullständig och skriva revisionspost. Fel här stoppar inte exekveringen.
   */
  onDead?: (command: StoredCommand, reason: string) => Promise<void>;
}

export interface ExecutorOptions {
  /** Max antal kommandon som låses per omgång. */
  batchSize?: number;
  /** Efter så många försök blir ett kommando 'dead' och kräver mänsklig hantering. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Tak för ett enskilt anrop mot affärssystemet. Vid timeout försöks kommandot om (gatewayens idempotens skyddar). */
  executeTimeoutMs?: number;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  /** Utfört i affärssystemet men resultatet kunde inte sparas. Återupptas säkert via idempotens. */
  unconfirmed: number;
}

const DEFAULTS = {
  batchSize: 25,
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
  executeTimeoutMs: 60_000,
} as const;

/**
 * Hur länge ett kommando får ligga som 'in_progress' innan det anses övergivet. Måste vara längre
 * än en hel omgång i värsta fall (batchSize x executeTimeoutMs = 25 min), annars släpps kommandon
 * som fortfarande körs och samma kommando kan köras av två arbetare samtidigt.
 */
export const DEFAULT_STALE_AFTER_MS = 30 * 60_000;

/** Exponentiell backoff utan slump, så att beteendet är förutsägbart och testbart. */
export function backoffDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Affärssystemet svarade inte inom ${ms} ms`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fördröjning inför nästa försök. Affärssystemets Retry-After respekteras men aldrig under den
 * vanliga backoffen (en Retry-After: 0 får inte bränna alla försök direkt) och aldrig över taket.
 * Ogiltiga värden (NaN, negativa) ignoreras.
 */
function retryDelay(error: unknown, attempts: number, o: { baseDelayMs: number; maxDelayMs: number }): number {
  const backoff = backoffDelayMs(attempts, o.baseDelayMs, o.maxDelayMs);
  if (error instanceof LedgerError && error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs)) {
    return Math.min(o.maxDelayMs, Math.max(backoff, error.retryAfterMs));
  }
  return backoff;
}

/**
 * Kör förfallna kommandon en omgång. Kommandon inom en utbetalning utförs i ordning
 * (kön släpper bara fram nästa när föregående lyckats), så en omgång tar högst ett
 * kommando per utbetalning. Använd `drain` för att köra tills kön är tom.
 *
 * Ett fel i bokföringen av ett enskilt kommandos utfall får aldrig lämna resten av omgången
 * låst: varje kommando hanteras i en egen try/catch.
 */
export async function runDueCommands(deps: ExecutorDeps, options: ExecutorOptions = {}): Promise<RunSummary> {
  const opts = { ...DEFAULTS, ...options };
  const summary: RunSummary = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, unconfirmed: 0 };

  const claimed = await deps.commands.claimDue(deps.clock.now(), opts.batchSize);
  summary.claimed = claimed.length;

  const markDead = async (item: StoredCommand, reason: string) => {
    await deps.commands.markFailed(item.id, reason, null, deps.clock.now(), item.attempts);
    summary.dead++;
    try {
      await deps.onDead?.(item, reason);
    } catch {
      // Larmet kommer ändå från countDead i körcykeln.
    }
  };

  for (const item of claimed) {
    try {
      // Ett kommando som låsts fler gånger än tillåtet utan att någonsin avslutas (processen kraschar
      // varje gång) körs inte igen: det kan vara det som orsakar kraschen.
      if (item.attempts > opts.maxAttempts) {
        await markDead(item, 'För många försök utan avslut. Kontrollera om kommandot kraschar processen');
        continue;
      }

      let externalId: string;
      try {
        ({ externalId } = await withTimeout(deps.gateway.execute(item.tenantId, item.command), opts.executeTimeoutMs));
      } catch (error) {
        // Okända fel och timeouts behandlas som tillfälliga tills försöken är slut. Hellre ett försök
        // för mycket (säkert tack vare idempotensen) än att ge upp på ett fel som hade gått över.
        const retryable = error instanceof LedgerError ? error.retryable : true;
        if (!retryable || item.attempts >= opts.maxAttempts) {
          await markDead(item, describeError(error));
        } else {
          const delay = retryDelay(error, item.attempts, opts);
          const now = deps.clock.now();
          await deps.commands.markFailed(item.id, describeError(error), new Date(now.getTime() + delay), now, item.attempts);
          summary.retrying++;
        }
        continue;
      }

      try {
        await deps.commands.markSucceeded(item.id, externalId, deps.clock.now(), item.attempts);
        summary.succeeded++;
      } catch {
        // Affärssystemet har tagit emot kommandot men vi kunde inte spara det. Kommandot ligger kvar
        // som 'in_progress' och släpps av releaseStale. Gatewayens idempotens förhindrar dubbelbokning.
        summary.unconfirmed++;
      }
    } catch {
      // Misslyckades vi att spara utfallet (t.ex. databasen hickade) ligger kommandot kvar som
      // 'in_progress' och släpps av releaseStale. Fortsätt med resten i stället för att kasta.
      summary.unconfirmed++;
    }
  }
  return summary;
}

/** Kör omgångar tills inget mer är redo, eller `maxRounds` nåtts. */
export async function drain(deps: ExecutorDeps, options: ExecutorOptions = {}, maxRounds = 100): Promise<RunSummary> {
  const total: RunSummary = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, unconfirmed: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const summary = await runDueCommands(deps, options);
    if (summary.claimed === 0) break;
    total.claimed += summary.claimed;
    total.succeeded += summary.succeeded;
    total.retrying += summary.retrying;
    total.dead += summary.dead;
    total.unconfirmed += summary.unconfirmed;
  }
  return total;
}

/** Släpper kommandon som legat som 'in_progress' längre än `staleAfterMs` (t.ex. efter en krasch). */
export async function recoverStale(
  deps: Pick<ExecutorDeps, 'commands' | 'clock'>,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): Promise<number> {
  const now = deps.clock.now();
  return deps.commands.releaseStale(new Date(now.getTime() - staleAfterMs), now);
}
