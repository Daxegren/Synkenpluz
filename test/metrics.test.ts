import { describe, expect, it } from 'vitest';
import { renderPrometheus, type Metrics } from '../src/db/metrics.js';

const m: Metrics = {
  queueDepth: { pending: 3, in_progress: 1, succeeded: 10, failed: 2, dead: 4 },
  deadCommands: 4,
  oldestPendingAgeSeconds: 42,
  openExceptions: 5,
  guardInDoubt: 1,
  tenantsByMode: { dry_run: 2, live: 7 },
};

describe('renderPrometheus (ren funktion)', () => {
  it('är deterministisk och har HELP/TYPE för varje serie', () => {
    const a = renderPrometheus(m);
    expect(renderPrometheus(m)).toBe(a);
    const names = [...a.matchAll(/^# TYPE (\S+) gauge$/gm)].map((x) => x[1]);
    expect(names).toEqual(['synk_queue_depth', 'synk_dead_commands', 'synk_oldest_pending_command_age_seconds', 'synk_open_exceptions', 'synk_guard_in_doubt', 'synk_tenants']);
    for (const n of names) expect(a).toContain(`# HELP ${n} `);
    expect(a).toContain('synk_queue_depth{status="in_progress"} 1');
    expect(a).toContain('synk_tenants{mode="dry_run"} 2');
  });

  it('icke-finita värden blir 0', () => {
    expect(renderPrometheus({ ...m, openExceptions: Number.NaN })).toContain('synk_open_exceptions 0');
  });
});
