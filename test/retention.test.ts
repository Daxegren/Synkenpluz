import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { createGatewayGuardStore } from '../src/db/gatewayGuard.js';
import {
  DEFAULT_RETENTION_POLICY,
  RetentionPolicyError,
  applyRetention,
  formatAge,
  keyFingerprint,
  parseInDoubtDecision,
  parseRetentionArgs,
  planRetention,
  resolveRetentionPolicy,
  summarizeProposal,
  type RetentionPolicy,
} from '../src/db/retention.js';
import type { StoredProposal } from '../src/ports/index.js';
import { createTestStack } from './helpers.js';

const DAY = 86_400_000;
const POLICY: RetentionPolicy = { succeededCommandsDays: 30, resolvedExceptionsDays: 30, proposalsDays: 30, guardDoneDays: 30 };

let db: Db;
let now: Date;
const ago = (days: number, extraMs = 0) => new Date(now.getTime() - days * DAY + extraMs);

beforeEach(async () => {
  const stack = await createTestStack();
  db = stack.db;
  now = stack.clock.now();
});

let seq = 0;
async function command(tenant: string, payout: string, status: string, at: Date, key = `k-${++seq}`) {
  await db.query(
    `insert into ledger_command (tenant_id, payout_id, seq, key, command, status, next_attempt_at, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $6, $6)`,
    [tenant, payout, ++seq, key, status, at],
  );
  return key;
}
async function payoutRow(tenant: string, payout: string, status: string, at: Date) {
  await db.query('insert into payout (tenant_id, payout_id, status, processed_at) values ($1, $2, $3, $4)', [tenant, payout, status, at]);
}
async function exception(tenant: string, payout: string, status: string, createdAt: Date, resolvedAt: Date | null, code = 'NO_MATCH') {
  await db.query(
    `insert into reconcile_exception (tenant_id, payout_id, code, line_id, message, status, created_at, resolved_at)
     values ($1, $2, $3, $4, 'm', $5, $6, $7)`,
    [tenant, payout, code, `l-${++seq}`, status, createdAt, resolvedAt],
  );
}
async function proposal(tenant: string, payout: string, at: Date) {
  await db.query(
    `insert into dry_run_proposal (tenant_id, payout_id, status, result, updated_at)
     values ($1, $2, 'complete', '{"status":"complete","commands":[],"exceptions":[]}'::jsonb, $3)`,
    [tenant, payout, at],
  );
}
async function guard(tenant: string, key: string, state: 'started' | 'done', at: Date) {
  await db.query(
    `insert into gateway_guard (tenant_id, key, state, external_id, started_at, completed_at) values ($1, $2, $3, $4, $5, $6)`,
    [tenant, key, state, state === 'done' ? 'ext' : null, at, state === 'done' ? at : null],
  );
}
const count = async (table: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]!.n;

/** En fullt klar, gammal utbetalning: complete + två lyckade kommandon. */
async function finishedPayout(tenant: string, payout: string, at: Date) {
  await payoutRow(tenant, payout, 'complete', at);
  await command(tenant, payout, 'succeeded', at);
  await command(tenant, payout, 'succeeded', at);
}

