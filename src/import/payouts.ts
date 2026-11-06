import type { Fee, Payout, PayoutLine } from '../domain/types.js';
import { parseAmount, parseDate, type DateFormat } from './amount.js';
import { CsvError, parseCsv, type Delimiter } from './csv.js';

/**
 * Läser en utbetalningsfil (en rad per transaktion) till våra normaliserade utbetalningar. Formatet är vårt eget och
 * dokumenterat i docs/PROVKORNING.md; `mapping` låter en leverantörs egna kolumnnamn och värden översättas till det.
 *
 * Princip: en utbetalning läses helt eller inte alls. Har en enda rad ett problem utelämnas hela utbetalningen och
 * problemet rapporteras, i stället för att en halv utbetalning stäms av. Utbetalningens nettobelopp krävs i filen, eftersom
 * summakontrollen annars vore meningslös (ett belopp vi själva räknat fram stämmer alltid).
 */

export type PayoutColumn = 'payoutId' | 'payoutDate' | 'payoutNet' | 'currency' | 'lineId' | 'type' | 'reference' | 'amount' | 'feeNet' | 'feeVat';

export const DEFAULT_PAYOUT_COLUMNS: Record<PayoutColumn, string> = {
  payoutId: 'payout_id',
  payoutDate: 'payout_date',
  payoutNet: 'payout_net',
  currency: 'currency',
  lineId: 'line_id',
  type: 'type',
  reference: 'reference',
  amount: 'amount',
  feeNet: 'fee_net',
  feeVat: 'fee_vat',
};

export const DEFAULT_TYPE_VALUES: Record<'payment' | 'refund' | 'fee', string[]> = {
  payment: ['payment', 'sale', 'capture', 'purchase', 'betalning'],
  refund: ['refund', 'credit', 'återbetalning'],
  fee: ['fee', 'avgift'],
};

export interface PayoutCsvMapping {
  /** Leverantörens kolumnnamn per fält (skiftlägesokänsligt). Utelämnade fält använder `DEFAULT_PAYOUT_COLUMNS`. */
  columns?: Partial<Record<PayoutColumn, string>>;
  /** Avgränsare. Utan den avgörs den av rubrikraden. */
  delimiter?: Delimiter;
  dateFormat?: DateFormat;
  /** Beloppen är redan i öre. Standard: kronor med högst två decimaler. */
  amountsInMinorUnits?: boolean;
  /** Leverantörens värden för radtyp (skiftlägesokänsligt). Utelämnade typer använder `DEFAULT_TYPE_VALUES`. */
  typeValues?: Partial<Record<'payment' | 'refund' | 'fee', string[]>>;
}

export type ImportProblemCode =
  | 'FILE_INVALID'
  | 'COLUMN_MISSING'
  | 'INVALID_VALUE'
  | 'UNKNOWN_TYPE'
  | 'INCONSISTENT_PAYOUT'
  | 'DUPLICATE_LINE'
  | 'NEGATIVE_AMOUNT'
  | 'DUPLICATE_INVOICE'
  | 'UNKNOWN_STATUS'
  /** Följdnotis: utbetalningen utelämnas eftersom en av dess rader har ett problem. Räknas inte som ett eget problem. */
  | 'PAYOUT_OMITTED';

export interface ImportProblem {
  code: ImportProblemCode;
  /** Radnummer i filen (1 = rubrikraden). */
  row?: number;
  /** Utbetalningen eller fakturan som problemet gäller, om den går att avgöra. */
  subject?: string;
  message: string;
}

export interface ParsedPayouts {
  payouts: Payout[];
  problems: ImportProblem[];
  /** Antal datarader i filen. */
  rows: number;
}

const REQUIRED: PayoutColumn[] = ['payoutId', 'payoutDate', 'payoutNet', 'currency', 'lineId', 'type'];

