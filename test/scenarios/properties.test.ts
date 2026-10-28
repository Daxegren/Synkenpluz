import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate } from '../../src/domain/money.js';
import type { Invoice, PayoutLine, ReconcileInput } from '../../src/domain/types.js';
import { reconcile } from '../../src/engine/reconcile.js';
import { byKind, commandSet, feeLine, invoice, makeInput, netOf, voucherBalance } from './helpers.js';

const RUNS = { numRuns: 200 };

/** Ett fall: en faktura med exakt matchande betalning och ev. avgift. */
interface PayCase {
  total: number;
  vat: number;
  fee: { net: number; vat: number } | null;
}

const payCase = fc
  .integer({ min: 1, max: 5_000_000 })
  .chain((total) =>
    fc.record({
      total: fc.constant(total),
      vat: fc.integer({ min: 0, max: total }),
      fee: fc.option(
        fc
          .integer({ min: 0, max: Math.min(total, 100_000) })
          .chain((sum) =>
            fc.integer({ min: 0, max: sum }).map((net) => ({ net, vat: sum - net })),
          ),
        { nil: null },
      ),
    }),
  );

/** Fristående avgiftsrader. */
const standaloneFees = fc.array(
  fc.record({ net: fc.integer({ min: 0, max: 50_000 }), vat: fc.integer({ min: 0, max: 20_000 }) }),
  { maxLength: 3 },
);

interface Scenario {
  input: ReconcileInput;
  expectedPayments: number;
  expectedRefunds: number;
}

/**
 * Bygger en giltig utbetalning: n betalningar, k återbetalningar mot redan betalda
 * fakturor (en per faktura) och fristående avgifter. Bara nettot måste täckas av
 * betalningar i samma utbetalning, så netAmount kan bli negativt (det är giltigt).
 */
const validScenario = fc
  .record({
    pays: fc.array(payCase, { minLength: 1, maxLength: 8 }),
    refunds: fc.array(
      fc.integer({ min: 2, max: 2_000_000 }).chain((total) =>
        fc.record({
          total: fc.constant(total),
          vat: fc.integer({ min: 0, max: total }),
          amount: fc.integer({ min: 1, max: total }),
        }),
      ),
      { maxLength: 4 },
    ),
    fees: standaloneFees,
  })
  .map(({ pays, refunds, fees }): Scenario => {
    const invoices: Invoice[] = [];
    const lines: PayoutLine[] = [];
    pays.forEach((p, i) => {
      invoices.push(invoice({ id: `P${i}`, total: p.total, vatTotal: p.vat, balance: p.total }));
      lines.push({
        type: 'payment',
        id: `pay${i}`,
        reference: `REF-P${i}`,
        amount: p.total,
        currency: 'SEK',
        ...(p.fee ? { fee: p.fee } : {}),
      });
    });
    refunds.forEach((r, i) => {
      invoices.push(invoice({ id: `R${i}`, total: r.total, vatTotal: r.vat, balance: 0, status: 'paid' }));
      lines.push({ type: 'refund', id: `ref${i}`, reference: `REF-R${i}`, amount: r.amount, currency: 'SEK' });
    });
    fees.forEach((f, i) => lines.push(feeLine(`fee${i}`, f.net, f.vat)));
    return {
      input: makeInput(lines, invoices),
      expectedPayments: pays.length,
      expectedRefunds: refunds.length,
    };
  });