describe('policy', () => {
  it('har säkra defaults', () => {
    expect(resolveRetentionPolicy()).toEqual({ succeededCommandsDays: 400, resolvedExceptionsDays: 400, proposalsDays: 90, guardDoneDays: 400 });
    expect(DEFAULT_RETENTION_POLICY.succeededCommandsDays).toBeGreaterThanOrEqual(30);
  });

  it.each([0, -1, 29, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 40_000])('avvisar ogiltig bokföringstid %s', (bad) => {
    for (const key of ['succeededCommandsDays', 'resolvedExceptionsDays', 'guardDoneDays'] as const) {
      expect(() => resolveRetentionPolicy({ [key]: bad })).toThrow(RetentionPolicyError);
    }
  });

  it.each([0, -5, Number.NaN, 2.5])('avvisar ogiltig förslagstid %s', (bad) => {
    expect(() => resolveRetentionPolicy({ proposalsDays: bad })).toThrow(RetentionPolicyError);
  });

  it('plan och apply validerar också och rör ingenting vid fel', async () => {
    await finishedPayout('t1', 'p1', ago(500));
    const bad = { ...POLICY, succeededCommandsDays: 0 };
    await expect(planRetention(db, bad, now)).rejects.toThrow(RetentionPolicyError);
    await expect(applyRetention(db, bad, now)).rejects.toThrow(RetentionPolicyError);
    expect(await count('ledger_command')).toBe(2);
  });

  it('tolkar adminflaggor och avvisar felaktiga', () => {
    expect(parseRetentionArgs([])).toEqual({ policy: DEFAULT_RETENTION_POLICY, yes: false });
    const parsed = parseRetentionArgs(['--succeeded-days', '60', '--proposals-days', '7', '--yes']);
    expect(parsed.policy).toEqual({ ...DEFAULT_RETENTION_POLICY, succeededCommandsDays: 60, proposalsDays: 7 });
    expect(parsed.yes).toBe(true);
    expect(() => parseRetentionArgs(['--succeeded-days'])).toThrow(RetentionPolicyError);
    expect(() => parseRetentionArgs(['--succeeded-days', 'abc'])).toThrow(RetentionPolicyError);
    expect(() => parseRetentionArgs(['--succeeded-days', '-1'])).toThrow(RetentionPolicyError);
    expect(() => parseRetentionArgs(['--succeeded-days', '0'])).toThrow(RetentionPolicyError);
    expect(() => parseRetentionArgs(['--guard-days', '10'])).toThrow(RetentionPolicyError);
    expect(() => parseRetentionArgs(['--okand', '5'])).toThrow(RetentionPolicyError);
  });
});

describe('kommandon', () => {
  it('tar bort en helt klar och gammal utbetalning', async () => {
    await finishedPayout('t1', 'p1', ago(60));
    const result = await applyRetention(db, POLICY, now);
    expect(result.commands).toBe(2);
    expect(await count('ledger_command')).toBe(0);
    expect(await count('payout')).toBe(1);
  });

  it.each(['pending', 'failed', 'in_progress', 'dead'])('bevarar hela utbetalningen om ett kommando är %s', async (status) => {
    await payoutRow('t1', 'p1', 'complete', ago(60));
    await command('t1', 'p1', 'succeeded', ago(60));
    await command('t1', 'p1', status, ago(60));
    const result = await applyRetention(db, POLICY, now);
    expect(result.commands).toBe(0);
    expect(await count('ledger_command')).toBe(2);
  });

  it('bevarar kommandon som inte är lyckade även när de är mycket gamla', async () => {
    for (const status of ['pending', 'failed', 'in_progress', 'dead']) {
      await payoutRow('t1', `p-${status}`, 'complete', ago(900));
      await command('t1', `p-${status}`, status, ago(900));
    }
    expect((await applyRetention(db, POLICY, now)).commands).toBe(0);
    expect(await count('ledger_command')).toBe(4);
  });

  it('kräver att HELA utbetalningen är gammal (senaste kommandot avgör)', async () => {
    await payoutRow('t1', 'p1', 'complete', ago(90));
    await command('t1', 'p1', 'succeeded', ago(90));
    await command('t1', 'p1', 'succeeded', ago(5));
    expect((await applyRetention(db, POLICY, now)).commands).toBe(0);
  });

  it('bevarar utbetalningar som inte är complete, saknar payout-rad eller har öppen avvikelse', async () => {
    for (const status of ['partial', 'rejected']) {
      await payoutRow('t1', `p-${status}`, status, ago(90));
      await command('t1', `p-${status}`, 'succeeded', ago(90));
    }
    await command('t1', 'p-utan-rad', 'succeeded', ago(90));
    await payoutRow('t1', 'p-oppen', 'complete', ago(90));
    await command('t1', 'p-oppen', 'succeeded', ago(90));
    await exception('t1', 'p-oppen', 'open', ago(90), null);
    expect((await applyRetention(db, POLICY, now)).commands).toBe(0);
    expect(await count('ledger_command')).toBe(4);
  });

  it('bevarar utbetalning vars payout-rad är nyare än gränsen', async () => {
    await payoutRow('t1', 'p1', 'complete', ago(5));
    await command('t1', 'p1', 'succeeded', ago(90));
    expect((await applyRetention(db, POLICY, now)).commands).toBe(0);
  });

  it('respekterar gränsen exakt: precis innanför sparas, exakt på gränsen sparas, precis utanför tas bort', async () => {
    await finishedPayout('t1', 'inside', ago(30, 1));
    await finishedPayout('t1', 'edge', ago(30));
    await finishedPayout('t1', 'outside', ago(30, -1));
    const result = await applyRetention(db, POLICY, now);
    expect(result.commands).toBe(2);
    const left = await db.query<{ payout_id: string }>('select distinct payout_id from ledger_command order by 1');
    expect(left.map((r) => r.payout_id)).toEqual(['edge', 'inside']);
  });
});

