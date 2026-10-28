import type { Payout } from '../domain/types.js';
import type { Clock, UnitOfWork } from '../ports/index.js';
import type {
  InvoiceReader,
  PayoutSource,
  SyncStateStore,
  TenantConfigProvider,
} from '../ports/sources.js';
import { processPayout, type ProcessPayoutOutcome } from './processPayout.js';

export interface SyncDeps {
  uow: UnitOfWork;
  clock: Clock;
  source: PayoutSource;
  invoices: InvoiceReader;
  config: TenantConfigProvider;
  state: SyncStateStore;
}

export interface SyncSummary {
  tenantId: string;
  mode: 'live' | 'dry_run';
  fetched: number;
  resumed: number;
  complete: number;
  partial: number;
  rejected: number;
  failed: Array<{ payoutId: string; error: string }>;
}

const MAX_ERROR_LENGTH = 300;

/**
 * Hämtar nya utbetalningar från betalleverantören, avstämmer dem, och försöker på nytt för
 * tidigare delvis avstämda (en saknad faktura kan ha dykt upp sedan sist).
 *
 * Felisolering: ett fel på en utbetalning stoppar inte de andra. Cursorn flyttas bara fram
 * när alla nya utbetalningar hanterats utan fel, så en misslyckad utbetalning hämtas igen.
 * Det är säkert eftersom bearbetningen är idempotent.
 */
export async function syncTenant(deps: SyncDeps, tenantId: string): Promise<SyncSummary> {
  const config = await deps.config.get(tenantId);
  if (!config) throw new Error(`Okänd kund: ${tenantId}`);

  const summary: SyncSummary = {
    tenantId,
    mode: config.mode,
    fetched: 0,
    resumed: 0,
    complete: 0,
    partial: 0,
    rejected: 0,
    failed: [],
  };

  const handle = async (payout: Payout) => {
    try {
      const references = payout.lines.flatMap((l) => (l.type === 'fee' ? [] : [l.reference]));
      const invoices = await deps.invoices.findByReferences(tenantId, references);
      const outcome = await processPayout(
        { uow: deps.uow, clock: deps.clock },
        { tenantId, payout, invoices, accounts: config.accounts },
        { mode: config.mode },
      );
      count(summary, outcome);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      summary.failed.push({ payoutId: payout.id, error: text.slice(0, MAX_ERROR_LENGTH) });
    }
  };

  // 1. Nya utbetalningar.
  const cursor = await deps.state.getCursor(tenantId);
  const { payouts, nextCursor } = await deps.source.listPayoutsSince(tenantId, cursor);
  summary.fetched = payouts.length;
  const seen = new Set<string>();
  for (const payout of payouts) {
    seen.add(payout.id);
    await handle(payout);
  }

  // 2. Återuppta delvis avstämda (bara i live-läge, dry_run sparar inget att återuppta).
  if (config.mode === 'live') {
    const open = await deps.uow.run((repos) => repos.payouts.list(tenantId, { status: 'partial' }));
    for (const record of open) {
      if (seen.has(record.payoutId)) continue;
      try {
        const payout = await deps.source.getPayout(tenantId, record.payoutId);
        if (!payout) {
          summary.failed.push({ payoutId: record.payoutId, error: 'Utbetalningen finns inte längre hos leverantören' });
          continue;
        }
        summary.resumed++;
        await handle(payout);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        summary.failed.push({ payoutId: record.payoutId, error: text.slice(0, MAX_ERROR_LENGTH) });
      }
    }
  }

  // I dry_run flyttas cursorn inte fram: inget sparades, så utbetalningarna måste hämtas på
  // nytt (och bokföras på riktigt) när kunden går live.
  const newFailures = summary.failed.filter((f) => seen.has(f.payoutId));
  if (config.mode === 'live' && newFailures.length === 0 && nextCursor !== cursor) {
    await deps.state.setCursor(tenantId, nextCursor);
  }
  return summary;
}

function count(summary: SyncSummary, outcome: ProcessPayoutOutcome): void {
  summary[outcome.result.status]++;
}
