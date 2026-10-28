import { LedgerError, type Clock, type CommandRepository, type LedgerGateway } from '../ports/index.js';

export interface ExecutorDeps {
  commands: CommandRepository;
  gateway: LedgerGateway;
  clock: Clock;
}

export interface ExecutorOptions {
  /** Max antal kommandon som låses per omgång. */
  batchSize?: number;
  /** Efter så många försök blir ett kommando 'dead' och kräver mänsklig hantering. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  /** Utfört i affärssystemet men resultatet kunde inte sparas. Återupptas säkert via idempotens. */
  unconfirmed: number;
}

const DEFAULTS = { batchSize: 25, maxAttempts: 8, baseDelayMs: 30_000, maxDelayMs: 3_600_000 } as const;

/** Exponentiell backoff utan slump, så att beteendet är förutsägbart och testbart. */
export function backoffDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}

/**
 * Kör förfallna kommandon en omgång. Kommandon inom en utbetalning utförs i ordning
 * (kön släpper bara fram nästa när föregående lyckats), så en omgång tar högst ett
 * kommando per utbetalning. Använd `drain` för att köra tills kön är tom.
 */
export async function runDueCommands(deps: ExecutorDeps, options: ExecutorOptions = {}): Promise<RunSummary> {
  const opts = { ...DEFAULTS, ...options };
  const summary: RunSummary = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, unconfirmed: 0 };

  const claimed = await deps.commands.claimDue(deps.clock.now(), opts.batchSize);
  summary.claimed = claimed.length;

  for (const item of claimed) {
    let externalId: string;
    try {
      ({ externalId } = await deps.gateway.execute(item.tenantId, item.command));
    } catch (error) {
      const now = deps.clock.now();
      // Okända fel behandlas som tillfälliga tills försöken är slut. Hellre ett försök för mycket
      // (säkert tack vare idempotensen) än att ge upp på ett fel som hade gått över.
      const retryable = error instanceof LedgerError ? error.retryable : true;
      const exhausted = item.attempts >= opts.maxAttempts;
      if (!retryable || exhausted) {
        await deps.commands.markFailed(item.id, describeError(error), null, now);
        summary.dead++;
      } else {
        const delay =
          error instanceof LedgerError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : backoffDelayMs(item.attempts, opts.baseDelayMs, opts.maxDelayMs);
        await deps.commands.markFailed(item.id, describeError(error), new Date(now.getTime() + delay), now);
        summary.retrying++;
      }
      continue;
    }

    try {
      await deps.commands.markSucceeded(item.id, externalId, deps.clock.now());
      summary.succeeded++;
    } catch {
      // Affärssystemet har tagit emot kommandot men vi kunde inte spara det. Kommandot ligger kvar
      // som 'in_progress' och släpps av releaseStale. Gatewayens idempotens förhindrar dubbelbokning.
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
  staleAfterMs = 10 * 60_000,
): Promise<number> {
  const now = deps.clock.now();
  return deps.commands.releaseStale(new Date(now.getTime() - staleAfterMs), now);
}
