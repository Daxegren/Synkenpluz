import { drain, recoverStale, type ExecutorDeps, type ExecutorOptions, type RunSummary } from '../executor/executor.js';
import { syncTenant, type SyncDeps, type SyncSummary } from '../service/syncTenant.js';

/** Strukturerad loggning. Får aldrig få hemligheter, tokens eller personuppgifter. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface CycleDeps {
  executor: ExecutorDeps;
  sync: SyncDeps;
  /** Kunder som ska synkas. I drift: aktiva kunder med kopplingar. */
  listTenants(): Promise<string[]>;
  logger?: Logger;
  executorOptions?: ExecutorOptions;
  staleAfterMs?: number;
}

export interface Alert {
  severity: 'warning' | 'critical';
  tenantId?: string;
  message: string;
}

export interface CycleReport {
  recovered: number;
  execution: RunSummary;
  tenants: Array<{ tenantId: string; summary?: SyncSummary; error?: string }>;
  alerts: Alert[];
}

/**
 * En körcykel: släpp fastnade kommandon, synka varje kund, kör kön. Ett fel för en kund
 * stoppar inte de andra. Anropas av en schemaläggare (t.ex. var minut) i en eller flera
 * arbetsprocesser; kön är säker för samtidiga arbetare.
 */
export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const log = deps.logger ?? silentLogger;
  const alerts: Alert[] = [];

  const recovered = await recoverStale(deps.executor, deps.staleAfterMs);
  if (recovered > 0) log.warn('Släppte fastnade kommandon', { recovered });

  const tenants: CycleReport['tenants'] = [];
  for (const tenantId of await deps.listTenants()) {
    try {
      const summary = await syncTenant(deps.sync, tenantId);
      tenants.push({ tenantId, summary });
      log.info('Synk klar', {
        tenantId,
        fetched: summary.fetched,
        resumed: summary.resumed,
        complete: summary.complete,
        partial: summary.partial,
        rejected: summary.rejected,
        failed: summary.failed.length,
      });
      if (summary.rejected > 0) {
        alerts.push({ severity: 'warning', tenantId, message: `${summary.rejected} utbetalning(ar) avvisades och kräver granskning` });
      }
      if (summary.failed.length > 0) {
        alerts.push({ severity: 'warning', tenantId, message: `${summary.failed.length} utbetalning(ar) kunde inte hanteras` });
      }
    } catch (error) {
      // Logga bara feltexten. Anslutningsfel kan innehålla url:er men inte hemligheter i våra adaptrar.
      const message = error instanceof Error ? error.message.slice(0, 300) : 'okänt fel';
      tenants.push({ tenantId, error: message });
      log.error('Synk misslyckades', { tenantId, error: message });
      alerts.push({ severity: 'warning', tenantId, message: `Synk misslyckades: ${message}` });
    }
  }

  const execution = await drain(deps.executor, deps.executorOptions);
  // Larma så länge något ligger dött, inte bara i den cykel där det dog. Det kräver en människa.
  const dead = await deps.executor.commands.countDead();
  if (dead > 0) {
    log.error('Kommandon väntar på mänsklig hantering', { dead });
    alerts.push({ severity: 'critical', message: `${dead} kommando(n) har permanent misslyckats och blockerar sina utbetalningar` });
  }
  if (execution.unconfirmed > 0) {
    alerts.push({ severity: 'warning', message: `${execution.unconfirmed} kommando(n) utfört men ej bekräftat, återupptas automatiskt` });
  }
  return { recovered, execution, tenants, alerts };
}
