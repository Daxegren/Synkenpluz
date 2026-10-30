import { describe, expect, it } from 'vitest';
import type { AccountMapping, Invoice, Payout, PayoutLine, ReconcileInput } from '../src/domain/types.js';
import { reconcile } from '../src/engine/reconcile.js';

// Kontonummer är påhittade testvärden, inte rekommendationer.
const accounts: AccountMapping = { bank: 1930, clearing: 1580, feeExpense: 6570, feeVat: 2641 };

function invoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    reference: `REF-${overrides.id}`,
    currency: 'SEK',
    total: 12500,
    vatTotal: 2500,
    balance: 12500,
    creditedTotal: 0,
    creditedVatTotal: 0,
    status: 'open',
    ...overrides,
  };
}

function payment(id: string, reference: string, amount: number, fee?: { net: number; vat: number }): PayoutLine {
  return { type: 'payment', id, reference, amount, currency: 'SEK', ...(fee ? { fee } : {}) };
}

function netOf(lines: PayoutLine[]): number {
  return lines.reduce((sum, l) => {
    if (l.type === 'payment') return sum + l.amount - (l.fee ? l.fee.net + l.fee.vat : 0);
    if (l.type === 'refund') return sum - l.amount;
    return sum - (l.fee.net + l.fee.vat);
  }, 0);
}

function input(lines: PayoutLine[], invoices: Invoice[], overrides: Partial<Payout> = {}): ReconcileInput {
  const payout: Payout = {
    id: 'PO-1',
    date: '2026-10-28',
    currency: 'SEK',
    netAmount: netOf(lines),
    lines,
    ...overrides,
  };
  return { tenantId: 'T1', payout, invoices, accounts };
}

function voucherOf(result: ReturnType<typeof reconcile>) {
  const v = result.commands.find((c) => c.kind === 'post_voucher');
  if (!v || v.kind !== 'post_voucher') throw new Error('inget verifikat');
  return v;
}

describe('lyckad avstämning', () => {
  it('bokför inbetalningar och ett balanserat verifikat', () => {
    const lines = [
      payment('L1', 'REF-A', 12500, { net: 200, vat: 50 }),
      payment('L2', 'REF-B', 12500, { net: 200, vat: 50 }),
    ];
    const result = reconcile(input(lines, [invoice({ id: 'A' }), invoice({ id: 'B' })]));

    expect(result.status).toBe('complete');
    expect(result.exceptions).toEqual([]);
    expect(result.commands.filter((c) => c.kind === 'register_invoice_payment')).toHaveLength(2);

    const voucher = voucherOf(result);
    const debit = voucher.lines.reduce((s, l) => s + l.debit, 0);
    const credit = voucher.lines.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBe(credit);
    expect(voucher.lines).toEqual([
      { account: 1930, debit: 24500, credit: 0 }, // netto till bank
      { account: 6570, debit: 400, credit: 0 }, // avgifter exkl. moms
      { account: 2641, debit: 100, credit: 0 }, // ingående moms på avgifter
      { account: 1580, debit: 0, credit: 25000 }, // clearing nollställs
    ]);
  });

  it('ger samma kommandon och nycklar vid omkörning', () => {
    const args = () => input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A' })]);
    expect(reconcile(args())).toEqual(reconcile(args()));
    const [cmd] = reconcile(args()).commands;
    expect(cmd?.key).toBe('T1:PO-1:L1:payment');
  });

  it('ändrar inte indata', () => {
    const invoices = [invoice({ id: 'A' })];
    const snapshot = structuredClone(invoices);
    reconcile(input([payment('L1', 'REF-A', 12500)], invoices));
    expect(invoices).toEqual(snapshot);
  });

  it('tolererar blanksteg runt referensen', () => {
    const result = reconcile(input([payment('L1', ' REF-A ', 12500)], [invoice({ id: 'A' })]));
    expect(result.status).toBe('complete');
  });

  it('hanterar fristående avgiftsrader', () => {
    const lines: PayoutLine[] = [
      payment('L1', 'REF-A', 12500),
      { type: 'fee', id: 'F1', currency: 'SEK', fee: { net: 1000, vat: 250 } },
    ];
    const result = reconcile(input(lines, [invoice({ id: 'A' })]));
    expect(result.status).toBe('complete');
    const voucher = voucherOf(result);
    expect(voucher.lines.find((l) => l.account === 1930)?.debit).toBe(11250);
    expect(voucher.lines.find((l) => l.account === 6570)?.debit).toBe(1000);
  });

  it('klarar en utbetalning med negativt netto (återbetalningar större än betalningar)', () => {
    const lines: PayoutLine[] = [{ type: 'refund', id: 'R1', reference: 'REF-A', amount: 5000, currency: 'SEK' }];
    const result = reconcile(input(lines, [invoice({ id: 'A', balance: 0, status: 'paid' })]));
    expect(result.status).toBe('complete');
    const voucher = voucherOf(result);
    expect(voucher.lines).toEqual([
      { account: 1930, debit: 0, credit: 5000 },
      { account: 1580, debit: 5000, credit: 0 },
    ]);
  });
});

