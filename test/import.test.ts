import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate } from '../src/import/amount.js';
import { CSV_LIMITS, CsvError, detectDelimiter, parseCsv } from '../src/import/csv.js';
import { parseInvoiceCsv } from '../src/import/invoices.js';
import { parsePayoutCsv } from '../src/import/payouts.js';
import { buildServer } from '../src/api/server.js';
import { reconcile } from '../src/engine/reconcile.js';
import { createMemoryStore } from '../src/testing/memory.js';
import { EXAMPLE_ACCOUNTS, previewReconciliation } from '../src/service/preview.js';

describe('parseCsv', () => {
  it('läser enkla filer med semikolon, och tar bort BOM, CRLF och tomma rader', () => {
    const csv = parseCsv('﻿a;b;c\r\n1;2;3\r\n\r\n4;5;6\r\n');
    expect(csv.header).toEqual(['a', 'b', 'c']);
    expect(csv.rows).toEqual([['1', '2', '3'], ['4', '5', '6']]);
    expect(csv.rowNumbers).toEqual([2, 4]);
    expect(csv.delimiter).toBe(';');
  });

  it('läser citerade fält med avgränsare, citattecken och radbrytningar', () => {
    const csv = parseCsv('a;b\n"x;y";"he said ""hi""\nthere"\n');
    expect(csv.rows).toEqual([['x;y', 'he said "hi"\nthere']]);
  });

  it('håller radnumren rätt efter en radbrytning inuti ett citerat fält', () => {
    const csv = parseCsv('a;b\n"1\n2";x\n3;4\n');
    expect(csv.rowNumbers).toEqual([2, 4]);
  });

  it('trimmar celler men låter ett citerat fält behålla sina mellanslag', () => {
    expect(parseCsv('a;b\n  x  ;" y "  \n').rows).toEqual([['x', ' y ']]);
  });

  it('avgör avgränsare från rubrikraden', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('"a,b";c;d')).toBe(';'); // kommat ligger inom citattecken
    expect(detectDelimiter('abc')).toBe(';');
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
  });

  it('avvisar hela filen när en rad har fel antal kolumner (ingen gissning)', () => {
    expect(() => parseCsv('a;b;c\n1;2\n')).toThrow(CsvError);
    try {
      parseCsv('a;b;c\n1;2;3\n1;2\n');
    } catch (error) {
      expect((error as CsvError).row).toBe(3);
      expect((error as Error).message).toContain('2 kolumner');
    }
  });

  it('avvisar en ostängd citering och text efter ett avslutande citattecken', () => {
    expect(() => parseCsv('a;b\n"x;y\n')).toThrow('inte avslutat');
    expect(() => parseCsv('a;b\n"x"y;z\n')).toThrow('Text efter');
    expect(() => parseCsv('')).toThrow('tom');
    expect(() => parseCsv('\n\n')).toThrow('tom');
  });

  it('har gränser mot för stora filer', () => {
    expect(() => parseCsv('a'.repeat(CSV_LIMITS.maxBytes + 1))).toThrow('för stor');
    expect(() => parseCsv(`${Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(';')}\n`)).toThrow('kolumner');
    const rows = 'a\n' + '1\n'.repeat(CSV_LIMITS.maxRows + 1);
    expect(() => parseCsv(rows)).toThrow('rader');
  });

  it('klarar en fil utan avslutande radbrytning', () => {
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']]);
  });
});

