import { describe, expect, it } from 'vitest';
import { drain } from '../src/executor/executor.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

async function setup() {
  const stack = await createTestStack();
  const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A'), makeInvoice('B')] });
  const run = (payoutId: string, refs: string[], mode: 'live' | 'dry_run', tenantId = 'T1') =>
    processPayout(
      { uow: stack.uow, clock: stack.clock },
      {
        tenantId,
        payout: makePayout(payoutId, refs.map((r, i) => payment(`L${i}`, r, 12500))),
        invoices: [makeInvoice('A'), makeInvoice('B')],
        accounts,
      },
      { mode },
    );
  return { ...stack, ledger, run };
}

describe('sparade dry_run-förslag', () => {
  it('sparas per utbetalning och innehåller kommandon och avvikelser som skulle skapats', async () => {
    const { run, repos, ledger, clock } = await setup();
    await run('P1', ['REF-A', 'REF-SAKNAS'], 'dry_run');

    const [proposal] = await repos.proposals.list('T1');
    expect(proposal).toMatchObject({ tenantId: 'T1', payoutId: 'P1', status: 'partial' });
    expect(proposal?.result.commands.map((c) => c.kind)).toEqual(['register_invoice_payment']);
    expect(proposal?.result.exceptions.map((e) => e.code)).toEqual(['NO_MATCH']);

    // Och ingenting annat har hänt.
    expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
    expect(await repos.exceptions.list('T1')).toEqual([]);
    expect(await repos.payouts.get('T1', 'P1')).toBeNull();
    expect(await repos.audit.list('T1')).toEqual([]);
    await drain({ commands: repos.commands, gateway: ledger, clock });
    expect(ledger.calls).toBe(0);
  });

  it('ett oförändrat förslag rörs inte vid omkörning, ett ändrat ersätts', async () => {
    const { run, repos, clock } = await setup();
    await run('P1', ['REF-A'], 'dry_run');
    const first = (await repos.proposals.get('T1', 'P1'))!;

    clock.advance(60_000);
    await run('P1', ['REF-A'], 'dry_run');
    expect((await repos.proposals.get('T1', 'P1'))?.updatedAt).toEqual(first.updatedAt);

    clock.advance(60_000);
    await run('P1', ['REF-A', 'REF-B'], 'dry_run');
    const changed = (await repos.proposals.get('T1', 'P1'))!;
    expect(changed.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(changed.result.commands.filter((c) => c.kind === 'register_invoice_payment')).toHaveLength(2);
    expect(await repos.proposals.list('T1')).toHaveLength(1);
  });

  it('försvinner när utbetalningen bokförs på riktigt', async () => {
    const { run, repos } = await setup();
    await run('P1', ['REF-A'], 'dry_run');
    expect(await repos.proposals.list('T1')).toHaveLength(1);

    await run('P1', ['REF-A'], 'live');
    expect(await repos.proposals.list('T1')).toEqual([]);
    expect(await repos.commands.listByPayout('T1', 'P1')).toHaveLength(2);
  });

  it('filtrerar på status och isolerar kunder', async () => {
    const { run, repos } = await setup();
    await run('P1', ['REF-A'], 'dry_run');
    await run('P2', ['REF-SAKNAS'], 'dry_run');
    await run('P3', ['REF-B'], 'dry_run', 'T2');

    expect((await repos.proposals.list('T1', { status: 'partial' })).map((p) => p.payoutId)).toEqual(['P2']);
    expect((await repos.proposals.list('T1', { status: 'complete' })).map((p) => p.payoutId)).toEqual(['P1']);
    expect(await repos.proposals.get('T1', 'P3')).toBeNull();
    expect((await repos.proposals.list('T2')).map((p) => p.payoutId)).toEqual(['P3']);
    expect(await repos.proposals.delete('T1', 'P3')).toBe(false);
  });
});
