import { describe, expect, it } from 'vitest';
import { runCycle } from '../src/app/cycle.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource, MemorySyncState, MemoryTenantConfig } from '../src/gateways/fakeSource.js';
import { LedgerError } from '../src/ports/index.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

async function setup() {
  const stack = await createTestStack();
  const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A'), makeInvoice('B')] });
  const source = new FakePayoutSource();
  const deps = {
    executor: { commands: stack.repos.commands, gateway: ledger, clock: stack.clock },
    sync: {
      uow: stack.uow,
      clock: stack.clock,
      source,
      invoices: ledger,
      config: new MemoryTenantConfig({ T1: { accounts, mode: 'live' as const }, T2: { accounts, mode: 'live' as const } }),
      state: new MemorySyncState(),
    },
    listTenants: async () => ['T1'],
  };
  return { ...stack, ledger, source, deps };
}

describe('runCycle', () => {
  it('synkar och bokför i en och samma cykel', async () => {
    const { deps, source, ledger } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));

    const report = await runCycle(deps);
    expect(report.alerts).toEqual([]);
    expect(report.execution).toMatchObject({ succeeded: 2, dead: 0 });
    expect(ledger.invoice('A')?.status).toBe('paid');
  });

  it('ett fel för en kund stoppar inte nästa kund och ger varning', async () => {
    const { deps, source } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    const broken = { ...deps, listTenants: async () => ['OKÄND', 'T1'] };

    const report = await runCycle(broken);
    expect(report.tenants[0]).toMatchObject({ tenantId: 'OKÄND', error: expect.stringContaining('Okänd kund') });
    expect(report.tenants[1]?.summary?.complete).toBe(1);
    expect(report.alerts.map((a) => a.severity)).toEqual(['warning']);
  });

  it('permanent misslyckade kommandon ger kritiskt larm', async () => {
    const { deps, source, ledger } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    ledger.failNext(new LedgerError('faktura spärrad', false, undefined, true));

    const report = await runCycle(deps);
    expect(report.execution.dead).toBe(1);
    expect(report.alerts).toContainEqual(expect.objectContaining({ severity: 'critical' }));
  });

  it('avvisade utbetalningar ger varning med kund', async () => {
    const { deps, source } = await setup();
    source.add({ ...makePayout('P1', [payment('L1', 'REF-A', 12500)]), netAmount: 1 });
    const report = await runCycle(deps);
    expect(report.alerts).toEqual([expect.objectContaining({ severity: 'warning', tenantId: 'T1' })]);
  });

  it('släpper fastnade kommandon och slutför dem', async () => {
    const { deps, source, ledger, repos, clock } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));

    // Första cykeln köar. Sedan "kraschar" en arbetare efter att ha låst första kommandot.
    await runCycle({ ...deps, executor: { ...deps.executor, gateway: { execute: async () => { throw new Error('x'); } } } });
    await repos.commands.claimDue(new Date(clock.now().getTime() + 3_600_000), 10);
    clock.advance(3_600_000 + 31 * 60_000);

    const report = await runCycle(deps);
    expect(report.recovered).toBe(1);
    expect(report.execution.succeeded).toBe(2);
    expect(ledger.invoice('A')?.status).toBe('paid');
  });
});