describe('avvikelser, förslag och gateway-poster', () => {
  it('tar bara bort avslutade avvikelser och aldrig öppna', async () => {
    await exception('t1', 'p', 'open', ago(900), null, 'A');
    await exception('t1', 'p', 'resolved', ago(900), ago(800), 'B');
    await exception('t1', 'p', 'dismissed', ago(900), ago(800), 'C');
    await exception('t1', 'p', 'resolved', ago(900), ago(5), 'D');
    const result = await applyRetention(db, POLICY, now);
    expect(result.exceptions).toBe(2);
    const left = await db.query<{ code: string }>('select code from reconcile_exception order by code');
    expect(left.map((r) => r.code)).toEqual(['A', 'D']);
  });

  it('gränsen för avvikelser räknas från resolved_at, exakt', async () => {
    await exception('t1', 'p', 'resolved', ago(900), ago(30, 1), 'IN');
    await exception('t1', 'p', 'resolved', ago(900), ago(30), 'EDGE');
    await exception('t1', 'p', 'resolved', ago(900), ago(30, -1), 'OUT');
    expect((await applyRetention(db, POLICY, now)).exceptions).toBe(1);
    const left = await db.query<{ code: string }>('select code from reconcile_exception order by code');
    expect(left.map((r) => r.code)).toEqual(['EDGE', 'IN']);
  });

  it('tar bort förslag äldre än gränsen, exakt', async () => {
    await proposal('t1', 'in', ago(30, 1));
    await proposal('t1', 'edge', ago(30));
    await proposal('t1', 'out', ago(30, -1));
    expect((await applyRetention(db, POLICY, now)).proposals).toBe(1);
    const left = await db.query<{ payout_id: string }>('select payout_id from dry_run_proposal order by 1');
    expect(left.map((r) => r.payout_id)).toEqual(['edge', 'in']);
  });

  it("tar bara bort 'done'-poster och aldrig 'started'", async () => {
    await guard('t1', 'old-started', 'started', ago(900));
    await guard('t1', 'old-done', 'done', ago(900));
    await guard('t1', 'new-done', 'done', ago(5));
    await guard('t1', 'edge-done', 'done', ago(30));
    await guard('t1', 'out-done', 'done', ago(30, -1));
    const result = await applyRetention(db, POLICY, now);
    expect(result.guards).toBe(2);
    const left = await db.query<{ key: string }>('select key from gateway_guard order by key');
    expect(left.map((r) => r.key)).toEqual(['edge-done', 'new-done', 'old-started']);
    const inDoubt = await createGatewayGuardStore(db).listInDoubt();
    expect(inDoubt.map((r) => r.key)).toEqual(['old-started']);
  });

  it("bevarar 'done'-post vars kommando inte är lyckat", async () => {
    await command('t1', 'p1', 'pending', ago(900), 'kp');
    await guard('t1', 'kp', 'done', ago(900));
    await command('t1', 'p2', 'succeeded', ago(900), 'ks');
    await guard('t1', 'ks', 'done', ago(900));
    expect((await applyRetention(db, POLICY, now)).guards).toBe(1);
    const left = await db.query<{ key: string }>('select key from gateway_guard');
    expect(left.map((r) => r.key)).toEqual(['kp']);
  });
});

