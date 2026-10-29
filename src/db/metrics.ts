import type { CommandStatus } from '../ports/index.js';
import type { Db } from './db.js';

/**
 * Driftmätvärden. Bara aggregat över hela systemet: ingen etikett innehåller kund-id, utbetalnings-id,
 * nycklar eller annan kunddata (låg kardinalitet och ingen läckage mellan kunder).
 */
export interface Metrics {
  /** Antal kommandon per status (alla statusar finns, 0 om inga). */
  queueDepth: Record<CommandStatus, number>;
  deadCommands: number;
  /** Ålder i sekunder på det äldsta kommandot som väntar (pending/failed), 0 om kön är tom. */
  oldestPendingAgeSeconds: number;
  openExceptions: number;
  guardInDoubt: number;
  tenantsByMode: { dry_run: number; live: number };
}

const STATUSES: readonly CommandStatus[] = ['pending', 'in_progress', 'succeeded', 'failed', 'dead'];

export async function collectMetrics(db: Db, now: Date = new Date()): Promise<Metrics> {
  const queueDepth = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<CommandStatus, number>;
  for (const r of await db.query<{ status: CommandStatus; n: number }>(
    'select status, count(*)::int as n from ledger_command group by status',
  )) {
    if (r.status in queueDepth) queueDepth[r.status] = r.n;
  }

  const [oldest] = await db.query<{ oldest: Date | string | null }>(
    `select min(created_at) as oldest from ledger_command where status in ('pending', 'failed')`,
  );
  const oldestMs = oldest?.oldest ? new Date(oldest.oldest).getTime() : null;
  const oldestPendingAgeSeconds = oldestMs === null ? 0 : Math.max(0, Math.round((now.getTime() - oldestMs) / 1000));

  const [open] = await db.query<{ n: number }>(`select count(*)::int as n from reconcile_exception where status = 'open'`);
  const [doubt] = await db.query<{ n: number }>(`select count(*)::int as n from gateway_guard where state = 'started'`);

  const tenantsByMode = { dry_run: 0, live: 0 };
  for (const r of await db.query<{ mode: 'dry_run' | 'live'; n: number }>(
    'select mode, count(*)::int as n from tenant group by mode',
  )) {
    if (r.mode in tenantsByMode) tenantsByMode[r.mode] = r.n;
  }

  return {
    queueDepth,
    deadCommands: queueDepth.dead,
    oldestPendingAgeSeconds,
    openExceptions: open?.n ?? 0,
    guardInDoubt: doubt?.n ?? 0,
    tenantsByMode,
  };
}

const num = (n: number): string => (Number.isFinite(n) ? String(n) : '0');

/** Prometheus textformat (version 0.0.4). Ren funktion. */
export function renderPrometheus(m: Metrics): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, samples: Array<{ labels?: Record<string, string>; value: number }>): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const s of samples) {
      const labels = s.labels
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
            .join(',')}}`
        : '';
      lines.push(`${name}${labels} ${num(s.value)}`);
    }
  };
  gauge(
    'synk_queue_depth',
    'Antal kommandon i kon per status.',
    STATUSES.map((status) => ({ labels: { status }, value: m.queueDepth[status] ?? 0 })),
  );
  gauge('synk_dead_commands', 'Antal doda kommandon som vantar pa en manniska.', [{ value: m.deadCommands }]);
  gauge('synk_oldest_pending_command_age_seconds', 'Alder i sekunder pa det aldsta vantande kommandot.', [
    { value: m.oldestPendingAgeSeconds },
  ]);
  gauge('synk_open_exceptions', 'Antal oppna avvikelser totalt.', [{ value: m.openExceptions }]);
  gauge('synk_guard_in_doubt', 'Antal gateway-anrop med okant utfall.', [{ value: m.guardInDoubt }]);
  gauge('synk_tenants', 'Antal kunder per lage.', [
    { labels: { mode: 'dry_run' }, value: m.tenantsByMode.dry_run },
    { labels: { mode: 'live' }, value: m.tenantsByMode.live },
  ]);
  return `${lines.join('\n')}\n`;
}
