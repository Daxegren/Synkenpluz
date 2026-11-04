import type { App } from '../app/compose.js';
import { createConnectionRepository } from '../db/connections.js';
import type { Db } from '../db/db.js';
import { createUnitOfWork } from '../db/repositories.js';
import { setTenantAccounts } from '../db/syncState.js';
import type { AccountMapping, Invoice, Payout, PayoutLine } from '../domain/types.js';
import { drain } from '../executor/executor.js';
import type { FakeLedgerGateway } from '../gateways/fake.js';
import type { Clock } from '../ports/index.js';
import type { ApiKeyRole } from '../security/apiKeys.js';
import type { KeyProvider } from '../security/crypto.js';
import { processPayout } from '../service/processPayout.js';

/**
 * Exempeldata för ett demoläge: två påhittade kunder med utbetalningar av olika slag, så att hela
 * webbgränssnittet går att visa utan Mondido, Fortnox eller riktiga kunder. Allt är simulerat.
 *
 *  - `demo-test`: kund i testläge. Åtta förslag (klara, delvis, avvisad, EUR, tvetydig) och en komplett checklista,
 *    redo för granskning och godkännande. Visar *Kom igång*, träffsäkerheten och underlag.
 *  - `demo-live`: kund som bokför på riktigt. Bokförda utbetalningar, en öppen avvikelse, ett dött kommando och ett osäkert
 *    anrop. Visar det löpande arbetet.
 */

export const DEMO_TENANTS = { test: 'demo-test', live: 'demo-live' } as const;

const ACCOUNTS: AccountMapping = {
  bank: 1930,
  clearing: 1580,
  feeExpense: 6570,
  feeVat: 2641,
  foreign: { EUR: { bank: 1932, clearing: 1582, feeExpense: 6571, feeVat: 2642 } },
};

export interface DemoKey {
  label: string;
  tenantId: string;
  role: ApiKeyRole;
  /** Visas bara här. Lagras aldrig i klartext. */
  key: string;
}

export interface DemoDeps {
  app: App;
  db: Db;
  clock: Clock;
  pepper: Buffer;
  /** Samma simulerade affärssystem som appen använder, så att fakturor och bokförda belopp hänger ihop. */
  ledger: FakeLedgerGateway;
  keyProvider: KeyProvider;
}

const invoice = (id: string, total: number, over: Partial<Invoice> = {}): Invoice => ({
  id,
  reference: `ORDER-${id}`,
  currency: 'SEK',
  total,
  vatTotal: Math.round(total / 5),
  balance: total,
  creditedTotal: 0,
  creditedVatTotal: 0,
  status: 'open',
  ...over,
});

const pay = (id: string, reference: string, amount: number, feeNet = 0, currency = 'SEK'): PayoutLine => ({
  type: 'payment',
  id,
  reference,
  amount,
  currency,
  ...(feeNet > 0 ? { fee: { net: feeNet, vat: Math.round(feeNet / 4) } } : {}),
});

const netOf = (lines: readonly PayoutLine[]): number =>
  lines.reduce((sum, l) => {
    if (l.type === 'payment') return sum + l.amount - (l.fee ? l.fee.net + l.fee.vat : 0);
    if (l.type === 'refund') return sum - l.amount;
    return sum - (l.fee.net + l.fee.vat);
  }, 0);

function payout(id: string, date: string, lines: PayoutLine[], over: Partial<Payout> = {}): Payout {
  return { id, date, currency: lines[0] && 'currency' in lines[0] ? lines[0].currency : 'SEK', netAmount: netOf(lines), lines, ...over };
}