describe('audit_log, payout, torrkörning, idempotens, isolering', () => {
  async function seedEverything() {
    await finishedPayout('t1', 'p1', ago(100));
    await finishedPayout('t2', 'p2', ago(100));
    await payoutRow('t1', 'p-dead', 'complete', ago(100));
    await command('t1', 'p-dead', 'dead', ago(100));
    await exception('t1', 'p1', 'resolved', ago(200), ago(100));
    await exception('t1', 'p-dead', 'open', ago(200), null);
    await proposal('t2', 'p2', ago(100));
    await guard('t1', 'g-done', 'done', ago(100));
    await guard('t1', 'g-started', 'started', ago(100));
    await db.query(`insert into audit_log (tenant_id, at, actor, action, details) values ('t1', $1, 'x', 'old.entry', '{}'::jsonb)`, [ago(2000)]);
  }

  it('rör aldrig audit_log (utom nya poster) eller payout-rader, och triggern står kvar', async () => {
    await seedEverything();
    const auditBefore = await count('audit_log');
    const payoutsBefore = await count('payout');
    await applyRetention(db, POLICY, now);
    expect(await count('payout')).toBe(payoutsBefore);
    const old = await db.query(`select 1 from audit_log where action = 'old.entry'`);
    expect(old).toHaveLength(1);
    expect(await count('audit_log')).toBe(auditBefore + 2);
    await expect(db.query('delete from audit_log')).rejects.toThrow();
  });

  it('bevarar öppna avvikelser, döda kommandon och started-poster', async () => {
    await seedEverything();
    await applyRetention(db, POLICY, now);
    expect(await db.query(`select 1 from reconcile_exception where status = 'open'`)).toHaveLength(1);
    expect(await db.query(`select 1 from ledger_command where status = 'dead'`)).toHaveLength(1);
    expect(await db.query(`select 1 from gateway_guard where state = 'started'`)).toHaveLength(1);
  });

  it('torrkörning ändrar inget och räknar exakt som riktig körning', async () => {
    await seedEverything();
    const tables = ['ledger_command', 'reconcile_exception', 'dry_run_proposal', 'gateway_guard', 'audit_log', 'payout'];
    const before = await Promise.all(tables.map(count));
    const plan = await planRetention(db, POLICY, now);
    expect(await Promise.all(tables.map(count))).toEqual(before);
    const applied = await applyRetention(db, POLICY, now);
    expect(applied).toEqual(plan);
    expect(plan).toMatchObject({ commands: 4, exceptions: 1, proposals: 1, guards: 1 });
  });

  it('är idempotent: andra körningen tar bort 0 och skriver inga fler poster', async () => {
    await seedEverything();
    await applyRetention(db, POLICY, now);
    const audit = await count('audit_log');
    const second = await applyRetention(db, POLICY, now);
    expect(second).toEqual({ commands: 0, exceptions: 0, proposals: 0, guards: 0, byTenant: {} });
    expect(await count('audit_log')).toBe(audit);
  });

  it('skriver en revisionspost per berörd kund med bara antal och policy', async () => {
    await seedEverything();
    await db.query(`insert into audit_log (tenant_id, at, actor, action, details) values ('t3', $1, 'x', 'noop', '{}'::jsonb)`, [now]);
    await finishedPayout('t3', 'fresh', ago(1));
    await applyRetention(db, POLICY, now, 'admin-cli');
    const rows = await db.query<{ tenant_id: string; actor: string; details: Record<string, unknown> }>(
      `select tenant_id, actor, details from audit_log where action = 'retention.applied' order by tenant_id`,
    );
    expect(rows.map((r) => r.tenant_id)).toEqual(['t1', 't2']);
    expect(rows[0]!.actor).toBe('admin-cli');
    expect(rows[0]!.details).toEqual({
      removed: { commands: 2, exceptions: 1, proposals: 0, guards: 1 },
      policy: POLICY,
    });
    expect(rows[1]!.details).toEqual({
      removed: { commands: 2, exceptions: 0, proposals: 1, guards: 0 },
      policy: POLICY,
    });
    // Inga id eller nycklar i posten.
    const text = JSON.stringify(rows);
    for (const secret of ['p1', 'p2', 'g-done', 'NO_MATCH']) expect(text).not.toContain(secret);
  });

  it('isolerar kunder: en kunds data gallras efter dess egna rader och räknas per kund', async () => {
    await finishedPayout('t1', 'same', ago(100));
    await payoutRow('t2', 'same', 'complete', ago(100));
    await command('t2', 'same', 'pending', ago(100));
    const result = await applyRetention(db, POLICY, now);
    expect(result.byTenant).toEqual({ t1: { commands: 2, exceptions: 0, proposals: 0, guards: 0 } });
    expect(await db.query(`select 1 from ledger_command where tenant_id = 't2'`)).toHaveLength(1);
  });

  it('en öppen avvikelse hos en annan kund med samma utbetalnings-id blockerar inte', async () => {
    await finishedPayout('t1', 'same', ago(100));
    await exception('t2', 'same', 'open', ago(100), null);
    expect((await applyRetention(db, POLICY, now)).commands).toBe(2);
  });
});

