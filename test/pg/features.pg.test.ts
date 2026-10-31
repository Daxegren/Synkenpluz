import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayGuardStore } from '../../src/db/gatewayGuard.js';
import { collectMetrics, renderPrometheus } from '../../src/db/metrics.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { applyRetention, planRetention, resolveRetentionPolicy } from '../../src/db/retention.js';
import type { LedgerCommand } from '../../src/domain/types.js';
import { GuardedLedgerGateway } from '../../src/gateways/guarded.js';
import { LedgerError, type LedgerGateway } from '../../src/ports/index.js';
import { processPayout } from '../../src/service/processPayout.js';
import { TestClock, accounts, makeInvoice, makePayout, payment } from '../helpers.js';
import type { DbHandle } from './contract.js';
import { createSchemaDb, PG_URL } from './support.js';

/**
 * Funktioner vars SQL annars bara körts mot PGlite: gallring (CTE-delete, bool_and), mätvärden,
 * sparade förslag och skyddsgatewayens journal. Körs bara med PG_TEST_URL (riktig Postgres).
 */
describe.skipIf(!PG_URL)('Postgres: gallring, mätvärden, förslag och skyddsgateway', () => {
  const open: DbHandle[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });
  async function setup() {
    const handle = await createSchemaDb();
    open.push(handle);
    await migrate(handle.db);
    const repos = createRepositories(handle.db);
    return { ...handle, repos, clock: new TestClock() };
  }
  const pay = (key: string): LedgerCommand => ({
    kind: 'register_invoice_payment',
    key,
    lineId: key,
    invoiceId: 'A',
    amount: 12500,
    currency: 'SEK',
    date: '2026-10-28',
  });

  it('gallring: tar bara bort klara gamla utbetalningar, och torrkörning räknar samma', async () => {
    const { db, repos, clock } = await setup();
    const old = new Date(clock.now().getTime() - 500 * 86_400_000);

    // Klar och gammal utbetalning: ska gallras.
    await repos.commands.enqueue('T1', 'GAMMAL', [pay('g1')], old);
    const [g1] = await repos.commands.claimDue(old, 10);
    await repos.commands.markSucceeded(g1!.id, 'EXT-1', old, g1!.attempts);
    await repos.payouts.record({ tenantId: 'T1', payoutId: 'GAMMAL', status: 'complete', processedAt: old });

    // Gammal men med dött kommando: ska bevaras.
    await repos.commands.enqueue('T1', 'DOD', [pay('d1')], old);
    const [d1] = await repos.commands.claimDue(old, 10);
    await repos.commands.markFailed(d1!.id, 'permanent', null, old, d1!.attempts);
    await repos.payouts.record({ tenantId: 'T1', payoutId: 'DOD', status: 'partial', processedAt: old });

    const policy = resolveRetentionPolicy({});
    const plan = await planRetention(db, policy, clock.now());
    expect(plan.commands).toBe(1);
    const applied = await applyRetention(db, policy, clock.now());
    expect({ commands: applied.commands, exceptions: applied.exceptions, proposals: applied.proposals, guards: applied.guards }).toEqual({
      commands: plan.commands,
      exceptions: plan.exceptions,
      proposals: plan.proposals,
      guards: plan.guards,
    });

    expect(await repos.commands.listByPayout('T1', 'GAMMAL')).toEqual([]);
    expect(await repos.commands.listByPayout('T1', 'DOD')).toHaveLength(1);
    expect((await repos.payouts.get('T1', 'GAMMAL'))?.status).toBe('complete'); // payout-raden rörs aldrig
    expect((await applyRetention(db, policy, clock.now())).commands).toBe(0); // idempotent
    expect(await repos.audit.list('T1')).not.toEqual([]); // revisionsloggen finns kvar
  });

  it('mätvärden: köns djup, döda och osäkra anrop utan kund-id i resultatet', async () => {
    const { db, repos, clock } = await setup();
    await repos.commands.enqueue('KUND-HEMLIG', 'P1', [pay('a'), pay('b')], clock.now());
    await repos.guard.begin('KUND-HEMLIG', 'x', clock.now());

    const text = renderPrometheus(await collectMetrics(db, clock.now()));
    expect(text).toContain('# TYPE');
    expect(text).not.toContain('KUND-HEMLIG');
    expect(text).toMatch(/pending[^\n]*2/);
  });

  it('sparade förslag: upsert, oförändrat rörs inte, borttagning', async () => {
    const { repos, clock } = await setup();
    const run = (refs: string[]) =>
      processPayout(
        { uow: { run: (fn) => fn(repos) }, clock },
        {
          tenantId: 'T1',
          payout: makePayout('P1', refs.map((r, i) => payment(`L${i}`, r, 12500))),
          invoices: [makeInvoice('A')],
          accounts,
        },
        { mode: 'dry_run' },
      );
    await run(['REF-A']);
    const first = (await repos.proposals.get('T1', 'P1'))!;
    clock.advance(60_000);
    await run(['REF-A']);
    expect((await repos.proposals.get('T1', 'P1'))?.updatedAt).toEqual(first.updatedAt);
    expect(await repos.proposals.delete('T1', 'P1')).toBe(true);
  });

  it('skyddsgateway: förlorat svar skickas aldrig om, två samtidiga anrop bokför en gång', async () => {
    const { db, clock } = await setup();
    const applied: string[] = [];
    let lose = false;
    const naive: LedgerGateway = {
      async execute(_t, c) {
        applied.push(c.key);
        await new Promise((r) => setTimeout(r, 20));
        if (lose) throw new LedgerError('bröts', true, undefined, false);
        return { externalId: `EXT-${applied.length}` };
      },
    };
    const guarded = new GuardedLedgerGateway(naive, createGatewayGuardStore(db), { clock });

    const both = await Promise.allSettled([guarded.execute('T1', pay('s1')), guarded.execute('T1', pay('s1'))]);
    // Det som ska gälla är att bokföringen sker exakt en gång. Om det andra anropet hann starta först efter att
    // det första blivit klart returnerar det det sparade resultatet (lyckas), annars avvisas det som pågående.
    // Vilket av de två som händer beror på hur snabbt anslutningarna är, så båda godtas.
    const fulfilled = both.flatMap((r) => (r.status === 'fulfilled' ? [r.value.externalId] : []));
    const rejected = both.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fulfilled).size).toBe(1);
    for (const reason of rejected) expect(reason).toMatchObject({ retryable: true });
    expect(applied).toEqual(['s1']);

    lose = true;
    await guarded.execute('T1', pay('s2')).catch(() => undefined);
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', pay('s2'))).rejects.toMatchObject({ retryable: false });
    expect(applied).toEqual(['s1', 's2']);
    expect(await createGatewayGuardStore(db).listInDoubt('T1')).toHaveLength(1);
  });
});