describe('egenskap (a): giltig utbetalning blir complete och balanserar', () => {
  it('status complete, balanserat verifikat, summor stämmer mot raderna', () => {
    fc.assert(
      fc.property(validScenario, ({ input, expectedPayments, expectedRefunds }) => {
        const result = reconcile(input);
        expect(result.exceptions).toEqual([]);
        expect(result.status).toBe('complete');

        const { debit, credit } = voucherBalance(result);
        expect(debit).toBe(credit);

        const payCmds = byKind(result, 'register_invoice_payment');
        const creditCmds = byKind(result, 'credit_invoice');
        expect(payCmds).toHaveLength(expectedPayments);
        expect(creditCmds).toHaveLength(expectedRefunds);

        const lines = input.payout.lines;
        const sumPayLines = lines.reduce((s, l) => (l.type === 'payment' ? s + l.amount : s), 0);
        const sumRefundLines = lines.reduce((s, l) => (l.type === 'refund' ? s + l.amount : s), 0);
        expect(payCmds.reduce((s, c) => s + c.amount, 0)).toBe(sumPayLines);
        expect(creditCmds.reduce((s, c) => s + c.amount, 0)).toBe(sumRefundLines);

        // Verifikatets bankrad motsvarar utbetalt netto (tecken: debet om positivt).
        const voucher = result.commands.find((c) => c.kind === 'post_voucher');
        if (voucher && voucher.kind === 'post_voucher') {
          const bank = voucher.lines.find((l) => l.account === input.accounts.bank);
          const signed = bank ? bank.debit - bank.credit : 0;
          expect(signed).toBe(input.payout.netAmount);
          const clearing = voucher.lines.find((l) => l.account === input.accounts.clearing);
          const clearingSigned = clearing ? clearing.credit - clearing.debit : 0;
          expect(clearingSigned).toBe(sumPayLines - sumRefundLines);
        }
        expect(netOf(lines)).toBe(input.payout.netAmount);
      }),
      RUNS,
    );
  });
});