describe('omkörning', () => {
  it('matchar inte om rader som redan bokförts, men tar med dem i verifikatet', () => {
    const lines = [payment('L1', 'REF-A', 12500), payment('L2', 'REF-B', 12500)];
    // L1 är redan bokförd, så fakturan är nu betald i affärssystemet.
    const invoices = [invoice({ id: 'A', status: 'paid', balance: 0 }), invoice({ id: 'B' })];
    const result = reconcile({ ...input(lines, invoices), settledLineIds: new Set(['L1']) });

    expect(result.status).toBe('complete');
    expect(result.exceptions).toEqual([]);
    expect(result.commands.map((c) => c.kind)).toEqual(['register_invoice_payment', 'post_voucher']);
    expect(voucherOf(result).lines.find((l) => l.account === 1930)?.debit).toBe(25000);
  });

  it('utan settledLineIds blir en redan bokförd rad en avvikelse', () => {
    const result = reconcile(
      input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A', status: 'paid', balance: 0 })]),
    );
    expect(result.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
  });
});

describe('avvisad utbetalning', () => {
  it('avvisar när radernas summa inte stämmer med utbetalt belopp', () => {
    const result = reconcile(
      input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A' })], { netAmount: 12499 }),
    );
    expect(result.status).toBe('rejected');
    expect(result.commands).toEqual([]);
    expect(result.exceptions[0]?.code).toBe('PAYOUT_SUM_MISMATCH');
  });

  it('avvisar dubbla rad-id', () => {
    const lines = [payment('L1', 'REF-A', 12500), payment('L1', 'REF-B', 12500)];
    const result = reconcile(input(lines, [invoice({ id: 'A' }), invoice({ id: 'B' })]));
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('DUPLICATE_LINE_ID');
  });

  it('avvisar rad i annan valuta än utbetalningen', () => {
    const lines: PayoutLine[] = [{ type: 'payment', id: 'L1', reference: 'REF-A', amount: 100, currency: 'EUR' }];
    const result = reconcile(input(lines, [invoice({ id: 'A' })]));
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
  });

  it.each([
    ['decimal', 100.5],
    ['negativt', -100],
    ['NaN', Number.NaN],
  ])('avvisar ogiltigt belopp (%s)', (_name, amount) => {
    const result = reconcile(input([payment('L1', 'REF-A', amount)], [invoice({ id: 'A' })], { netAmount: 0 }));
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('INVALID_AMOUNT');
  });
});

describe('delvis avstämning', () => {
  it('bokför säkra rader men inte verifikatet när en rad saknar match', () => {
    const lines = [payment('L1', 'REF-A', 12500), payment('L2', 'REF-OKÄND', 3000)];
    const result = reconcile(input(lines, [invoice({ id: 'A' })]));

    expect(result.status).toBe('partial');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.kind).toBe('register_invoice_payment');
    expect(result.exceptions).toEqual([
      { code: 'NO_MATCH', lineId: 'L2', message: expect.stringContaining('REF-OKÄND') },
    ]);
  });

  it('flaggar tvetydig referens i stället för att gissa', () => {
    const result = reconcile(
      input([payment('L1', 'DUP', 12500)], [
        invoice({ id: 'A', reference: 'DUP' }),
        invoice({ id: 'B', reference: 'DUP' }),
      ]),
    );
    expect(result.status).toBe('partial');
    expect(result.commands).toEqual([]);
    expect(result.exceptions[0]?.code).toBe('AMBIGUOUS_MATCH');
  });

  it('flaggar belopp som inte stämmer med fakturan (ingen automatisk delbetalning)', () => {
    const result = reconcile(input([payment('L1', 'REF-A', 10000)], [invoice({ id: 'A' })]));
    expect(result.exceptions[0]?.code).toBe('AMOUNT_MISMATCH');
    expect(result.commands).toEqual([]);
  });

  it('flaggar redan betald och annullerad faktura', () => {
    const paid = reconcile(input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A', status: 'paid', balance: 0 })]));
    const cancelled = reconcile(input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A', status: 'cancelled' })]));
    expect(paid.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
    expect(cancelled.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
  });

  it('flaggar valutaskillnad mellan rad och faktura', () => {
    const result = reconcile(input([payment('L1', 'REF-A', 12500)], [invoice({ id: 'A', currency: 'EUR' })]));
    expect(result.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
  });

  it('flaggar nollbelopp', () => {
    const result = reconcile(input([payment('L1', 'REF-A', 0)], [invoice({ id: 'A' })]));
    expect(result.exceptions[0]?.code).toBe('INVALID_AMOUNT');
  });

  it('betalar samma faktura bara en gång inom en utbetalning', () => {
    const lines = [payment('L1', 'REF-A', 12500), payment('L2', 'REF-A', 12500)];
    const result = reconcile(input(lines, [invoice({ id: 'A' })]));
    expect(result.commands.filter((c) => c.kind === 'register_invoice_payment')).toHaveLength(1);
    expect(result.exceptions).toEqual([
      { code: 'INVOICE_NOT_OPEN', lineId: 'L2', message: expect.any(String) },
    ]);
  });
});

describe('återbetalningar', () => {
  const paidInvoice = (overrides: Partial<Invoice> = {}) =>
    invoice({ id: 'A', status: 'paid', balance: 0, ...overrides });
  const refund = (id: string, amount: number): PayoutLine => ({
    type: 'refund',
    id,
    reference: 'REF-A',
    amount,
    currency: 'SEK',
  });

  it('helkreditering av betald faktura', () => {
    const result = reconcile(input([refund('R1', 12500)], [paidInvoice()]));
    expect(result.status).toBe('complete');
    expect(result.commands[0]).toMatchObject({
      kind: 'credit_invoice',
      mode: 'full',
      amount: 12500,
      vat: 2500,
      net: 10000,
    });
  });

  it('delkreditering fördelar moms proportionellt och summerar exakt', () => {
    const result = reconcile(input([refund('R1', 5000)], [paidInvoice()]));
    expect(result.commands[0]).toMatchObject({ kind: 'credit_invoice', mode: 'partial', amount: 5000, vat: 1000, net: 4000 });
  });

  it('flera delkrediteringar ger exakt fakturans moms, utan avrundningsdrift', () => {
    // 3 x 33,34 + ... mot en faktura på 100,00 med 25 % moms (20,00).
    const inv = paidInvoice({ total: 10000, vatTotal: 2000 });
    let state = { ...inv };
    let vatSum = 0;
    let amountSum = 0;
    for (const amount of [3333, 3333, 3334]) {
      const result = reconcile(input([refund(`R${amountSum}`, amount)], [state]));
      const cmd = result.commands[0];
      if (cmd?.kind !== 'credit_invoice') throw new Error('förväntade kreditering');
      expect(cmd.vat + cmd.net).toBe(amount);
      vatSum += cmd.vat;
      amountSum += amount;
      state = { ...state, creditedTotal: state.creditedTotal + amount, creditedVatTotal: state.creditedVatTotal + cmd.vat };
    }
    expect(amountSum).toBe(10000);
    expect(vatSum).toBe(2000);
  });

  it('sista krediteringen tar kvarvarande moms när proportionell fördelning ger för lite', () => {
    // Faktura på 3 öre med 1 öre moms, krediterad i tre steg om 1 öre. Proportionellt
    // blir momsen 0 varje gång, men totalt ska exakt 1 öre moms krediteras.
    let state = paidInvoice({ total: 3, vatTotal: 1 });
    let vatSum = 0;
    for (const step of [1, 2, 3]) {
      const result = reconcile(input([refund(`R${step}`, 1)], [state], { id: `PO-${step}` }));
      const cmd = result.commands[0];
      if (cmd?.kind !== 'credit_invoice') throw new Error('förväntade kreditering');
      vatSum += cmd.vat;
      state = { ...state, creditedTotal: state.creditedTotal + 1, creditedVatTotal: state.creditedVatTotal + cmd.vat };
    }
    expect(vatSum).toBe(1);
  });

  it('flaggar återbetalning som överstiger återstående krediterbart', () => {
    const result = reconcile(input([refund('R1', 3000)], [paidInvoice({ creditedTotal: 10000, creditedVatTotal: 2000 })]));
    expect(result.exceptions[0]?.code).toBe('REFUND_EXCEEDS_INVOICE');
    expect(result.commands).toEqual([]);
  });

  it('flaggar återbetalning mot obetald faktura', () => {
    const result = reconcile(input([refund('R1', 1000)], [invoice({ id: 'A' })]));
    expect(result.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
  });

  it('betalning och återbetalning på samma faktura i en utbetalning är oberoende av radordning', () => {
    const lines = [refund('R1', 2500), payment('L1', 'REF-A', 12500)];
    const result = reconcile(input(lines, [invoice({ id: 'A' })]));
    expect(result.status).toBe('complete');
    expect(result.commands.map((c) => c.kind)).toEqual([
      'register_invoice_payment',
      'credit_invoice',
      'post_voucher',
    ]);
  });
});
