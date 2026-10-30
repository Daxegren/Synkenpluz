import { reconcile } from '../engine/reconcile.js';
import type { Payout, ReconcileException, ReconcileInput, ReconcileResult } from '../domain/types.js';
import type { Clock, PayoutStatus, StoredCommand, UnitOfWork } from '../ports/index.js';

export interface ProcessPayoutDeps {
  uow: UnitOfWork;
  clock: Clock;
}

export interface ProcessPayoutOptions {
  /**
   * dry_run: beräkna och returnera förslaget. Förslaget sparas för granskning, inget annat.
   * Används för nya kunder tills de godkänt förslagen (SPEC avsnitt 6). Godkännande = kör live.
   */
  mode?: 'live' | 'dry_run';
  actor?: string;
}

export interface ProcessPayoutOutcome {
  mode: 'live' | 'dry_run';
  result: ReconcileResult;
  /** Antal nya kommandon som lades i kön (0 vid omkörning av redan köade). */
  enqueued: number;
  /** Öppna avvikelser som löstes automatiskt eftersom de inte längre uppstår. */
  autoResolved: number;
}

const exceptionKey = (e: { code: string; lineId?: string | null }) => `${e.code}|${e.lineId ?? ''}`;

/**
 * Avstämmer en utbetalning och sparar resultatet atomiskt: kommandon till kön,
 * avvikelser till avvikelsekön, utbetalningsstatus och revisionspost. Säker att köra
 * om för samma utbetalning.
 */
export async function processPayout(
  deps: ProcessPayoutDeps,
  input: Omit<ReconcileInput, 'settledLineIds'>,
  options: ProcessPayoutOptions = {},
): Promise<ProcessPayoutOutcome> {
  const mode = options.mode ?? 'live';
  const actor = options.actor ?? 'system';
  const { tenantId, payout } = input;

  return deps.uow.run(async (repos) => {
    const now = deps.clock.now();

    // Rader som redan har kommandon från tidigare körning ska inte matchas om.
    const existing = await repos.commands.listByPayout(tenantId, payout.id);
    const settledLineIds = new Set<string>();
    for (const stored of existing) {
      if (stored.command.kind !== 'post_voucher') settledLineIds.add(stored.command.lineId);
    }

    const reconciled = reconcile({ ...input, settledLineIds });
    const result = withConflicts(reconciled, existing, payout);

    if (mode === 'dry_run') {
      // Förslaget sparas (ett per utbetalning, det senaste gäller) så att kunden eller deras redovisningskonsult
      // kan granska vad som SKULLE bokföras innan go-live. Inga kommandon köas, inga avvikelser läggs in och
      // ingen revisionspost skrivs (den skulle annars växa med en post per cykel för alltid).
      await repos.proposals.upsert(tenantId, payout.id, result, now);
      return { mode, result, enqueued: 0, autoResolved: 0 };
    }

    // Live: förslaget har gjort sitt. Bokföringen sker nu på riktigt.
    await repos.proposals.delete(tenantId, payout.id);

    const enqueued = await repos.commands.enqueue(tenantId, payout.id, result.commands, now);
    const newExceptions = await repos.exceptions.add(tenantId, payout.id, result.exceptions, now);

    // Avvikelser som inte längre uppstår (t.ex. för att faktura nu finns) stängs automatiskt.
    const current = new Set(result.exceptions.map(exceptionKey));
    let autoResolved = 0;
    for (const open of await repos.exceptions.list(tenantId, { status: 'open', payoutId: payout.id })) {
      if (current.has(exceptionKey(open))) continue;
      const ok = await repos.exceptions.resolve(
        tenantId,
        open.id,
        { status: 'resolved', note: 'Löstes automatiskt vid omkörning' },
        now,
      );
      if (ok) autoResolved++;
    }

    // En utbetalning är inte klar om något av dess kommandon permanent misslyckats.
    const hasDead = (await repos.commands.listByPayout(tenantId, payout.id)).some((c) => c.status === 'dead');
    const status: PayoutStatus = result.status === 'complete' && hasDead ? 'partial' : result.status;
    const previous = await repos.payouts.get(tenantId, payout.id);
    await repos.payouts.record({ tenantId, payoutId: payout.id, status, processedAt: now });

    // Delvis avstämda utbetalningar återupptas i varje körcykel. Logga bara när något faktiskt hänt,
    // annars växer revisionsloggen med en post per cykel och utbetalning utan nytt innehåll.
    const changed = enqueued > 0 || autoResolved > 0 || newExceptions > 0 || previous?.status !== status;
    if (changed) {
      await repos.audit.append(
        { tenantId, actor, action: 'payout.processed', details: { ...summarize(payout.id, result), enqueued, autoResolved } },
        now,
      );
    }
    return { mode, result, enqueued, autoResolved };
  });
}

/**
 * Köns idempotens släpper tyst ett kommando vars nyckel redan finns. Om innehållet skiljer sig
 * (leverantören har ändrat en rad som redan köats) vore det farligt: det gamla utförs och det nya
 * försvinner. Då lyfter vi det som avvikelse i stället.
 */
function withConflicts(result: ReconcileResult, existing: readonly StoredCommand[], payout: Payout): ReconcileResult {
  const previous = new Map(existing.map((e) => [e.key, canonical(e.command)]));
  const conflicts: ReconcileException[] = [];
  const conflict = (lineId: string) =>
    conflicts.push({
      code: 'COMMAND_CONFLICT',
      lineId,
      message: 'Raden har ändrats eller försvunnit sedan den köades. Det köade kommandot behålls, granska manuellt',
    });

  // Rader som redan köats hoppas över av motorn, så jämför dem direkt mot det köade kommandot.
  const lines = new Map(payout.lines.map((l) => [l.id, l]));
  for (const stored of existing) {
    const cmd = stored.command;
    if (cmd.kind === 'post_voucher') continue;
    const line = lines.get(cmd.lineId);
    const expectedType = cmd.kind === 'register_invoice_payment' ? 'payment' : 'refund';
    if (!line || line.type !== expectedType || line.amount !== cmd.amount) conflict(cmd.lineId);
  }

  for (const command of result.commands) {
    const before = previous.get(command.key);
    if (before === undefined || before === canonical(command)) continue;
    conflicts.push({
      code: 'COMMAND_CONFLICT',
      ...(command.kind !== 'post_voucher' ? { lineId: command.lineId } : {}),
      message: 'Verifikatet skiljer sig från det som köades. Det köade behålls, granska manuellt',
    });
  }
  if (conflicts.length === 0) return result;
  return {
    ...result,
    status: result.status === 'complete' ? 'partial' : result.status,
    exceptions: [...result.exceptions, ...conflicts],
  };
}

/** Stabil serialisering (sorterade nycklar), eftersom jsonb inte bevarar nyckelordning. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Revisionsposter innehåller bara id:n, koder och antal. Aldrig belopp per kund eller referenser. */
function summarize(payoutId: string, result: ReconcileResult) {
  return {
    payoutId,
    status: result.status,
    commands: result.commands.length,
    exceptions: result.exceptions.map((e: ReconcileException) => e.code),
  };
}