describe('adminhjälpare', () => {
  it('tolkar avgörande av osäkert anrop', () => {
    expect(parseInDoubtDecision('applied', 'ext-1')).toEqual({ applied: true, externalId: 'ext-1' });
    expect(parseInDoubtDecision('not-applied', undefined)).toEqual({ applied: false });
    expect(() => parseInDoubtDecision('applied', undefined)).toThrow(/externalId/);
    expect(() => parseInDoubtDecision('applied', '  ')).toThrow(/externalId/);
    expect(() => parseInDoubtDecision('not-applied', 'x')).toThrow();
    expect(() => parseInDoubtDecision('kanske', undefined)).toThrow();
    expect(() => parseInDoubtDecision(undefined, undefined)).toThrow();
  });

  it('avgör osäkert anrop via guard-lagret', async () => {
    await guard('t1', 'k1', 'started', ago(1));
    await guard('t1', 'k2', 'started', ago(1));
    const store = createGatewayGuardStore(db);
    expect(await store.resolve('t1', 'k1', { applied: true, externalId: 'e' }, now)).toBe(true);
    expect(await store.resolve('t1', 'k2', { applied: false }, now)).toBe(true);
    expect(await store.resolve('t1', 'k1', { applied: false }, now)).toBe(false);
    expect(await store.listInDoubt()).toEqual([]);
  });

  it('formaterar ålder och nyckelmarkör', () => {
    expect(formatAge(5 * 60_000)).toBe('5 min');
    expect(formatAge(5 * 3_600_000)).toBe('5 h');
    expect(formatAge(5 * DAY)).toBe('5 dygn');
    expect(formatAge(-1000)).toBe('0 min');
    expect(keyFingerprint('abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(keyFingerprint('abc')).not.toContain('abc');
  });

  it('sammanfattar förslag utan belopp eller texter', () => {
    const proposal: StoredProposal = {
      tenantId: 't1',
      payoutId: 'p1',
      status: 'partial',
      updatedAt: now,
      result: {
        status: 'partial',
        commands: [{ kind: 'register_invoice_payment', key: 'k', amount: 99999 } as never],
        exceptions: [
          { code: 'NO_MATCH', message: 'hemlig text 12345' },
          { code: 'NO_MATCH', message: 'x' },
          { code: 'AMOUNT_MISMATCH', message: 'y' },
        ] as never,
      },
    };
    const summary = summarizeProposal(proposal);
    expect(summary).toEqual({ payoutId: 'p1', status: 'partial', commands: 1, exceptionCodes: ['AMOUNT_MISMATCH', 'NO_MATCHx2'], updatedAt: now });
    const text = JSON.stringify(summary);
    expect(text).not.toContain('99999');
    expect(text).not.toContain('hemlig');
  });
});
