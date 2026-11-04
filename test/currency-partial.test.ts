import { describe, expect, it } from 'vitest';
import { drain } from '../src/executor/executor.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { accountMappingSchema, setTenantAccounts, setTenantOption, createTenantConfigProvider } from '../src/db/syncState.js';
import { createTenantRepository } from '../src/db/tenants.js';
import type { AccountMapping, Invoice, LedgerCommand, Payout, PayoutLine } from '../src/domain/types.js';
import { reconcile } from '../src/engine/reconcile.js';
import { processPayout } from '../src/service/processPayout.js';
import { proposalToCsv } from '../src/service/report.js';
import { accounts, createTestStack, makeInvoice } from './helpers.js';

const eurAccounts = { bank: 1932, clearing: 1582, feeExpense: 6571, feeVat: 2642 };
const withEur: AccountMapping = { ...accounts, foreign: { EUR: eurAccounts } };

const eurPayment = (id: string, reference: string, amount: number, fee?: { net: number; vat: number }): PayoutLine => ({
  type: 'payment',
  id,
  reference,
  amount,
  currency: 'EUR',
  ...(fee ? { fee } : {}),
});
const eurPayout = (id: string, lines: PayoutLine[]): Payout => ({
  id,
  date: '2026-10-28',
  currency: 'EUR',
  netAmount: lines.reduce((s, l) => s + (l.type === 'payment' ? l.amount - (l.fee ? l.fee.net + l.fee.vat : 0) : 0), 0),
  lines,
});
const eurInvoice = (id: string, over: Partial<Invoice> = {}) => makeInvoice(id, { currency: 'EUR', total: 10000, vatTotal: 2000, balance: 10000, ...over });

const sekPayout = (id: string, amount: number, reference: string): Payout => ({
  id,
  date: '2026-10-28',
  currency: 'SEK',
  netAmount: amount,
  lines: [{ type: 'payment', id: 'L1', reference, amount, currency: 'SEK' }],
});

const voucherOf = (commands: LedgerCommand[]) => commands.find((c) => c.kind === 'post_voucher');