/** Skapar demodata. Kan köras på en tom databas; kör man den två gånger blir andra körningen ett fel (kunderna finns redan). */
export async function seedDemo(deps: DemoDeps): Promise<DemoKey[]> {
  const { app, db, clock, pepper, ledger, keyProvider } = deps;
  const now = clock.now();
  const date = now.toISOString().slice(0, 10);
  const connections = createConnectionRepository(db, keyProvider);
  const uow = createUnitOfWork(db);
  const keys: DemoKey[] = [];

  const setup = async (tenantId: string, name: string, roles: Array<[ApiKeyRole, string]>) => {
    await app.tenants.create({ id: tenantId, name }, now);
    await setTenantAccounts(db, tenantId, ACCOUNTS);
    for (const provider of ['mondido', 'fortnox']) await connections.upsert(tenantId, provider, { token: 'demo-token' }, now);
    for (const [role, label] of roles) {
      const issued = await app.apiKeys.issue(tenantId, { role }, now, pepper);
      keys.push({ label, tenantId, role, key: issued.rawKey });
    }
  };

  const process = async (tenantId: string, p: Payout, mode: 'live' | 'dry_run') => {
    const references = p.lines.flatMap((l) => (l.type === 'fee' ? [] : [l.reference]));
    const invoices = await ledger.findByReferences(tenantId, references);
    return processPayout({ uow, clock }, { tenantId, payout: p, invoices, accounts: ACCOUNTS }, { mode, actor: 'demo' });
  };

  // ------------------------------------------------------------------ demo-test: förslag att granska
  await setup(DEMO_TENANTS.test, 'Demo AB (testläge)', [
    ['approver', 'Godkännare (kan gå live)'],
    ['viewer', 'Läsare (kan bara titta)'],
  ]);
  for (const inv of [
    invoice('1001', 149_000),
    invoice('1002', 59_900),
    invoice('1003', 89_500),
    invoice('1004', 24_900),
    invoice('1005', 129_000),
    invoice('1006', 39_900),
    invoice('1007', 79_900),
    invoice('1008', 15_900),
    invoice('1009', 54_900),
    invoice('1010', 54_900, { reference: 'ORDER-1009' }), // samma referens som 1009: tvetydigt
    invoice('1011', 99_000),
    invoice('2001', 12_000, { currency: 'EUR' }),
  ]) {
    ledger.addInvoice(inv);
  }
  const test = DEMO_TENANTS.test;
  await process(test, payout('UTB-1101', date, [pay('L1', 'ORDER-1001', 149_000, 3_120), pay('L2', 'ORDER-1002', 59_900, 1_360)]), 'dry_run');
  await process(
    test,
    payout('UTB-1102', date, [pay('L1', 'ORDER-1003', 89_500, 2_000), { type: 'refund', id: 'L2', reference: 'ORDER-1003', amount: 20_000, currency: 'SEK' }]),
    'dry_run',
  );
  await process(test, payout('UTB-1103', date, [pay('L1', 'ORDER-1004', 24_900), pay('L2', 'ORDER-1005', 129_000), pay('L3', 'ORDER-9999', 31_000)]), 'dry_run');
  await process(test, payout('UTB-1104', date, [pay('L1', 'ORDER-1006', 39_900), pay('L2', 'ORDER-1011', 98_000)]), 'dry_run');
  await process(test, payout('UTB-1105', date, [pay('L1', 'ORDER-1007', 79_900)], { netAmount: 79_000 }), 'dry_run'); // summan stämmer inte
  await process(test, payout('UTB-1106', date, [pay('L1', 'ORDER-2001', 12_000, 240, 'EUR')]), 'dry_run');
  await process(
    test,
    payout('UTB-1107', date, [pay('L1', 'ORDER-1009', 54_900), { type: 'fee', id: 'L2', currency: 'SEK', fee: { net: 500, vat: 125 } }]),
    'dry_run',
  );
  await process(test, payout('UTB-1108', date, [pay('L1', 'ORDER-1008', 15_900, 400)]), 'dry_run');

  // ------------------------------------------------------------------ demo-live: löpande arbete
  const live = DEMO_TENANTS.live;
  await setup(live, 'Demo Live AB', [['approver', 'Godkännare']]);
  await app.tenants.setMode(live, 'live');
  for (const inv of [invoice('3001', 99_000), invoice('3002', 45_000), invoice('3003', 67_000), invoice('3004', 18_000)]) ledger.addInvoice(inv);

  await process(live, payout('UTB-0901', date, [pay('L1', 'ORDER-3001', 99_000, 2_000), pay('L2', 'ORDER-3002', 45_000, 900)]), 'live');
  await process(live, payout('UTB-0902', date, [pay('L1', 'ORDER-3003', 67_000), pay('L2', 'ORDER-FINNS-INTE', 12_300)]), 'live');
  await drain({ commands: app.repos.commands, gateway: app.gateway, clock });

  // Ett kommando som permanent misslyckats (ett dött kommando som en handläggare kan köa om).
  await app.repos.commands.enqueue(
    live,
    'UTB-0903',
    [{ kind: 'register_invoice_payment', key: `${live}:UTB-0903:L1:payment`, lineId: 'L1', invoiceId: '3004', amount: 18_000, currency: 'SEK', date }],
    now,
  );
  const [claimed] = await app.repos.commands.claimDue(now, 10);
  if (claimed) await app.repos.commands.markFailed(claimed.id, 'permanent', null, now, claimed.attempts);
  await app.repos.payouts.record({ tenantId: live, payoutId: 'UTB-0903', status: 'partial', processedAt: now });

  // Ett anrop vars utfall är okänt.
  await app.repos.guard.begin(live, `${live}:UTB-0904:L1:payment`, now);

  return keys;
}
