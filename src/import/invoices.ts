import type { Invoice, InvoiceStatus } from '../domain/types.js';
import { parseAmount } from './amount.js';
import { CsvError, parseCsv, type Delimiter } from './csv.js';
import type { ImportProblem, ImportProblemCode } from './payouts.js';

/**
 * Läser en fakturafil (en rad per faktura, t.ex. en exportlista över obetalda kundfakturor) till normaliserade fakturor.
 * Formatet är dokumenterat i docs/PROVKORNING.md. Som för utbetalningar: en faktura med ett problem utelämnas och rapporteras.
 */

export type InvoiceColumn = 'invoiceId' | 'reference' | 'currency' | 'total' | 'vatTotal' | 'balance' | 'creditedTotal' | 'creditedVatTotal' | 'status';

export const DEFAULT_INVOICE_COLUMNS: Record<InvoiceColumn, string> = {
  invoiceId: 'invoice_id',
  reference: 'reference',
  currency: 'currency',
  total: 'total',
  vatTotal: 'vat_total',
  balance: 'balance',
  creditedTotal: 'credited_total',
  creditedVatTotal: 'credited_vat_total',
  status: 'status',
};

export const DEFAULT_STATUS_VALUES: Record<InvoiceStatus, string[]> = {
  open: ['open', 'unpaid', 'obetald', 'öppen'],
  paid: ['paid', 'betald'],
  cancelled: ['cancelled', 'canceled', 'makulerad'],
};

export interface InvoiceCsvMapping {
  columns?: Partial<Record<InvoiceColumn, string>>;
  delimiter?: Delimiter;
  amountsInMinorUnits?: boolean;
  statusValues?: Partial<Record<InvoiceStatus, string[]>>;
}

export interface ParsedInvoices {
  invoices: Invoice[];
  problems: ImportProblem[];
  rows: number;
}

const REQUIRED: InvoiceColumn[] = ['invoiceId', 'reference', 'currency', 'total', 'vatTotal', 'balance'];

export function parseInvoiceCsv(text: string, mapping: InvoiceCsvMapping = {}): ParsedInvoices {
  let csv;
  try {
    csv = parseCsv(text, mapping.delimiter);
  } catch (error) {
    if (error instanceof CsvError) return { invoices: [], rows: 0, problems: [{ code: 'FILE_INVALID', ...(error.row !== undefined ? { row: error.row } : {}), message: error.message }] };
    throw error;
  }
  const names = { ...DEFAULT_INVOICE_COLUMNS, ...mapping.columns };
  const index = new Map(csv.header.map((h, i) => [h.toLowerCase(), i]));
  const col = (c: InvoiceColumn): number | undefined => index.get(names[c].toLowerCase());

  const missing = REQUIRED.filter((c) => col(c) === undefined);
  if (missing.length > 0) {
    return {
      invoices: [],
      rows: csv.rows.length,
      problems: missing.map((c) => ({ code: 'COLUMN_MISSING' as const, message: `Kolumnen "${names[c]}" (${c}) saknas i filen. Rubriker i filen: ${csv.header.join(', ')}` })),
    };
  }

  const minorUnits = mapping.amountsInMinorUnits === true;
  const statusOf = (value: string): InvoiceStatus | null => {
    const v = value.toLowerCase();
    for (const s of ['open', 'paid', 'cancelled'] as const) {
      if ((mapping.statusValues?.[s] ?? DEFAULT_STATUS_VALUES[s]).some((x) => x.toLowerCase() === v)) return s;
    }
    return null;
  };

  const invoices: Invoice[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  csv.rows.forEach((cells, i) => {
    const row = csv.rowNumbers[i]!;
    const get = (c: InvoiceColumn): string => {
      const at = col(c);
      return at === undefined ? '' : (cells[at] ?? '');
    };
    const id = get('invoiceId');
    const fail = (code: ImportProblemCode, message: string) => problems.push({ code, row, ...(id ? { subject: id } : {}), message });
    try {
      if (!id) return fail('INVALID_VALUE', `Rad ${row}: faktura-id saknas`);
      if (seen.has(id)) {
        // Två rader med samma faktura-id: vi vet inte vilken som gäller, så ingen av dem används.
        duplicates.add(id);
        return fail('DUPLICATE_INVOICE', `Rad ${row}: faktura ${id} förekommer flera gånger. Ingen av raderna används, eftersom det inte går att veta vilken som gäller`);
      }
      seen.add(id);
      const reference = get('reference');
      if (!reference) return fail('INVALID_VALUE', `Rad ${row}: faktura ${id} saknar referens`);
      const currency = get('currency').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return fail('INVALID_VALUE', `Rad ${row}: "${get('currency')}" är ingen valutakod`);
      const total = parseAmount(get('total'), { minorUnits });
      const vatTotal = parseAmount(get('vatTotal'), { minorUnits });
      const balance = parseAmount(get('balance'), { minorUnits });
      const creditedTotal = get('creditedTotal') === '' ? 0 : parseAmount(get('creditedTotal'), { minorUnits });
      const creditedVatTotal = get('creditedVatTotal') === '' ? 0 : parseAmount(get('creditedVatTotal'), { minorUnits });

      let status: InvoiceStatus;
      if (get('status') === '') {
        // Utan statuskolumn: obetalt saldo betyder öppen, inget saldo betyder betald. En makulerad faktura måste anges.
        status = balance > 0 ? 'open' : 'paid';
      } else {
        const s = statusOf(get('status'));
        if (!s) return fail('UNKNOWN_STATUS', `Rad ${row}: okänd status "${get('status')}". Ange vilka värden affärssystemet använder med statusValues`);
        status = s;
      }
      invoices.push({ id, reference, currency, total, vatTotal, balance, creditedTotal, creditedVatTotal, status });
    } catch (error) {
      if (error instanceof RangeError) return fail('INVALID_VALUE', `Rad ${row}: ${error.message}`);
      throw error;
    }
  });
  return { invoices: invoices.filter((inv) => !duplicates.has(inv.id)), problems, rows: csv.rows.length };
}
