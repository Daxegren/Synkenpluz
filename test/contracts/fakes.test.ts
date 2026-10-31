import { describe } from 'vitest';
import type { Invoice, LedgerCommand, Payout } from '../../src/domain/types.js';
import { FakeLedgerGateway } from '../../src/gateways/fake.js';
import { MemoryGatewayGuardStore } from '../../src/gateways/fakeGuard.js';
import { FakePayoutSource } from '../../src/gateways/fakeSource.js';
import { GuardedLedgerGateway } from '../../src/gateways/guarded.js';
import { LedgerError, type LedgerGateway } from '../../src/ports/index.js';
import { TestClock, makeInvoice, makePayout, payment } from '../helpers.js';
import { FakeLedgerProvider } from '../../src/gateways/fakeProvider.js';
import { invoiceReaderContract, ledgerGatewayContract, ledgerProviderContract, payoutSourceContract } from './ports.contract.js';

/** De simulerade implementationerna måste själva klara kontrakten, annars bevisar sviterna ingenting. */

const payouts = (): Payout[] => [
  makePayout('P1', [payment('L1', 'REF-A', 12500, { net: 200, vat: 50 })]),
  makePayout('P2', [payment('L1', 'REF-B', 12500)]),
  makePayout('P3', [payment('L1', 'REF-C', 5000)]),
];
const invoices = (): Invoice[] => [makeInvoice('A'), makeInvoice('B'), makeInvoice('C')];

payoutSourceContract(
  'FakePayoutSource',
  async () => {
    const source = new FakePayoutSource();
    return { source, seed: async (tenantId, list) => list.forEach((p) => source.add(p, tenantId)) };
  },
  payouts,
);

invoiceReaderContract(
  'FakeLedgerGateway (läsning)',
  async () => {
    const ledgers = new Map<string, FakeLedgerGateway>();
    const get = (t: string) => ledgers.get(t) ?? ledgers.set(t, new FakeLedgerGateway()).get(t)!;
    return {
      reader: {
        findByReferences: (t, refs) => get(t).findByReferences(t, refs),
      },
      seed: async (t, list) => list.forEach((i) => get(t).addInvoice(i)),
      update: async (t, id, patch) => get(t).addInvoice({ ...get(t).invoice(id)!, ...patch }),
    };
  },
  invoices,
);

/** Fakturan som kommandot betalar: öppen och med exakt belopp. */
const invoiceFor = (command: LedgerCommand): Invoice =>
  makeInvoice((command as { invoiceId: string }).invoiceId, { reference: `REF-${command.key}` });

ledgerGatewayContract('FakeLedgerGateway', async () => {
  const ledgers = new Map<string, FakeLedgerGateway>();
  const get = (t: string) => ledgers.get(t) ?? ledgers.set(t, new FakeLedgerGateway()).get(t)!;
  return {
    gateway: { execute: (t, c) => get(t).execute(t, c) },
    prepare: async (t, c) => get(t).addInvoice(invoiceFor(c)),
    appliedCount: (t, key) => get(t).executed.filter((e) => e.command.key === key).length,
    invalidCommand: () => ({
      kind: 'register_invoice_payment',
      key: 'ogiltig',
      lineId: 'ogiltig',
      invoiceId: 'FINNS-INTE',
      amount: 1,
      currency: 'SEK',
      date: '2026-10-28',
    }),
  };
});

/**
 * Ett affärssystem UTAN egen idempotens, bakom skyddsgatewayen. Kontraktet bevisar att skyddet
 * ensamt ger idempotens, vilket är hela poängen: en riktig adapter behöver inte kunna det själv.
 */
describe('GuardedLedgerGateway över ett naivt affärssystem', () => {
  class Naive implements LedgerGateway {
    applied: Array<{ tenantId: string; key: string }> = [];
    async execute(tenantId: string, command: LedgerCommand) {
      if (command.key === 'ogiltig') throw new LedgerError('avvisad', false, undefined, true);
      this.applied.push({ tenantId, key: command.key });
      return { externalId: `EXT-${this.applied.length}` };
    }
  }
  ledgerGatewayContract('Guarded(Naive)', async () => {
    const naive = new Naive();
    const gateway = new GuardedLedgerGateway(naive, new MemoryGatewayGuardStore(), { clock: new TestClock() });
    return {
      gateway,
      prepare: async () => {},
      appliedCount: (t, key) => naive.applied.filter((a) => a.tenantId === t && a.key === key).length,
      invalidCommand: () => ({
        kind: 'register_invoice_payment',
        key: 'ogiltig',
        lineId: 'ogiltig',
        invoiceId: 'X',
        amount: 1,
        currency: 'SEK',
        date: '2026-10-28',
      }),
    };
  });
});

/** Fakeleverantören får bara lov att bryta kundens anslutning per kund, som en riktig adapter skulle. */
class PerTenantProvider extends FakeLedgerProvider {
  broken = new Set<string>();
  override async checkConnection(tenantId: string) {
    return this.broken.has(tenantId) ? { ok: false, problems: ['Token har gått ut'] } : super.checkConnection(tenantId);
  }
}

ledgerProviderContract('FakeLedgerProvider', async () => {
  const provider = new PerTenantProvider('fortnox');
  return { provider, breakConnection: async (t) => void provider.broken.add(t), secret: 'HEMLIG-TOKEN' };
});
