import { describe, expect, it } from 'vitest';
import { drain } from '../src/executor/executor.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource, MemorySyncState, MemoryTenantConfig } from '../src/gateways/fakeSource.js';
import { syncTenant, type SyncDeps } from '../src/service/syncTenant.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

async function setup(mode: 'live' | 'dry_run' = 'live') {
  const stack = await createTestStack();
  const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A'), makeInvoice('B')] });
  const source = new FakePayoutSource();
  const state = new MemorySyncState();
  const deps: SyncDeps = {
    uow: stack.uow,
    clock: stack.clock,
    source,
    invoices: ledger,
    config: new MemoryTenantConfig({ T1: { accounts, mode } }),
    state,
  };
  const execDeps = { commands: stack.repos.commands, gateway: ledger, clock: stack.clock };
  return { ...stack, ledger, source, state, deps, execDeps };
}

describe('syncTenant', () => {
  it('hämtar nya utbetalningar, avstämmer och flyttar fram cursorn', async () => {
    const { deps, source, state, ledger, execDeps, repos } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    source.add(makePayout('P2', [payment('L1', 'REF-B', 12500)]));

    const summary = await syncTenant(deps, 'T1');
    expect(summary).toMatchObject({ fetched: 2, complete: 2, partial: 0, rejected: 0, failed: [] });
    expect(await state.getCursor('T1')).toBe('2');

    await drain(execDeps);
    expect(ledger.invoice('A')?.status).toBe('paid');
    expect(ledger.invoice('B')?.status).toBe('paid');
    expect((await repos.payouts.list('T1', { status: 'complete' })).map((p) => p.payoutId)).toEqual(['P1', 'P2']);

    // Nästa körning utan nya utbetalningar gör ingenting.
    const next = await syncTenant(deps, 'T1');
    expect(next).toMatchObject({ fetched: 0, resumed: 0, failed: [] });
  });

  it('återupptar en delvis avstämd utbetalning när fakturan dyker upp', async () => {
    const { deps, source, ledger, execDeps, repos } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500), payment('L2', 'REF-C', 12500)]));

    const first = await syncTenant(deps, 'T1');
    expect(first).toMatchObject({ fetched: 1, partial: 1 });
    await drain(execDeps);
    expect(ledger.vouchers).toHaveLength(0);

    // Fakturan för REF-C skapas i affärssystemet efteråt.
    ledger.addInvoice(makeInvoice('C'));
    const second = await syncTenant(deps, 'T1');
    expect(second).toMatchObject({ fetched: 0, resumed: 1, complete: 1 });
    await drain(execDeps);

    expect(ledger.invoice('C')?.status).toBe('paid');
    expect(ledger.vouchers).toHaveLength(1);
    expect(await repos.exceptions.list('T1', { status: 'open' })).toEqual([]);
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
  });

  it('ett fel på en utbetalning stoppar inte de andra och cursorn står kvar', async () => {
    const { deps, source, state, repos } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    source.add(makePayout('P2', [payment('L1', 'REF-B', 12500)]));

    // Läsningen av fakturor för första utbetalningen fallerar tillfälligt.
    let calls = 0;
    const flaky: SyncDeps = {
      ...deps,
      invoices: {
        findByReferences: async (tenantId, refs) => {
          if (++calls === 1) throw new Error('tillfälligt avbrott hos affärssystemet');
          return deps.invoices.findByReferences(tenantId, refs);
        },
      },
    };

    const summary = await syncTenant(flaky, 'T1');
    expect(summary.failed).toEqual([{ payoutId: 'P1', error: 'tillfälligt avbrott hos affärssystemet' }]);
    expect(summary.complete).toBe(1); // P2 gick igenom
    expect(await state.getCursor('T1')).toBeNull(); // hämtas om nästa gång

    const retry = await syncTenant(flaky, 'T1');
    expect(retry.failed).toEqual([]);
    expect(retry.fetched).toBe(2);
    expect((await repos.payouts.list('T1', { status: 'complete' })).map((p) => p.payoutId)).toEqual(['P1', 'P2']);
    expect(await state.getCursor('T1')).toBe('2');
  });

  it('dry_run sparar inget men rapporterar vad som skulle hända', async () => {
    const { deps, source, repos } = await setup('dry_run');
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));

    const summary = await syncTenant(deps, 'T1');
    expect(summary).toMatchObject({ mode: 'dry_run', fetched: 1, complete: 1 });
    expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
    expect(await repos.payouts.list('T1')).toEqual([]);
  });

  it('kastar för okänd kund och sprider fel från leverantören', async () => {
    const { deps, source } = await setup();
    await expect(syncTenant(deps, 'OKÄND')).rejects.toThrow('Okänd kund');

    source.failListing = new Error('leverantören är nere');
    await expect(syncTenant(deps, 'T1')).rejects.toThrow('leverantören är nere');
  });

  it('avvisade utbetalningar räknas och köar ingenting', async () => {
    const { deps, source, repos } = await setup();
    source.add({ ...makePayout('P1', [payment('L1', 'REF-A', 12500)]), netAmount: 5 });

    const summary = await syncTenant(deps, 'T1');
    expect(summary).toMatchObject({ rejected: 1, complete: 0 });
    expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
  });
});

describe('syncTenant: dry_run och cursor', () => {
  it('flyttar inte fram cursorn i dry_run, så utbetalningarna bokförs när kunden går live', async () => {
    const stack = await setup('dry_run');
    stack.source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));

    await syncTenant(stack.deps, 'T1');
    expect(await stack.state.getCursor('T1')).toBeNull();

    // Kunden går live: samma utbetalning hämtas på nytt och köas på riktigt.
    const live: SyncDeps = { ...stack.deps, config: new MemoryTenantConfig({ T1: { accounts, mode: 'live' } }) };
    const summary = await syncTenant(live, 'T1');
    expect(summary).toMatchObject({ fetched: 1, complete: 1 });
    expect(await stack.repos.commands.listByPayout('T1', 'P1')).toHaveLength(2);
  });
});

describe('revisionslogg vid återupptagning', () => {
  it('loggar inte när en omkörning inte ändrar något', async () => {
    const { deps, source, repos } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500), payment('L2', 'REF-SAKNAS', 12500)]));

    await syncTenant(deps, 'T1'); // partial: loggas
    await syncTenant(deps, 'T1'); // återupptas utan förändring: loggas inte
    await syncTenant(deps, 'T1');
    const processed = (await repos.audit.list('T1')).filter((a) => a.action === 'payout.processed');
    expect(processed).toHaveLength(1);
  });
});
