import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Invoice, PayoutLine } from '../src/domain/types.js';
import { reconcile } from '../src/engine/reconcile.js';
import { accounts, makeInvoice, makePayout, payment } from './helpers.js';

const run = (lines: PayoutLine[], invoices: Invoice[], overrides = {}) =>
  reconcile({ tenantId: 'T1', payout: { ...makePayout('P1', lines), ...overrides }, invoices, accounts });

const refund = (id: string, reference: string, amount: number): PayoutLine => ({
  type: 'refund',
  id,
  reference,
  amount,
  currency: 'SEK',
});

const paid = (id: string, overrides: Partial<Invoice> = {}) =>
  makeInvoice(id, { status: 'paid', balance: 0, ...overrides });

describe('regression: fynd från granskning', () => {
  it('avvisar dubbla faktura-id i indata i stället för att matcha mot fel faktura', () => {
    const result = run(
      [payment('L1', 'R-2', 999)],
      [makeInvoice('X', { reference: 'R-1', total: 100, vatTotal: 20, balance: 100 }), makeInvoice('X', { reference: 'R-2', total: 999, vatTotal: 100, balance: 999 })],
    );
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('DUPLICATE_INVOICE_ID');
    expect(result.commands).toEqual([]);
  });

  it.each([
    ['moms större än total', { total: 100, vatTotal: 150, balance: 100 }],
    ['obetalt större än total', { total: 100, vatTotal: 20, balance: 500 }],
    ['krediterad moms större än fakturans moms', { creditedTotal: 5000, creditedVatTotal: 3000 }],
    ['negativt belopp', { total: -1 }],
    ['betald faktura med obetalt belopp', { status: 'paid' as const, balance: 1 }],
  ])('flaggar ogiltig faktura (%s) som avvikelse utan att kasta', (_name, overrides) => {
    const inv = makeInvoice('A', overrides);
    const lineAmount = inv.status === 'paid' ? 100 : Math.max(inv.balance, 1);
    const lines = inv.status === 'paid' ? [refund('R1', 'REF-A', 50)] : [payment('L1', 'REF-A', lineAmount)];
    expect(() => run(lines, [inv])).not.toThrow();
    const result = run(lines, [inv]);
    expect(result.exceptions.map((e) => e.code)).toContain('INVALID_INVOICE');
    expect(result.commands.filter((c) => c.kind !== 'post_voucher')).toEqual([]);
  });

  it('delkrediteringar ger aldrig negativt netto eller moms större än beloppet (tidigare 161 fall)', () => {
    // Minsta fallet från granskningen: total 5, moms 2, fem krediteringar om 1.
    let state = paid('A', { total: 5, vatTotal: 2 });
    let vatSum = 0;
    for (let step = 1; step <= 5; step++) {
      const result = run([refund(`R${step}`, 'REF-A', 1)], [state]);
      const cmd = result.commands.find((c) => c.kind === 'credit_invoice');
      if (cmd?.kind !== 'credit_invoice') throw new Error(`steg ${step}: ingen kreditering`);
      expect(cmd.net).toBeGreaterThanOrEqual(0);
      expect(cmd.vat).toBeGreaterThanOrEqual(0);
      expect(cmd.net + cmd.vat).toBe(1);
      vatSum += cmd.vat;
      state = { ...state, creditedTotal: state.creditedTotal + 1, creditedVatTotal: state.creditedVatTotal + cmd.vat };
    }
    expect(vatSum).toBe(2);
  });

  it('egenskap: godtyckliga krediteringssekvenser ger exakt fakturamoms och inga negativa delar', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (total, vatShare, weights) => {
          const vatTotal = Math.floor(total * vatShare);
          const sumW = weights.reduce((a, b) => a + b, 0);
          // Dela totalen i delar efter vikterna; sista delen tar resten.
          const parts: number[] = [];
          let left = total;
          for (const [i, w] of weights.entries()) {
            const part = i === weights.length - 1 ? left : Math.min(left, Math.floor((total * w) / sumW));
            parts.push(part);
            left -= part;
          }
          let state = paid('A', { total, vatTotal });
          let vatSum = 0;
          let creditSum = 0;
          for (const [i, part] of parts.entries()) {
            if (part === 0) continue;
            const result = run([refund(`R${i}`, 'REF-A', part)], [state]);
            const cmd = result.commands.find((c) => c.kind === 'credit_invoice');
            if (cmd?.kind !== 'credit_invoice') return false;
            if (cmd.net < 0 || cmd.vat < 0 || cmd.net + cmd.vat !== part) return false;
            vatSum += cmd.vat;
            creditSum += part;
            state = { ...state, creditedTotal: creditSum, creditedVatTotal: vatSum };
          }
          return creditSum === total && vatSum === vatTotal;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('idempotensnycklar kolliderar inte när id innehåller kolon', () => {
    const a = reconcile({
      tenantId: 'T',
      payout: makePayout('P', [payment('X:Y', 'REF-A', 12500)]),
      invoices: [makeInvoice('A')],
      accounts,
    });
    const b = reconcile({
      tenantId: 'T',
      payout: makePayout('P:X', [payment('Y', 'REF-A', 12500)]),
      invoices: [makeInvoice('A')],
      accounts,
    });
    expect(a.commands[0]?.key).not.toBe(b.commands[0]?.key);
  });

  it('verifikatnyckeln kan inte kollidera med en rad som heter "voucher"', () => {
    const result = run([payment('voucher', 'REF-A', 12500)], [makeInvoice('A')]);
    const keys = result.commands.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('avvisar summor som inte kan representeras exakt (tidigare tyst avrundning)', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const lines: PayoutLine[] = [
      payment('L1', 'REF-A', big),
      payment('L2', 'REF-B', 1),
      payment('L3', 'REF-C', 1),
      refund('R1', 'REF-A', 1),
    ];
    const result = run(lines, [], { netAmount: big });
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('INVALID_AMOUNT');
  });

  it('avvisar tom utbetalning i stället för att markera den avstämd', () => {
    const result = run([], [], { netAmount: 0 });
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('EMPTY_PAYOUT');
  });

  it.each([
    ['tomt utbetalnings-id', { id: '' }],
    ['ogiltigt datum', { date: '28/10/2026' }],
  ])('avvisar %s', (_name, overrides) => {
    const result = run([payment('L1', 'REF-A', 12500)], [makeInvoice('A')], overrides);
    expect(result.status).toBe('rejected');
    expect(result.exceptions[0]?.code).toBe('INVALID_PAYOUT');
  });

  it('avvisar rad utan referens och rad med okänd typ utan att kasta', () => {
    expect(run([payment('L1', '  ', 100)], []).exceptions[0]?.code).toBe('INVALID_PAYOUT');
    const weird = [{ type: 'bonus', id: 'Z', currency: 'SEK', amount: 1 }] as unknown as PayoutLine[];
    const payout = { id: 'P1', date: '2026-10-28', currency: 'SEK', netAmount: 0, lines: weird };
    const attempt = () => reconcile({ tenantId: 'T1', payout, invoices: [], accounts });
    expect(attempt).not.toThrow();
    expect(attempt().status).toBe('rejected');
  });

  it('utfallet beror inte på radordningen när två återbetalningar konkurrerar om samma belopp', () => {
    const invoices = [paid('A', { total: 10000, vatTotal: 2000 })];
    const r1 = refund('R1', 'REF-A', 10000);
    const r2 = refund('R2', 'REF-A', 6000);
    const forward = run([r1, r2], invoices);
    const reversed = run([r2, r1], invoices);
    const keysOf = (r: ReturnType<typeof run>) => r.commands.map((c) => c.key).sort();
    expect(keysOf(forward)).toEqual(keysOf(reversed));
    expect(forward.exceptions.map((e) => e.lineId)).toEqual(reversed.exceptions.map((e) => e.lineId));
  });
});