export function parsePayoutCsv(text: string, mapping: PayoutCsvMapping = {}): ParsedPayouts {
  let csv;
  try {
    csv = parseCsv(text, mapping.delimiter);
  } catch (error) {
    if (error instanceof CsvError) return { payouts: [], rows: 0, problems: [{ code: 'FILE_INVALID', ...(error.row !== undefined ? { row: error.row } : {}), message: error.message }] };
    throw error;
  }

  const names = { ...DEFAULT_PAYOUT_COLUMNS, ...mapping.columns };
  const index = new Map(csv.header.map((h, i) => [h.toLowerCase(), i]));
  const col = (c: PayoutColumn): number | undefined => index.get(names[c].toLowerCase());

  const missing = REQUIRED.filter((c) => col(c) === undefined);
  if (missing.length > 0) {
    return {
      payouts: [],
      rows: csv.rows.length,
      problems: missing.map((c) => ({ code: 'COLUMN_MISSING' as const, message: `Kolumnen "${names[c]}" (${c}) saknas i filen. Rubriker i filen: ${csv.header.join(', ')}` })),
    };
  }

  const typeOf = (value: string): 'payment' | 'refund' | 'fee' | null => {
    const v = value.toLowerCase();
    for (const kind of ['payment', 'refund', 'fee'] as const) {
      if ((mapping.typeValues?.[kind] ?? DEFAULT_TYPE_VALUES[kind]).some((x) => x.toLowerCase() === v)) return kind;
    }
    return null;
  };
  const minorUnits = mapping.amountsInMinorUnits === true;
  const dateFormat = mapping.dateFormat ?? 'iso';

  interface Draft {
    id: string;
    date: string;
    net: number;
    currency: string;
    lines: PayoutLine[];
    lineIds: Set<string>;
    bad: boolean;
  }
  const drafts = new Map<string, Draft>();
  const problems: ImportProblem[] = [];
  const reported = new Set<string>();

  csv.rows.forEach((cells, i) => {
    const row = csv.rowNumbers[i]!;
    const get = (c: PayoutColumn): string => {
      const at = col(c);
      return at === undefined ? '' : (cells[at] ?? '');
    };
    const payoutId = get('payoutId');
    const fail = (code: ImportProblemCode, message: string) => {
      const draft = payoutId ? drafts.get(payoutId) : undefined;
      if (draft) draft.bad = true;
      const key = `${payoutId}|${code}|${message}`;
      if (!reported.has(key)) {
        reported.add(key);
        problems.push({ code, row, ...(payoutId ? { subject: payoutId } : {}), message });
      }
    };

    if (!payoutId) return fail('INVALID_VALUE', `Rad ${row}: utbetalnings-id saknas`);
    let draft = drafts.get(payoutId);
    try {
      const date = parseDate(get('payoutDate'), dateFormat);
      const net = parseAmount(get('payoutNet'), { minorUnits });
      const currency = get('currency').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`"${get('currency')}" är ingen valutakod (tre bokstäver)`);
      if (!draft) {
        draft = { id: payoutId, date, net, currency, lines: [], lineIds: new Set(), bad: false };
        drafts.set(payoutId, draft);
      } else if (draft.date !== date || draft.net !== net) {
        return fail('INCONSISTENT_PAYOUT', `Rad ${row}: utbetalningen har olika datum eller nettobelopp på olika rader (${draft.date} / ${draft.net} och ${date} / ${net})`);
      }

      const lineId = get('lineId');
      if (!lineId) return fail('INVALID_VALUE', `Rad ${row}: rad-id saknas`);
      if (draft.lineIds.has(lineId)) return fail('DUPLICATE_LINE', `Rad ${row}: rad-id ${lineId} förekommer flera gånger i utbetalningen`);
      draft.lineIds.add(lineId);

      const type = typeOf(get('type'));
      if (!type) return fail('UNKNOWN_TYPE', `Rad ${row}: okänd radtyp "${get('type')}". Ange vilka värden leverantören använder med typeValues`);

      const fee = (): Fee | undefined => {
        const net = get('feeNet');
        const vat = get('feeVat');
        if (net === '' && vat === '') return undefined;
        const f = { net: net === '' ? 0 : parseAmount(net, { minorUnits }), vat: vat === '' ? 0 : parseAmount(vat, { minorUnits }) };
        if (f.net < 0 || f.vat < 0) throw new NegativeError(`Rad ${row}: avgiften är negativ. Det kan betyda en avgiftsåterbetalning och bokförs inte på gissning`);
        return f.net === 0 && f.vat === 0 ? undefined : f;
      };

      if (type === 'fee') {
        const f = fee();
        if (!f) return fail('INVALID_VALUE', `Rad ${row}: avgiftsrad utan avgift (kolumnerna ${names.feeNet} och ${names.feeVat})`);
        draft.lines.push({ type: 'fee', id: lineId, currency, fee: f });
        return;
      }

      const reference = get('reference');
      if (!reference) return fail('INVALID_VALUE', `Rad ${row}: referens saknas`);
      const amount = parseAmount(get('amount'), { minorUnits });
      if (type === 'payment') {
        if (amount < 0) throw new NegativeError(`Rad ${row}: en betalning har negativt belopp (${get('amount')}). Är det en återbetalning? Ange då den radtypen`);
        const f = fee();
        draft.lines.push({ type: 'payment', id: lineId, reference, amount, currency, ...(f ? { fee: f } : {}) });
      } else {
        // Återbetalningar skrivs ibland med minustecken i exporter. Beloppet lagras icke-negativt, typen anger riktningen.
        draft.lines.push({ type: 'refund', id: lineId, reference, amount: Math.abs(amount), currency });
      }
    } catch (error) {
      if (error instanceof NegativeError) return fail('NEGATIVE_AMOUNT', error.message);
      if (error instanceof RangeError) return fail('INVALID_VALUE', `Rad ${row}: ${error.message}`);
      throw error;
    }
  });

  const payouts: Payout[] = [];
  for (const d of drafts.values()) {
    if (d.bad) {
      problems.push({ code: 'PAYOUT_OMITTED', subject: d.id, message: `Utbetalning ${d.id} utelämnas helt eftersom minst en rad har ett problem` });
      continue;
    }
    payouts.push({ id: d.id, date: d.date, currency: d.currency, netAmount: d.net, lines: d.lines });
  }
  return { payouts, problems, rows: csv.rows.length };
}

class NegativeError extends RangeError {}