describe('flera valutor: konton per valuta', () => {
  it('bokför aldrig belopp i en valuta på konton för en annan', () => {
    const result = reconcile({
      tenantId: 'T1',
      payout: eurPayout('P1', [eurPayment('L1', 'REF-A', 10000, { net: 160, vat: 40 })]),
      invoices: [eurInvoice('A')],
      accounts, // inga EUR-konton
    });
    expect(result.status).toBe('partial');
    expect(result.exceptions).toEqual([{ code: 'ACCOUNTS_MISSING', message: expect.stringContaining('EUR') }]);
    expect(voucherOf(result.commands)).toBeUndefined();
    // Själva betalningen på EUR-fakturan hanteras ändå, eftersom den inte rör några konton.
    expect(result.commands.map((c) => c.kind)).toEqual(['register_invoice_payment']);
  });

  it('skapar ett verifikat på valutans konton, märkt med valutan, när konton finns', () => {
    const result = reconcile({
      tenantId: 'T1',
      payout: eurPayout('P1', [eurPayment('L1', 'REF-A', 10000, { net: 160, vat: 40 })]),
      invoices: [eurInvoice('A')],
      accounts: withEur,
    });
    expect(result.status).toBe('complete');
    const voucher = voucherOf(result.commands);
    expect(voucher).toMatchObject({ kind: 'post_voucher', currency: 'EUR' });
    const used = new Set((voucher as Extract<LedgerCommand, { kind: 'post_voucher' }>).lines.map((l) => l.account));
    expect([...used].sort()).toEqual([1582, 1932, 2642, 6571]);
    expect(used.has(accounts.bank)).toBe(false); // aldrig SEK-konton
  });

  it('ett SEK-verifikat är oförändrat: inget currency-fält, så redan köade verifikat inte krockar', () => {
    const result = reconcile({ tenantId: 'T1', payout: sekPayout('P1', 12500, 'REF-A'), invoices: [makeInvoice('A')], accounts: withEur });
    const voucher = voucherOf(result.commands);
    expect(voucher).toBeDefined();
    expect('currency' in (voucher as object)).toBe(false);
  });

  it('en SEK-utbetalning använder huvudkontona även när det finns EUR-konton', () => {
    const result = reconcile({ tenantId: 'T1', payout: sekPayout('P1', 12500, 'REF-A'), invoices: [makeInvoice('A')], accounts: withEur });
    const accountsUsed = (voucherOf(result.commands) as Extract<LedgerCommand, { kind: 'post_voucher' }>).lines.map((l) => l.account);
    expect(accountsUsed).toContain(accounts.bank);
    expect(accountsUsed).not.toContain(eurAccounts.bank);
  });

  it('blandade valutor i en utbetalning avvisas fortfarande (ingen växelkurs att gå på)', () => {
    const payout: Payout = { ...eurPayout('P1', [eurPayment('L1', 'REF-A', 10000)]), currency: 'SEK' };
    const result = reconcile({ tenantId: 'T1', payout, invoices: [eurInvoice('A')], accounts: withEur });
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
  });

  it('en EUR-faktura matchas inte mot en SEK-rad', () => {
    const result = reconcile({ tenantId: 'T1', payout: sekPayout('P1', 10000, 'REF-A'), invoices: [eurInvoice('A')], accounts: withEur });
    expect(result.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
    expect(result.commands).toEqual([]);
  });
});

describe('flera valutor: hela kedjan', () => {
  it('betalningen görs en gång och verifikatet tillkommer när kontona ställts in, utan dubbelbokning', async () => {
    const stack = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: [eurInvoice('A')] });
    const run = (acc: AccountMapping) =>
      processPayout(
        { uow: stack.uow, clock: stack.clock },
        { tenantId: 'T1', payout: eurPayout('P1', [eurPayment('L1', 'REF-A', 10000)]), invoices: [eurInvoice('A', { ...(ledger.invoice('A') ?? {}) })], accounts: acc },
      );

    const first = await run(accounts);
    expect(first.result.exceptions.map((e) => e.code)).toEqual(['ACCOUNTS_MISSING']);
    await drain({ commands: stack.repos.commands, gateway: ledger, clock: stack.clock });
    expect(ledger.invoice('A')?.status).toBe('paid');

    // Kontona ställs in. Betalningen är redan gjord och får inte göras igen; verifikatet skapas.
    const second = await run(withEur);
    expect(second.result.status).toBe('complete');
    expect(second.enqueued).toBe(1);
    await drain({ commands: stack.repos.commands, gateway: ledger, clock: stack.clock });
    expect(ledger.executed.filter((e) => e.command.kind === 'register_invoice_payment')).toHaveLength(1);
    expect(ledger.vouchers).toHaveLength(1);
    expect((await stack.repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
  });
});

describe('kontoinställning med flera valutor', () => {
  it('godtar giltiga konton per valuta', () => {
    expect(accountMappingSchema.safeParse(withEur).success).toBe(true);
    expect(accountMappingSchema.safeParse(accounts).success).toBe(true);
  });

  it.each([
    ['SEK bland utländska valutor', { ...accounts, foreign: { SEK: eurAccounts } }],
    ['ogiltig valutakod', { ...accounts, foreign: { euro: eurAccounts } }],
    ['gemener', { ...accounts, foreign: { eur: eurAccounts } }],
    ['ogiltigt kontonummer', { ...accounts, foreign: { EUR: { ...eurAccounts, bank: 99 } } }],
    ['saknat konto', { ...accounts, foreign: { EUR: { bank: 1932, clearing: 1582, feeExpense: 6571 } } }],
    ['okänt fält', { ...accounts, foreign: { EUR: { ...eurAccounts, extra: 1 } } }],
  ])('avvisar %s', (_name, value) => {
    expect(accountMappingSchema.safeParse(value).success).toBe(false);
  });

  it('sparas och läses tillbaka, och en trasig inställning ger ingen konfiguration', async () => {
    const { db, clock } = await createTestStack();
    await createTenantRepository(db).create({ id: 'T1', name: 'Kund' }, clock.now());
    await setTenantAccounts(db, 'T1', withEur);
    const provider = createTenantConfigProvider(db);
    expect((await provider.get('T1'))?.accounts).toEqual(withEur);

    await setTenantAccounts(db, 'T1', accounts);
    expect((await provider.get('T1'))?.accounts).toEqual(accounts);

    await db.query(`update tenant set accounts = '{"bank":1930,"clearing":1580,"feeExpense":6570,"feeVat":2641,"foreign":{"SEK":{}}}'::jsonb where id = 'T1'`);
    expect(await provider.get('T1')).toBeNull();
  });
});

describe('delbetalningar', () => {
  const invoices = () => [makeInvoice('A')]; // saldo 12500
  const pay = (id: string, amount: number): PayoutLine => ({ type: 'payment', id, reference: 'REF-A', amount, currency: 'SEK' });
  const payout = (lines: PayoutLine[]): Payout => ({
    id: 'P1',
    date: '2026-10-28',
    currency: 'SEK',
    netAmount: lines.reduce((s, l) => s + (l.type === 'payment' ? l.amount : 0), 0),
    lines,
  });
  const run = (lines: PayoutLine[], allowPartialPayments?: boolean) =>
    reconcile({ tenantId: 'T1', payout: payout(lines), invoices: invoices(), accounts, ...(allowPartialPayments === undefined ? {} : { allowPartialPayments }) });

  it('är av som standard: en mindre betalning blir en avvikelse', () => {
    for (const flag of [undefined, false]) {
      const result = run([pay('L1', 5000)], flag);
      expect(result.status).toBe('partial');
      expect(result.exceptions.map((e) => e.code)).toEqual(['AMOUNT_MISMATCH']);
      expect(result.commands).toEqual([]);
    }
  });

  it('registrerar bara det som betalats och anger vad som återstår', () => {
    const result = run([pay('L1', 5000)], true);
    expect(result.status).toBe('complete');
    expect(result.commands[0]).toMatchObject({ kind: 'register_invoice_payment', invoiceId: 'A', amount: 5000, remaining: 7500 });
  });

  it('en full betalning har inget remaining-fält, med eller utan inställningen', () => {
    for (const flag of [false, true]) {
      const cmd = run([pay('L1', 12500)], flag).commands[0];
      expect(cmd && 'remaining' in cmd).toBe(false);
    }
  });

  it('två delbetalningar som tillsammans täcker saldot: den sista är en vanlig full betalning', () => {
    const result = run([pay('L1', 5000), pay('L2', 7500)], true);
    expect(result.status).toBe('complete');
    const [first, second] = result.commands;
    expect(first).toMatchObject({ lineId: 'L1', remaining: 7500 });
    expect(second).toMatchObject({ lineId: 'L2', amount: 7500 });
    expect(second && 'remaining' in second).toBe(false);
  });

  it('en betalning större än saldot är alltid en avvikelse, även med inställningen', () => {
    const result = run([pay('L1', 13000)], true);
    expect(result.exceptions.map((e) => e.code)).toEqual(['AMOUNT_MISMATCH']);
  });

  it('delbetalningar som tillsammans överstiger saldot: den som inte ryms blir en avvikelse', () => {
    const result = run([pay('L1', 8000), pay('L2', 8000)], true);
    expect(result.commands).toHaveLength(1);
    expect(result.exceptions).toMatchObject([{ code: 'AMOUNT_MISMATCH', lineId: 'L2' }]);
  });

  it('en noll- eller negativ betalning är fortfarande ogiltig', () => {
    expect(run([pay('L1', 0)], true).exceptions.map((e) => e.code)).toEqual(['INVALID_AMOUNT']);
  });

  it('en återbetalning på en delbetald faktura är en avvikelse (fakturan är inte betald)', () => {
    const partiallyPaid = makeInvoice('A', { balance: 7500 });
    const result = reconcile({
      tenantId: 'T1',
      payout: { id: 'P2', date: '2026-10-28', currency: 'SEK', netAmount: -1000, lines: [{ type: 'refund', id: 'R1', reference: 'REF-A', amount: 1000, currency: 'SEK' }] },
      invoices: [partiallyPaid],
      accounts,
      allowPartialPayments: true,
    });
    expect(result.exceptions.map((e) => e.code)).toEqual(['INVOICE_NOT_OPEN']);
  });

  it('är idempotent: samma indata ger samma kommandon och nycklar', () => {
    expect(run([pay('L1', 5000)], true)).toEqual(run([pay('L1', 5000)], true));
  });

  it('hela kedjan: fakturan förblir öppen med resten, och en omkörning bokför inget igen', async () => {
    const stack = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: invoices() });
    const go = () =>
      processPayout(
        { uow: stack.uow, clock: stack.clock },
        { tenantId: 'T1', payout: payout([pay('L1', 5000)]), invoices: [ledger.invoice('A')!], accounts, allowPartialPayments: true },
      );
    await go();
    await drain({ commands: stack.repos.commands, gateway: ledger, clock: stack.clock });
    expect(ledger.invoice('A')).toMatchObject({ status: 'open', balance: 7500 });

    expect((await go()).enqueued).toBe(0);
    await drain({ commands: stack.repos.commands, gateway: ledger, clock: stack.clock });
    expect(ledger.invoice('A')).toMatchObject({ status: 'open', balance: 7500 });
    expect(ledger.executed.filter((e) => e.command.kind === 'register_invoice_payment')).toHaveLength(1);
  });

  it('gatewayen vägrar en delbetalning som inte stämmer med fakturans saldo', async () => {
    const ledger = new FakeLedgerGateway({ invoices: invoices() });
    const bad: LedgerCommand = { kind: 'register_invoice_payment', key: 'k', lineId: 'L1', invoiceId: 'A', amount: 5000, currency: 'SEK', date: '2026-10-28', remaining: 1 };
    await expect(ledger.execute('T1', bad)).rejects.toMatchObject({ notApplied: true });
    expect(ledger.invoice('A')?.balance).toBe(12500);
  });

  it('är en inställning per kund som sparas, läses och kan slås av', async () => {
    const { db, clock } = await createTestStack();
    await createTenantRepository(db).create({ id: 'T1', name: 'Kund' }, clock.now());
    await createTenantRepository(db).create({ id: 'T2', name: 'Kund 2' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await setTenantAccounts(db, 'T2', accounts);
    const provider = createTenantConfigProvider(db);
    expect((await provider.get('T1'))?.allowPartialPayments).toBe(false);

    expect(await setTenantOption(db, 'T1', 'allowPartialPayments', true)).toBe(true);
    expect((await provider.get('T1'))?.allowPartialPayments).toBe(true);
    expect((await provider.get('T2'))?.allowPartialPayments).toBe(false);

    expect(await setTenantOption(db, 'T1', 'allowPartialPayments', false)).toBe(true);
    expect((await provider.get('T1'))?.allowPartialPayments).toBe(false);
    expect(await setTenantOption(db, 'FINNS-INTE', 'allowPartialPayments', true)).toBe(false);
    await expect(setTenantOption(db, 'T1', 'drop table tenant' as never, true)).rejects.toThrow('Okänd inställning');
  });

  it('syns i underlaget som delbetalning med kvarvarande belopp', () => {
    const result = run([pay('L1', 5000)], true);
    const csv = proposalToCsv({ tenantId: 'T1', payoutId: 'P1', status: result.status, result, updatedAt: new Date() });
    expect(csv).toContain('Delbetalning;L1;A;2026-10-28;SEK;50,00;;;;;Kvar: 75,00');
  });
});
