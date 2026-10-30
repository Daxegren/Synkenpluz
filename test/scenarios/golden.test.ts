import { describe, expect, it } from 'vitest';
import type { ReconcileInput } from '../../src/domain/types.js';
import { reconcile } from '../../src/engine/reconcile.js';
import { byKind, feeLine, invoice, makeInput, payment, refund, voucherBalance, voucherOf } from './helpers.js';

const MAX = Number.MAX_SAFE_INTEGER;

describe('golden: verkliga e-handelsfall', () => {
  it('1. blandad utbetalning: betalningar med avgift, fristående avgift och återbetalning', () => {
    const lines = [
      payment('p1', 'ORD-1001', 49900, { net: 1000, vat: 250 }),
      payment('p2', 'ORD-1002', 12900, { net: 300, vat: 75 }),
      refund('r1', 'ORD-0990', 5000),
      feeLine('f1', 2000, 500), // månadsavgift
    ];
    const invoices = [
      invoice({ id: 'I1', reference: 'ORD-1001', total: 49900, vatTotal: 9980, balance: 49900 }),
      invoice({ id: 'I2', reference: 'ORD-1002', total: 12900, vatTotal: 2580, balance: 12900 }),
      invoice({ id: 'I0', reference: 'ORD-0990', total: 20000, vatTotal: 4000, balance: 0, status: 'paid' }),
    ];
    const result = reconcile(makeInput(lines, invoices));

    expect(result.status).toBe('complete');
    // netto = 49900-1250 + 12900-375 - 5000 - 2500 = 53675
    expect(makeInput(lines, invoices).payout.netAmount).toBe(53675);
    expect(byKind(result, 'register_invoice_payment').map((c) => [c.invoiceId, c.amount])).toEqual([
      ['I1', 49900],
      ['I2', 12900],
    ]);
    const [credit] = byKind(result, 'credit_invoice');
    expect(credit).toMatchObject({ invoiceId: 'I0', amount: 5000, vat: 1000, net: 4000, mode: 'partial' });
    expect(voucherOf(result).lines).toEqual([
      { account: 1930, debit: 53675, credit: 0 },
      { account: 6570, debit: 3300, credit: 0 },
      { account: 2641, debit: 825, credit: 0 },
      { account: 1580, debit: 0, credit: 57800 }, // 62800 betalningar - 5000 återbetalning
    ]);
    const { debit, credit: cr } = voucherBalance(result);
    expect(debit).toBe(cr);
  });

  it('2. delkreditering i tre steg (över tre utbetalningar) summerar exakt till fakturans moms', () => {
    // 1 000,01 kr varav 250,00 moms: svåra avrundningar.
    const total = 100001;
    const vat = 25000;
    let credited = 0;
    let creditedVat = 0;
    const steps = [33333, 33334, 33334];
    const cmds = steps.map((amount, i) => {
      const inv = invoice({
        id: 'X',
        reference: 'ORD-7',
        total,
        vatTotal: vat,
        balance: 0,
        status: 'paid',
        creditedTotal: credited,
        creditedVatTotal: creditedVat,
      });
      const result = reconcile(makeInput([refund(`r${i}`, 'ORD-7', amount)], [inv], { id: `PO-${i}` }));
      expect(result.status).toBe('complete');
      const [c] = byKind(result, 'credit_invoice');
      credited += c!.amount;
      creditedVat += c!.vat;
      return c!;
    });
    expect(cmds.map((c) => c.mode)).toEqual(['partial', 'partial', 'partial']);
    expect(cmds.every((c) => c.vat + c.net === c.amount && c.vat >= 0 && c.net >= 0)).toBe(true);
    expect(cmds.reduce((s, c) => s + c.vat, 0)).toBe(vat);
    expect(cmds.reduce((s, c) => s + c.amount, 0)).toBe(total);
    // Första steget: 33333 * 25000/100001 = 8333,08 -> 8333
    expect(cmds[0]!.vat).toBe(8333);
  });

  it('3. hel kreditering av okrediterad faktura får mode full', () => {
    const inv = invoice({ id: 'F', reference: 'ORD-F', total: 8000, vatTotal: 1600, balance: 0, status: 'paid' });
    const result = reconcile(makeInput([refund('r', 'ORD-F', 8000)], [inv]));
    expect(byKind(result, 'credit_invoice')[0]).toMatchObject({ mode: 'full', vat: 1600, net: 6400 });
    // bank krediteras 8000, clearing debiteras 8000
    expect(voucherOf(result).lines).toEqual([
      { account: 1930, debit: 0, credit: 8000 },
      { account: 1580, debit: 8000, credit: 0 },
    ]);
  });

  it('4. tvetydig referens: raden hamnar i avvikelse, övriga bokförs, inget verifikat', () => {
    const lines = [payment('p1', 'ORD-5', 10000), payment('p2', 'ORD-6', 20000)];
    const invoices = [
      invoice({ id: 'A', reference: 'ORD-5', total: 10000, vatTotal: 2000, balance: 10000 }),
      invoice({ id: 'A2', reference: 'ORD-5', total: 10000, vatTotal: 2000, balance: 10000 }),
      invoice({ id: 'B', reference: 'ORD-6', total: 20000, vatTotal: 4000, balance: 20000 }),
    ];
    const result = reconcile(makeInput(lines, invoices));
    expect(result.status).toBe('partial');
    expect(result.exceptions).toEqual([expect.objectContaining({ code: 'AMBIGUOUS_MATCH', lineId: 'p1' })]);
    expect(result.commands.map((c) => c.kind)).toEqual(['register_invoice_payment']);
    expect(byKind(result, 'register_invoice_payment')[0]?.invoiceId).toBe('B');
  });

  it('5. referens med blanksteg matchar, okänd referens ger NO_MATCH', () => {
    const lines = [payment('p1', '  ORD-9 ', 5000), payment('p2', 'ORD-404', 5000)];
    const invoices = [invoice({ id: 'N', reference: 'ORD-9', total: 5000, vatTotal: 1000, balance: 5000 })];
    const result = reconcile(makeInput(lines, invoices));
    expect(result.status).toBe('partial');
    expect(result.exceptions.map((e) => [e.code, e.lineId])).toEqual([['NO_MATCH', 'p2']]);
    expect(byKind(result, 'register_invoice_payment')).toHaveLength(1);
  });

  it('6. nollbelopp: nollbetalning avvisas, nollavgift ger inga verifikatrader', () => {
    const zeroPay = reconcile(
      makeInput([payment('p', 'ORD-Z', 0)], [invoice({ id: 'Z', reference: 'ORD-Z', total: 0, vatTotal: 0, balance: 0 })]),
    );
    expect(zeroPay.status).toBe('partial');
    expect(zeroPay.exceptions[0]?.code).toBe('INVALID_AMOUNT');

    const zeroFee = reconcile(makeInput([feeLine('f', 0, 0)], []));
    expect(zeroFee.status).toBe('complete');
    expect(zeroFee.commands).toEqual([]);

    const zeroRefund = reconcile(
      makeInput([refund('r', 'ORD-Z', 0)], [invoice({ id: 'Z', reference: 'ORD-Z', status: 'paid', balance: 0 })]),
    );
    expect(zeroRefund.exceptions[0]?.code).toBe('INVALID_AMOUNT');
  });

  it('7. stora belopp nära Number.MAX_SAFE_INTEGER bokförs exakt', () => {
    const inv = invoice({ id: 'BIG', reference: 'ORD-BIG', total: MAX, vatTotal: 1_800_000_000_000_001, balance: MAX });
    const result = reconcile(makeInput([payment('p', 'ORD-BIG', MAX)], [inv]));
    expect(result.status).toBe('complete');
    expect(voucherOf(result).lines).toEqual([
      { account: 1930, debit: MAX, credit: 0 },
      { account: 1580, debit: 0, credit: MAX },
    ]);
  });

  it('8. delkreditering av jättefaktura delar momsen exakt (BigInt i allocate)', () => {
    const total = MAX - 1; // jämnt
    const vat = 1_800_000_000_000_000;
    const inv = invoice({ id: 'BIG', reference: 'ORD-BIG', total, vatTotal: vat, balance: 0, status: 'paid' });
    const half = total / 2;
    const first = reconcile(makeInput([refund('r1', 'ORD-BIG', half)], [inv]));
    expect(first.status).toBe('complete');
    const c1 = byKind(first, 'credit_invoice')[0]!;
    expect(c1.vat + c1.net).toBe(half);
    expect(c1.vat).toBe(vat / 2);
    const second = reconcile(
      makeInput([refund('r2', 'ORD-BIG', half)], [{ ...inv, creditedTotal: half, creditedVatTotal: c1.vat }]),
    );
    const c2 = byKind(second, 'credit_invoice')[0]!;
    expect(c1.vat + c2.vat).toBe(vat);
  });

  it('9. summor som spräcker heltalsgränsen avvisas i stället för att avrundas tyst', () => {
    const lines = [payment('p1', 'ORD-A', MAX - 10), payment('p2', 'ORD-B', MAX - 10)];
    const invoices = [
      invoice({ id: 'A', reference: 'ORD-A', total: MAX - 10, vatTotal: 0, balance: MAX - 10 }),
      invoice({ id: 'B', reference: 'ORD-B', total: MAX - 10, vatTotal: 0, balance: MAX - 10 }),
    ];
    const input: ReconcileInput = makeInput(lines, invoices);
    input.payout = { ...input.payout, netAmount: 2 * (MAX - 10) }; // ej säkert heltal
    const result = reconcile(input);
    expect(result.status).toBe('rejected');
    expect(result.commands).toEqual([]);
    expect(result.exceptions[0]?.code).toBe('INVALID_AMOUNT');

    // Även när netto är säkert (återbetalning drar ner) får delsummorna inte spricka.
    const withRefund = [...lines, refund('r', 'ORD-A', MAX - 10)];
    const netOk = makeInput(withRefund, invoices, { netAmount: MAX - 10 });
    const r2 = reconcile(netOk);
    expect(r2.status).toBe('rejected');
    expect(r2.commands).toEqual([]);
  });

  it('10. faktura i annan valuta: EUR-utbetalning mot EUR-faktura går igenom', () => {
    const lines = [payment('p', 'ORD-E1', 9900, { net: 150, vat: 0 }, 'EUR')];
    const invoices = [
      invoice({ id: 'E1', reference: 'ORD-E1', currency: 'EUR', total: 9900, vatTotal: 0, balance: 9900 }),
    ];
    const result = reconcile(makeInput(lines, invoices, { currency: 'EUR' }));
    expect(result.status).toBe('complete');
    expect(byKind(result, 'register_invoice_payment')[0]).toMatchObject({ currency: 'EUR', amount: 9900 });
  });

  it('11. SEK-utbetalning mot EUR-faktura ger CURRENCY_MISMATCH, rad i annan valuta än utbetalningen avvisar allt', () => {
    const inv = invoice({ id: 'E1', reference: 'ORD-E1', currency: 'EUR', total: 9900, vatTotal: 0, balance: 9900 });
    const mismatch = reconcile(makeInput([payment('p', 'ORD-E1', 9900)], [inv]));
    expect(mismatch.status).toBe('partial');
    expect(mismatch.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
    expect(mismatch.commands).toEqual([]);

    const mixed = reconcile(
      makeInput([payment('p', 'ORD-E1', 9900), payment('q', 'ORD-X', 100, undefined, 'EUR')], [inv]),
    );
    expect(mixed.status).toBe('rejected');
    expect(mixed.commands).toEqual([]);
    expect(mixed.exceptions[0]?.code).toBe('CURRENCY_MISMATCH');
  });

  it('12. återbetalning av faktura som betalas i samma utbetalning, oberoende av radordning', () => {
    const invoices = [invoice({ id: 'S', reference: 'ORD-S', total: 10000, vatTotal: 2000, balance: 10000 })];
    const a = reconcile(makeInput([refund('a-ref', 'ORD-S', 4000), payment('b-pay', 'ORD-S', 10000)], invoices));
    const b = reconcile(makeInput([payment('b-pay', 'ORD-S', 10000), refund('a-ref', 'ORD-S', 4000)], invoices));
    expect(a.status).toBe('complete');
    expect(a).toEqual(b);
    expect(byKind(a, 'credit_invoice')[0]).toMatchObject({ vat: 800, net: 3200 });
  });

  it('13. betalning på redan betald faktura, delbetalning och överkreditering hamnar i avvikelser', () => {
    const lines = [
      payment('p1', 'ORD-P', 10000),
      payment('p2', 'ORD-Q', 5000),
      refund('r1', 'ORD-R', 9000),
    ];
    const invoices = [
      invoice({ id: 'P', reference: 'ORD-P', total: 10000, vatTotal: 2000, balance: 0, status: 'paid' }),
      invoice({ id: 'Q', reference: 'ORD-Q', total: 10000, vatTotal: 2000, balance: 10000 }),
      invoice({
        id: 'R',
        reference: 'ORD-R',
        total: 10000,
        vatTotal: 2000,
        balance: 0,
        status: 'paid',
        creditedTotal: 5000,
        creditedVatTotal: 1000,
      }),
    ];
    const result = reconcile(makeInput(lines, invoices));
    expect(result.status).toBe('partial');
    expect(result.commands).toEqual([]);
    expect(result.exceptions.map((e) => [e.lineId, e.code]).sort()).toEqual([
      ['p1', 'INVOICE_NOT_OPEN'],
      ['p2', 'AMOUNT_MISMATCH'],
      ['r1', 'REFUND_EXCEEDS_INVOICE'],
    ]);
  });

  it('14. nettonegativ utbetalning (återbetalningar > betalningar) ger krediterad bank', () => {
    const lines = [payment('p', 'ORD-N1', 3000), refund('r', 'ORD-N2', 8000)];
    const invoices = [
      invoice({ id: 'N1', reference: 'ORD-N1', total: 3000, vatTotal: 600, balance: 3000 }),
      invoice({ id: 'N2', reference: 'ORD-N2', total: 8000, vatTotal: 1600, balance: 0, status: 'paid' }),
    ];
    const result = reconcile(makeInput(lines, invoices));
    expect(result.status).toBe('complete');
    expect(voucherOf(result).lines).toEqual([
      { account: 1930, debit: 0, credit: 5000 },
      { account: 1580, debit: 5000, credit: 0 },
    ]);
  });

  it('15. omkörning med settledLineIds bokför inte om redan bokförda rader men skapar verifikatet', () => {
    const lines = [payment('p1', 'ORD-1', 10000, { net: 100, vat: 25 })];
    const invoices = [
      invoice({ id: 'I', reference: 'ORD-1', total: 10000, vatTotal: 2000, balance: 0, status: 'paid' }),
    ];
    const rerun = reconcile({ ...makeInput(lines, invoices), settledLineIds: new Set(['p1']) });
    expect(rerun.status).toBe('complete');
    expect(rerun.commands.map((c) => c.kind)).toEqual(['post_voucher']);

    // Utan settled flaggas fakturan som redan betald.
    const naive = reconcile(makeInput(lines, invoices));
    expect(naive.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
  });

  it('16. kolon och konstiga tecken i id:n ger fortfarande unika nycklar', () => {
    const lines = [payment('a:payment', 'ORD-C1', 1000), payment('a', 'ORD-C2', 1000)];
    const invoices = [
      invoice({ id: 'C1', reference: 'ORD-C1', total: 1000, vatTotal: 200, balance: 1000 }),
      invoice({ id: 'C2', reference: 'ORD-C2', total: 1000, vatTotal: 200, balance: 1000 }),
    ];
    const result = reconcile(makeInput(lines, invoices));
    const keys = result.commands.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