describe('parseAmount', () => {
  it.each([
    ['125', 12500],
    ['125,5', 12550],
    ['125.50', 12550],
    ['0,05', 5],
    ['-12,34', -1234],
    ['1 234,56', 123456],
    ['1 234,56', 123456],
    ['-0', 0],
    ['0,00', 0],
  ])('läser %s som %d öre', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it.each(['', ' ', 'abc', '1.234', '1,234,56', '1.234,56', '1,234.56', '12,345', '1e3', '--1', '1,', ',5', '12.3.4', '١٢'])(
    'vägrar att gissa på "%s"',
    (raw) => {
      expect(() => parseAmount(raw)).toThrow(RangeError);
    },
  );

  it('vägrar belopp som inte är säkra heltal', () => {
    expect(() => parseAmount('99999999999999999999')).toThrow('för stort');
  });

  it('läser öre direkt när beloppen redan är i öre', () => {
    expect(parseAmount('12500', { minorUnits: true })).toBe(12500);
    expect(parseAmount('-5', { minorUnits: true })).toBe(-5);
    expect(() => parseAmount('125,00', { minorUnits: true })).toThrow(RangeError);
  });
});

describe('parseDate', () => {
  it('läser riktiga datum och ignorerar klockslag', () => {
    expect(parseDate('2026-11-04')).toBe('2026-11-04');
    expect(parseDate('2026-11-04T10:30:00Z')).toBe('2026-11-04');
    expect(parseDate('2026-11-04 10:30')).toBe('2026-11-04');
    expect(parseDate('04.11.2026', 'dmy')).toBe('2026-11-04');
    expect(parseDate('4/1/2026', 'dmy')).toBe('2026-01-04');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '04.11.2026', '2026/11/04', 'igår', ''])('vägrar "%s"', (raw) => {
    expect(() => parseDate(raw)).toThrow(RangeError);
  });

  it('godtar skottdag bara i skottår', () => {
    expect(parseDate('2028-02-29')).toBe('2028-02-29');
    expect(() => parseDate('2026-02-29')).toThrow(RangeError);
  });

  it('dmy vägrar ett ISO-datum och tvärtom (ingen gissning av ordning)', () => {
    expect(() => parseDate('2026-11-04', 'dmy')).toThrow(RangeError);
  });
});

const HEADER = 'payout_id;payout_date;payout_net;currency;line_id;type;reference;amount;fee_net;fee_vat';
const payoutFile = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('parsePayoutCsv', () => {
  const good = payoutFile(
    'U1;2026-11-04;283,00;SEK;L1;payment;ORDER-1;149,00;2,40;0,60',
    'U1;2026-11-04;283,00;SEK;L2;payment;ORDER-2;139,00;1,60;0,40',
  );

  it('läser en utbetalning med avgifter och räknar rätt', () => {
    const { payouts, problems } = parsePayoutCsv(good);
    expect(problems).toEqual([]);
    expect(payouts).toEqual([
      {
        id: 'U1',
        date: '2026-11-04',
        currency: 'SEK',
        netAmount: 28300,
        lines: [
          { type: 'payment', id: 'L1', reference: 'ORDER-1', amount: 14900, currency: 'SEK', fee: { net: 240, vat: 60 } },
          { type: 'payment', id: 'L2', reference: 'ORDER-2', amount: 13900, currency: 'SEK', fee: { net: 160, vat: 40 } },
        ],
      },
    ]);
  });

  it('ger utbetalningar som motorn godtar (summakontrollen går igenom)', () => {
    const { payouts } = parsePayoutCsv(good);
    const result = reconcile({ tenantId: 'T', payout: payouts[0]!, invoices: [], accounts: EXAMPLE_ACCOUNTS });
    expect(result.exceptions.map((e) => e.code)).toEqual(['NO_MATCH', 'NO_MATCH']); // inte PAYOUT_SUM_MISMATCH
  });

  it('läser återbetalningar (med eller utan minustecken) och fristående avgifter', () => {
    const { payouts, problems } = parsePayoutCsv(
      payoutFile(
        'U1;2026-11-04;-50,00;SEK;L1;refund;ORDER-1;-30,00;;',
        'U1;2026-11-04;-50,00;SEK;L2;credit;ORDER-2;15,00;;',
        'U1;2026-11-04;-50,00;SEK;L3;fee;;;4,00;1,00',
      ),
    );
    expect(problems).toEqual([]);
    expect(payouts[0]?.lines).toEqual([
      { type: 'refund', id: 'L1', reference: 'ORDER-1', amount: 3000, currency: 'SEK' },
      { type: 'refund', id: 'L2', reference: 'ORDER-2', amount: 1500, currency: 'SEK' },
      { type: 'fee', id: 'L3', currency: 'SEK', fee: { net: 400, vat: 100 } },
    ]);
    expect(payouts[0]?.netAmount).toBe(-5000);
  });

  it('översätter en leverantörs egna kolumnnamn, datum, belopp i öre och radtyper', () => {
    const text = [
      'Settlement;Datum;Netto;Valuta;TxId;Typ;Order;Brutto;Avgift;Moms',
      'S-9;04.11.2026;27500;eur;T1;Sale;ORD-7;30000;2000;500',
    ].join('\n');
    const { payouts, problems } = parsePayoutCsv(text, {
      columns: { payoutId: 'Settlement', payoutDate: 'Datum', payoutNet: 'Netto', currency: 'Valuta', lineId: 'TxId', type: 'Typ', reference: 'Order', amount: 'Brutto', feeNet: 'Avgift', feeVat: 'Moms' },
      dateFormat: 'dmy',
      amountsInMinorUnits: true,
    });
    expect(problems).toEqual([]);
    expect(payouts[0]).toMatchObject({ id: 'S-9', date: '2026-11-04', currency: 'EUR', netAmount: 27500 });
    expect(payouts[0]?.lines[0]).toMatchObject({ type: 'payment', amount: 30000, fee: { net: 2000, vat: 500 } });
  });

  it('en leverantörs egna typvärden används, och okända värden avvisar utbetalningen', () => {
    const file = payoutFile('U1;2026-11-04;100,00;SEK;L1;KÖP;ORDER-1;100,00;;');
    expect(parsePayoutCsv(file).problems[0]?.code).toBe('UNKNOWN_TYPE');
    const ok = parsePayoutCsv(file, { typeValues: { payment: ['köp'] } });
    expect(ok.problems).toEqual([]);
    expect(ok.payouts).toHaveLength(1);
  });

  it('utelämnar hela utbetalningen när en rad har ett problem, men inte de andra', () => {
    const { payouts, problems } = parsePayoutCsv(
      payoutFile(
        'GOD;2026-11-04;100,00;SEK;L1;payment;ORDER-1;100,00;;',
        'DAL;2026-11-04;200,00;SEK;L1;payment;ORDER-2;100,00;;',
        'DAL;2026-11-04;200,00;SEK;L2;payment;ORDER-3;1.234;;',
      ),
    );
    expect(payouts.map((p) => p.id)).toEqual(['GOD']);
    expect(problems.map((p) => p.code)).toContain('INVALID_VALUE');
    expect(problems.some((p) => p.subject === 'DAL' && p.code === 'PAYOUT_OMITTED' && p.message.includes('utelämnas helt'))).toBe(true);
  });

  it.each([
    ['saknat utbetalnings-id', ';2026-11-04;100,00;SEK;L1;payment;ORDER-1;100,00;;', 'INVALID_VALUE'],
    ['ogiltigt datum', 'U1;2026-02-30;100,00;SEK;L1;payment;ORDER-1;100,00;;', 'INVALID_VALUE'],
    ['ogiltig valuta', 'U1;2026-11-04;100,00;SE;L1;payment;ORDER-1;100,00;;', 'INVALID_VALUE'],
    ['saknat rad-id', 'U1;2026-11-04;100,00;SEK;;payment;ORDER-1;100,00;;', 'INVALID_VALUE'],
    ['saknad referens', 'U1;2026-11-04;100,00;SEK;L1;payment;;100,00;;', 'INVALID_VALUE'],
    ['negativ betalning', 'U1;2026-11-04;100,00;SEK;L1;payment;ORDER-1;-100,00;;', 'NEGATIVE_AMOUNT'],
    ['negativ avgift', 'U1;2026-11-04;100,00;SEK;L1;payment;ORDER-1;100,00;-1,00;0,00', 'NEGATIVE_AMOUNT'],
    ['avgiftsrad utan avgift', 'U1;2026-11-04;100,00;SEK;L1;fee;;;;', 'INVALID_VALUE'],
    ['tvetydigt belopp', 'U1;2026-11-04;100,00;SEK;L1;payment;ORDER-1;1.234;;', 'INVALID_VALUE'],
  ])('avvisar %s', (_name, row, code) => {
    const { payouts, problems } = parsePayoutCsv(payoutFile(row));
    expect(payouts).toEqual([]);
    expect(problems[0]?.code).toBe(code);
  });

  it('avvisar en utbetalning med olika nettobelopp eller datum på olika rader', () => {
    const { payouts, problems } = parsePayoutCsv(
      payoutFile('U1;2026-11-04;100,00;SEK;L1;payment;ORDER-1;50,00;;', 'U1;2026-11-04;999,00;SEK;L2;payment;ORDER-2;50,00;;'),
    );
    expect(payouts).toEqual([]);
    expect(problems[0]?.code).toBe('INCONSISTENT_PAYOUT');
  });

  it('avvisar ett rad-id som förekommer två gånger i en utbetalning', () => {
    const { problems } = parsePayoutCsv(payoutFile('U1;2026-11-04;100,00;SEK;L1;payment;ORDER-1;50,00;;', 'U1;2026-11-04;100,00;SEK;L1;payment;ORDER-2;50,00;;'));
    expect(problems.map((p) => p.code)).toContain('DUPLICATE_LINE');
  });

  it('avvisar filen med en tydlig förklaring när kolumner saknas, och listar rubrikerna den hittade', () => {
    const { payouts, problems } = parsePayoutCsv('id;belopp\n1;2');
    expect(payouts).toEqual([]);
    expect(problems.map((p) => p.code)).toEqual(Array(6).fill('COLUMN_MISSING'));
    expect(problems[0]?.message).toContain('id, belopp');
  });

  it('avvisar en trasig fil som ett problem, inte som ett undantag', () => {
    const { problems } = parsePayoutCsv('a;b\n1;2;3');
    expect(problems[0]).toMatchObject({ code: 'FILE_INVALID', row: 2 });
  });

  it('kräver nettobeloppet i filen: utan det finns ingen summakontroll att lita på', () => {
    const noNet = 'payout_id;payout_date;currency;line_id;type;reference;amount\nU1;2026-11-04;SEK;L1;payment;ORDER-1;100,00';
    const { problems } = parsePayoutCsv(noNet);
    expect(problems[0]).toMatchObject({ code: 'COLUMN_MISSING' });
    expect(problems[0]?.message).toContain('payout_net');
  });

  it('klarar flera utbetalningar i samma fil, i filens ordning', () => {
    const { payouts } = parsePayoutCsv(
      payoutFile('B;2026-11-05;100,00;SEK;L1;payment;ORDER-1;100,00;;', 'A;2026-11-04;50,00;SEK;L1;payment;ORDER-2;50,00;;'),
    );
    expect(payouts.map((p) => p.id)).toEqual(['B', 'A']);
  });
});

const INVOICE_HEADER = 'invoice_id;reference;currency;total;vat_total;balance;credited_total;credited_vat_total;status';
const invoiceFile = (...rows: string[]) => [INVOICE_HEADER, ...rows].join('\n');

describe('parseInvoiceCsv', () => {
  it('läser fakturor och härleder status från saldot när statuskolumnen saknas', () => {
    const { invoices, problems } = parseInvoiceCsv('invoice_id;reference;currency;total;vat_total;balance\n1;ORDER-1;SEK;149,00;29,80;149,00\n2;ORDER-2;SEK;59,90;11,98;0,00');
    expect(problems).toEqual([]);
    expect(invoices).toEqual([
      { id: '1', reference: 'ORDER-1', currency: 'SEK', total: 14900, vatTotal: 2980, balance: 14900, creditedTotal: 0, creditedVatTotal: 0, status: 'open' },
      { id: '2', reference: 'ORDER-2', currency: 'SEK', total: 5990, vatTotal: 1198, balance: 0, creditedTotal: 0, creditedVatTotal: 0, status: 'paid' },
    ]);
  });

  it('läser status, krediterade belopp och egna statusvärden', () => {
    const { invoices, problems } = parseInvoiceCsv(invoiceFile('1;ORDER-1;SEK;100,00;20,00;0,00;10,00;2,00;Betald', '2;ORDER-2;SEK;50,00;10,00;50,00;;;Makulerad'));
    expect(problems).toEqual([]);
    expect(invoices[0]).toMatchObject({ status: 'paid', creditedTotal: 1000, creditedVatTotal: 200 });
    expect(invoices[1]).toMatchObject({ status: 'cancelled', creditedTotal: 0 });
    const own = parseInvoiceCsv(invoiceFile('1;ORDER-1;SEK;100,00;20,00;100,00;;;Utestående'), { statusValues: { open: ['utestående'] } });
    expect(own.invoices[0]?.status).toBe('open');
  });

  it('utelämnar en faktura med okänd status eller ogiltigt belopp, och säger varför', () => {
    const { invoices, problems } = parseInvoiceCsv(invoiceFile('1;ORDER-1;SEK;100,00;20,00;100,00;;;Vilande', '2;ORDER-2;SEK;1.234;20,00;100,00;;;open', '3;ORDER-3;SEK;100,00;20,00;100,00;;;open'));
    expect(invoices.map((i) => i.id)).toEqual(['3']);
    expect(problems.map((p) => p.code)).toEqual(['UNKNOWN_STATUS', 'INVALID_VALUE']);
  });

  it('använder ingen av två rader med samma faktura-id', () => {
    const { invoices, problems } = parseInvoiceCsv(invoiceFile('1;ORDER-1;SEK;100,00;20,00;100,00;;;open', '1;ORDER-9;SEK;999,00;20,00;999,00;;;open', '2;ORDER-2;SEK;50,00;10,00;50,00;;;open'));
    expect(invoices.map((i) => i.id)).toEqual(['2']);
    expect(problems.map((p) => p.code)).toEqual(['DUPLICATE_INVOICE']);
  });

  it('avvisar filen när obligatoriska kolumner saknas eller filen är trasig', () => {
    expect(parseInvoiceCsv('a;b\n1;2').problems.every((p) => p.code === 'COLUMN_MISSING')).toBe(true);
    expect(parseInvoiceCsv('a;b\n"1;2').problems[0]?.code).toBe('FILE_INVALID');
  });
});

describe('previewReconciliation', () => {
  const invoices = parseInvoiceCsv(
    invoiceFile('A;ORDER-A;SEK;125,00;25,00;125,00;;;open', 'B;ORDER-B;SEK;125,00;25,00;125,00;;;open', 'C;ORDER-C;SEK;200,00;40,00;200,00;;;open', 'E;ORDER-E;EUR;100,00;20,00;100,00;;;open'),
  ).invoices;
  const payouts = (text: string) => parsePayoutCsv(text).payouts;

  it('ger träffsäkerhet och avvikelser, och påverkar inget annat', () => {
    const preview = previewReconciliation({
      invoices,
      payouts: payouts(
        payoutFile(
          'U1;2026-11-04;250,00;SEK;L1;payment;ORDER-A;125,00;;',
          'U1;2026-11-04;250,00;SEK;L2;payment;ORDER-B;125,00;;',
          'U2;2026-11-05;300,00;SEK;L1;payment;ORDER-C;200,00;;',
          'U2;2026-11-05;300,00;SEK;L2;payment;ORDER-SAKNAS;100,00;;',
        ),
      ),
    });
    expect(preview.payouts.map((p) => [p.payoutId, p.status, p.matchedLines, p.unmatchedLines])).toEqual([
      ['U1', 'complete', 2, 0],
      ['U2', 'partial', 1, 1],
    ]);
    expect(preview.summary.payouts).toEqual({ total: 2, complete: 1, partial: 1, rejected: 0 });
    expect(preview.summary.lineMatchRate).toBeCloseTo(3 / 4);
    expect(preview.payouts[1]?.exceptions).toEqual([{ code: 'NO_MATCH', lineId: 'L2', message: expect.stringContaining('ORDER-SAKNAS') }]);
  });

  it('två utbetalningar mot samma faktura: den andra ser den som redan betald', () => {
    const preview = previewReconciliation({
      invoices,
      payouts: payouts(payoutFile('U1;2026-11-04;125,00;SEK;L1;payment;ORDER-A;125,00;;', 'U2;2026-11-05;125,00;SEK;L1;payment;ORDER-A;125,00;;')),
    });
    expect(preview.payouts.map((p) => [p.payoutId, p.status])).toEqual([['U1', 'complete'], ['U2', 'partial']]);
    expect(preview.payouts[1]?.exceptions[0]?.code).toBe('INVOICE_NOT_OPEN');
  });

  it('kör i datum- och id-ordning oavsett filens ordning', () => {
    const file = payoutFile('LATE;2026-11-06;125,00;SEK;L1;payment;ORDER-A;125,00;;', 'EARLY;2026-11-04;125,00;SEK;L1;payment;ORDER-A;125,00;;');
    const preview = previewReconciliation({ invoices, payouts: payouts(file) });
    expect(preview.payouts.map((p) => [p.payoutId, p.status])).toEqual([['EARLY', 'complete'], ['LATE', 'partial']]);
  });

  it('en återbetalning efter en betalning av samma faktura krediterar den', () => {
    const preview = previewReconciliation({
      invoices,
      payouts: payouts(
        payoutFile('U1;2026-11-04;125,00;SEK;L1;payment;ORDER-A;125,00;;', 'U2;2026-11-05;-25,00;SEK;L1;refund;ORDER-A;25,00;;'),
      ),
    });
    expect(preview.payouts.map((p) => p.status)).toEqual(['complete', 'complete']);
  });

  it('delbetalningar bara när det anges', () => {
    const file = payouts(payoutFile('U1;2026-11-04;50,00;SEK;L1;payment;ORDER-A;50,00;;'));
    expect(previewReconciliation({ invoices, payouts: file }).payouts[0]?.status).toBe('partial');
    expect(previewReconciliation({ invoices, payouts: file, allowPartialPayments: true }).payouts[0]?.status).toBe('complete');
  });

  it('en EUR-utbetalning utan EUR-konton blir delvis, och med konton klar', () => {
    const file = payouts(payoutFile('U1;2026-11-04;100,00;EUR;L1;payment;ORDER-E;100,00;;'));
    expect(previewReconciliation({ invoices, payouts: file }).payouts[0]?.exceptions.map((e) => e.code)).toEqual(['ACCOUNTS_MISSING']);
    const accounts = { ...EXAMPLE_ACCOUNTS, foreign: { EUR: { bank: 1932, clearing: 1582, feeExpense: 6571, feeVat: 2642 } } };
    expect(previewReconciliation({ invoices, payouts: file, accounts }).payouts[0]?.status).toBe('complete');
  });

  it('ändrar inte indata och är deterministisk', () => {
    const p = payouts(payoutFile('U1;2026-11-04;125,00;SEK;L1;payment;ORDER-A;125,00;;'));
    const before = JSON.stringify([invoices, p]);
    const a = previewReconciliation({ invoices, payouts: p });
    const b = previewReconciliation({ invoices, payouts: p });
    expect(a).toEqual(b);
    expect(JSON.stringify([invoices, p])).toBe(before);
  });

  it('klarar tomma indata', () => {
    expect(previewReconciliation({ invoices: [], payouts: [] })).toMatchObject({ payouts: [], summary: { payouts: { total: 0 }, lineMatchRate: null } });
  });
});

describe('POST /v1/preview', () => {
  const PAYOUTS = payoutFile(
    'U1;2026-11-04;250,00;SEK;L1;payment;ORDER-A;125,00;;',
    'U1;2026-11-04;250,00;SEK;L2;payment;ORDER-B;125,00;;',
    'U2;2026-11-05;100,00;SEK;L1;payment;ORDER-SAKNAS;100,00;;',
  );
  const INVOICES = invoiceFile('A;ORDER-A;SEK;125,00;25,00;125,00;;;open', 'B;ORDER-B;SEK;125,00;25,00;125,00;;;open');

  async function api() {
    const store = createMemoryStore();
    const server = buildServer({
      ...store,
      authenticateDetailed: async (k) => ({ viewer: { tenantId: 'T1', keyId: 'v', role: 'viewer' as const }, operator: { tenantId: 'T1', keyId: 'o', role: 'operator' as const } })[k] ?? null,
      authenticate: async () => 'T1',
      clock: { now: () => new Date('2026-11-04T10:00:00Z') },
      rateLimit: false,
    });
    const post = (payload: unknown, key = 'operator') => server.inject({ method: 'POST', url: '/v1/preview', headers: { 'x-api-key': key }, payload: payload as object });
    return { server, store, post };
  }

  it('ger träffsäkerhet från två filer, och sparar ingenting', async () => {
    const { post, store } = await api();
    const r = await post({ payoutsCsv: PAYOUTS, invoicesCsv: INVOICES });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.summary.payouts).toEqual({ total: 2, complete: 1, partial: 1, rejected: 0 });
    expect(body.payouts.map((p: { payoutId: string; status: string }) => [p.payoutId, p.status])).toEqual([['U1', 'complete'], ['U2', 'partial']]);
    expect(body.files.payouts).toMatchObject({ rows: 3, accepted: 2, problems: [] });
    expect(body.files.invoices).toMatchObject({ rows: 2, accepted: 2, problems: [] });
    // Inget har lagts i någon kö eller lista.
    expect(await store.payouts.list('T1')).toEqual([]);
    expect(await store.proposals.list('T1')).toEqual([]);
    expect(await store.exceptions.list('T1')).toEqual([]);
  });

  it('rapporterar problem i filerna i stället för att gissa', async () => {
    const { post } = await api();
    const body = (await post({ payoutsCsv: payoutFile('U1;2026-11-04;100,00;SEK;L1;payment;ORDER-A;1.234;;'), invoicesCsv: INVOICES })).json();
    expect(body.files.payouts.accepted).toBe(0);
    expect(body.files.payouts.problems[0].code).toBe('INVALID_VALUE');
    expect(body.payouts).toEqual([]);
  });

  it('tar emot en leverantörs egna kolumnnamn och format', async () => {
    const { post } = await api();
    const r = await post({
      payoutsCsv: 'S;D;N;V;T;K;O;B\nS1;04.11.2026;12500;SEK;T1;sale;ORDER-A;12500',
      payoutsMapping: { columns: { payoutId: 'S', payoutDate: 'D', payoutNet: 'N', currency: 'V', lineId: 'T', type: 'K', reference: 'O', amount: 'B' }, dateFormat: 'dmy', amountsInMinorUnits: true },
      invoicesCsv: INVOICES,
    });
    expect(r.json().summary.payouts.complete).toBe(1);
  });

  it('kräver minst rollen operator och en giltig nyckel', async () => {
    const { post, server } = await api();
    expect((await post({ payoutsCsv: PAYOUTS, invoicesCsv: INVOICES }, 'viewer')).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/v1/preview', payload: { payoutsCsv: 'a', invoicesCsv: 'b' } })).statusCode).toBe(401);
  });

  it.each([
    ['saknade filer', {}],
    ['tom fil', { payoutsCsv: '', invoicesCsv: INVOICES }],
    ['okänt fält', { payoutsCsv: PAYOUTS, invoicesCsv: INVOICES, extra: 1 }],
    ['okänd kolumn i mappningen', { payoutsCsv: PAYOUTS, invoicesCsv: INVOICES, payoutsMapping: { columns: { hemlig: 'x' } } }],
    ['ogiltig avgränsare', { payoutsCsv: PAYOUTS, invoicesCsv: INVOICES, payoutsMapping: { delimiter: '|' } }],
    ['ogiltigt konto', { payoutsCsv: PAYOUTS, invoicesCsv: INVOICES, accounts: { bank: 1, clearing: 1580, feeExpense: 6570, feeVat: 2641 } }],
    ['filen för stor', { payoutsCsv: 'a'.repeat(5_000_001), invoicesCsv: INVOICES }],
  ])('avvisar %s med 400', async (_name, payload) => {
    const { post } = await api();
    expect((await post(payload)).statusCode).toBe(400);
  });

  it('en trasig fil ger ett begripligt problem, inte ett serverfel', async () => {
    const { post } = await api();
    const r = await post({ payoutsCsv: 'a;b\n1;2;3', invoicesCsv: INVOICES });
    expect(r.statusCode).toBe(200);
    expect(r.json().files.payouts.problems[0].code).toBe('FILE_INVALID');
  });

  it('begränsar hur många problem som returneras', async () => {
    const { post } = await api();
    const rows = Array.from({ length: 500 }, (_, i) => `U${i};2026-11-04;100,00;SEK;L1;payment;ORDER-${i};1.234;;`);
    const body = (await post({ payoutsCsv: payoutFile(...rows), invoicesCsv: INVOICES })).json();
    expect(body.files.payouts.problems).toHaveLength(200);
    expect(body.files.payouts.problemsTruncated).toBe(true);
  });

  it('tar emot en stor fil (över standardgränsen för en kropp)', async () => {
    const { post } = await api();
    const rows = Array.from({ length: 20_000 }, (_, i) => `U${Math.floor(i / 4)};2026-11-04;0,00;SEK;L${i};payment;ORDER-${i};0,00;;`);
    const r = await post({ payoutsCsv: payoutFile(...rows), invoicesCsv: INVOICES });
    expect(r.statusCode).toBe(200);
  });
});

describe('npm run preview (terminalverktyget)', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/preview.ts', ...args], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000 });

  it('provkör exempelfilerna och skriver träffsäkerhet, avvikelser och att inget sparats', () => {
    const r = run(['docs/exempel/utbetalningar.csv', 'docs/exempel/fakturor.csv']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('80 % (4 av 5)');
    expect(r.stdout).toContain('67 % (2 av 3)');
    expect(r.stdout).toContain('NO_MATCH (rad T6)');
    expect(r.stdout).toContain('Ingenting har sparats eller bokförts');
  });

  it('visar användning och avslutar med fel utan filer, med okänd flagga eller med en fil som saknas', () => {
    for (const args of [[], ['bara-en.csv'], ['a.csv', 'b.csv', '--okand'], ['finns-inte.csv', 'docs/exempel/fakturor.csv']]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/Användning|Okänd flagga|Kunde inte läsa/);
    }
  });
});