describe('egenskap (b): idempotensnycklar är unika', () => {
  it('inga dubbletter bland nycklarna, och alla har tenant och payout-prefix', () => {
    fc.assert(
      fc.property(validScenario, fc.stringMatching(/^[A-Za-z0-9]{1,6}$/), ({ input }, tenant) => {
        const result = reconcile({ ...input, tenantId: tenant });
        const keys = result.commands.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) expect(k.startsWith(`${tenant}:${input.payout.id}:`)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('egenskap (c): determinism och ingen mutation', () => {
  it('samma indata två gånger ger identiskt resultat och indata är oförändrad', () => {
    fc.assert(
      fc.property(validScenario, ({ input }) => {
        const before = structuredClone(input);
        const first = reconcile(input);
        const second = reconcile(input);
        expect(second).toEqual(first);
        expect(input).toEqual(before);
        // Resultatet delar inga objekt med indata (ingen aliasing som kan muteras i efterhand).
        for (const c of first.commands) {
          if (c.kind === 'post_voucher') expect(input.payout.lines as unknown[]).not.toContain(c.lines);
        }
      }),
      RUNS,
    );
  });

  it('mutation av resultatet påverkar inte nästa körning', () => {
    fc.assert(
      fc.property(validScenario, ({ input }) => {
        const first = reconcile(input);
        const snapshot = structuredClone(first);
        for (const c of first.commands) c.key = 'MUTERAD';
        expect(reconcile(input)).toEqual(snapshot);
      }),
      RUNS,
    );
  });
});

describe('egenskap (d): radordning ger samma mängd kommandon', () => {
  it('permutation av rader', () => {
    fc.assert(
      fc.property(
        validScenario.chain((s) =>
          fc.tuple(
            fc.constant(s),
            fc.shuffledSubarray([...s.input.payout.lines], {
              minLength: s.input.payout.lines.length,
              maxLength: s.input.payout.lines.length,
            }),
            fc.shuffledSubarray([...s.input.invoices], {
              minLength: s.input.invoices.length,
              maxLength: s.input.invoices.length,
            }),
          ),
        ),
        ([s, lines, invoices]) => {
          const base = reconcile(s.input);
          const permuted = reconcile({ ...s.input, invoices, payout: { ...s.input.payout, lines } });
          expect(permuted.status).toBe(base.status);
          expect(commandSet(permuted)).toEqual(commandSet(base));
        },
      ),
      RUNS,
    );
  });
});

describe('egenskap (e): fel netAmount avvisas', () => {
  it('rejected utan kommandon, med PAYOUT_SUM_MISMATCH', () => {
    fc.assert(
      fc.property(
        validScenario,
        fc.integer({ min: 1, max: 1_000_000 }).chain((d) => fc.constantFrom(d, -d)),
        ({ input }, delta) => {
          const bad = { ...input, payout: { ...input.payout, netAmount: input.payout.netAmount + delta } };
          const result = reconcile(bad);
          expect(result.status).toBe('rejected');
          expect(result.commands).toEqual([]);
          expect(result.exceptions.map((e) => e.code)).toEqual(['PAYOUT_SUM_MISMATCH']);
        },
      ),
      RUNS,
    );
  });

  it('icke-heltal och NaN som netAmount avvisas också', () => {
    fc.assert(
      fc.property(validScenario, fc.constantFrom(NaN, Infinity, -Infinity, 0.5, 1e300), ({ input }, bad) => {
        const result = reconcile({ ...input, payout: { ...input.payout, netAmount: bad } });
        expect(result.status).toBe('rejected');
        expect(result.commands).toEqual([]);
      }),
      RUNS,
    );
  });
});

/** Delar `total` i slumpade positiva delar. */
function partition(total: number, cuts: number[]): number[] {
  const points = [...new Set(cuts.map((c) => (c % (total - 1)) + 1))].sort((a, b) => a - b);
  const parts: number[] = [];
  let prev = 0;
  for (const p of [...points, total]) {
    parts.push(p - prev);
    prev = p;
  }
  return parts.filter((p) => p > 0);
}

const creditCase = fc
  .integer({ min: 2, max: 2_000_000 })
  .chain((total) =>
    fc.record({
      total: fc.constant(total),
      vat: fc.integer({ min: 0, max: total }),
      cuts: fc.array(fc.nat(), { maxLength: 8 }),
    }),
  );

/** Kör varje del som en egen utbetalning och för över kreditstatus mellan stegen. */
function creditInSteps(total: number, vat: number, parts: number[]) {
  let credited = 0;
  let creditedVat = 0;
  const out: ReturnType<typeof byKind<'credit_invoice'>> = [];
  parts.forEach((amount, i) => {
    const inv = invoice({
      id: 'X',
      total,
      vatTotal: vat,
      balance: 0,
      status: 'paid',
      creditedTotal: credited,
      creditedVatTotal: creditedVat,
    });
    const lines: PayoutLine[] = [{ type: 'refund', id: `r${i}`, reference: 'REF-X', amount, currency: 'SEK' }];
    const result = reconcile(makeInput(lines, [inv], { id: `PO-${i}` }));
    expect(result.status).toBe('complete');
    const [cmd] = byKind(result, 'credit_invoice');
    expect(cmd).toBeDefined();
    out.push(cmd!);
    credited += cmd!.amount;
    creditedVat += cmd!.vat;
  });
  return out;
}

describe('egenskap (f): kreditering', () => {
  it('moms + netto = belopp, moms inom [0, belopp], och delarnas moms summerar till fakturans moms', () => {
    fc.assert(
      fc.property(creditCase, ({ total, vat, cuts }) => {
        const parts = partition(total, cuts);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        const cmds = creditInSteps(total, vat, parts);
        for (const c of cmds) {
          expect(c.vat + c.net).toBe(c.amount);
          expect(c.vat).toBeGreaterThanOrEqual(0);
        }
        expect(cmds.reduce((s, c) => s + c.vat, 0)).toBe(vat);
        expect(cmds.reduce((s, c) => s + c.amount, 0)).toBe(total);
        expect(cmds.at(-1)!.mode).toBe(parts.length === 1 ? 'full' : 'partial');
      }),
      RUNS,
    );
  });

  it('flera delkrediteringar på samma faktura i en och samma utbetalning', () => {
    fc.assert(
      fc.property(creditCase, ({ total, vat, cuts }) => {
        const parts = partition(total, cuts);
        const lines: PayoutLine[] = parts.map((a, i) => ({
          type: 'refund',
          id: `r${i}`,
          reference: 'REF-X',
          amount: a,
          currency: 'SEK',
        }));
        const result = reconcile(
          makeInput(lines, [invoice({ id: 'X', total, vatTotal: vat, balance: 0, status: 'paid' })]),
        );
        expect(result.status).toBe('complete');
        const cmds = byKind(result, 'credit_invoice');
        expect(cmds.reduce((s, c) => s + c.vat, 0)).toBe(vat);
        expect(cmds.every((c) => c.vat + c.net === c.amount)).toBe(true);
      }),
      RUNS,
    );
  });

  it('kreditering över kvarvarande belopp avvisas som REFUND_EXCEEDS_INVOICE', () => {
    fc.assert(
      fc.property(creditCase, fc.integer({ min: 1, max: 1000 }), ({ total, vat }, extra) => {
        const lines: PayoutLine[] = [
          { type: 'refund', id: 'r', reference: 'REF-X', amount: total + extra, currency: 'SEK' },
        ];
        const result = reconcile(
          makeInput(lines, [invoice({ id: 'X', total, vatTotal: vat, balance: 0, status: 'paid' })]),
        );
        expect(result.status).toBe('partial');
        expect(result.exceptions[0]?.code).toBe('REFUND_EXCEEDS_INVOICE');
        expect(result.commands).toEqual([]);
      }),
      RUNS,
    );
  });

  // Regression: tidigare gav sista delkrediteringen all kvarvarande moms, även när beloppet var
  // mindre, vilket kunde ge negativt netto (t.ex. total 1000, moms 250, 1000 krediteringar à 1).
  it('netto och moms på en delkreditering är aldrig negativa och moms <= belopp', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 400 }).chain((total) =>
          fc.record({ total: fc.constant(total), vat: fc.integer({ min: 1, max: total }) }),
        ),
        ({ total, vat }) => {
          const cmds = creditInSteps(total, vat, Array<number>(total).fill(1));
          for (const c of cmds) {
            expect(c.net).toBeGreaterThanOrEqual(0);
            expect(c.vat).toBeLessThanOrEqual(c.amount);
          }
          expect(cmds.reduce((s, c) => s + c.vat, 0)).toBe(vat);
        },
      ),
      RUNS,
    );
  });
});

describe('egenskap (g): allocate()', () => {
  const weights = fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 1, maxLength: 10 }).filter(
    (w) => w.some((x) => x > 0),
  );

  it('summan blir exakt total och alla delar är icke-negativa heltal', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), weights, (total, w) => {
        const parts = allocate(total, w);
        expect(parts).toHaveLength(w.length);
        expect(parts.every((p) => Number.isSafeInteger(p) && p >= 0)).toBe(true);
        expect(parts.reduce((a, b) => a + BigInt(b), 0n)).toBe(BigInt(total));
      }),
      RUNS,
    );
  });

  it('delen avviker högst 1 från exakt proportion, och noll-vikt ger noll', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), weights, (total, w) => {
        const parts = allocate(total, w);
        const sum = w.reduce((a, b) => a + BigInt(b), 0n);
        parts.forEach((p, i) => {
          const exactFloor = (BigInt(total) * BigInt(w[i]!)) / sum;
          expect(BigInt(p) - exactFloor === 0n || BigInt(p) - exactFloor === 1n).toBe(true);
          if (w[i] === 0) expect(p).toBe(0);
        });
      }),
      RUNS,
    );
  });

  it('är deterministisk och kastar för ogiltig indata', () => {
    expect(allocate(7, [1, 1, 1])).toEqual(allocate(7, [1, 1, 1]));
    expect(() => allocate(-1, [1])).toThrow(RangeError);
    expect(() => allocate(1, [])).toThrow(RangeError);
    expect(() => allocate(1, [0, 0])).toThrow(RangeError);
    expect(() => allocate(1, [-1, 2])).toThrow(RangeError);
    expect(() => allocate(1.5, [1])).toThrow(RangeError);
  });
});
