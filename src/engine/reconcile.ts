import { allocate, assertMinor, checkedAdd, type Minor } from '../domain/money.js';
import type {
  Invoice,
  LedgerCommand,
  Payout,
  PayoutLine,
  ReconcileException,
  ReconcileInput,
  ReconcileResult,
  VoucherLine,
} from '../domain/types.js';

/**
 * Avstämningsmotorn. Ren funktion: ingen I/O, ingen klocka, inget slumpande.
 * Samma indata ger alltid samma kommandon med samma idempotensnycklar.
 *
 * Principer (se docs/SPEC.md avsnitt 5):
 *  - Bokför aldrig på gissning. Endast exakt referensträff och exakt belopp.
 *  - Stämmer inte utbetalningens summa avvisas hela utbetalningen.
 *  - Verifikatet skapas först när alla rader är lösta, annars nollställs inte clearingkontot.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { payout } = input;

  const rejection = validatePayout(payout) ?? validateInvoiceIds(input.invoices);
  if (rejection) return { status: 'rejected', commands: [], exceptions: [rejection] };

  const invoices = new Map<string, WorkingInvoice>(
    input.invoices.map((inv) => [inv.id, { ...inv }]),
  );
  const byReference = indexByReference(input.invoices);

  const settled = input.settledLineIds ?? new Set<string>();
  const commands: LedgerCommand[] = [];
  const exceptions: ReconcileException[] = [];
  const enc = encodeURIComponent;
  // Delarna kodas så att ':' i ett id aldrig kan ge samma nyckel för olika (tenant, utbetalning, rad).
  const keyFor = (lineId: string, kind: string) =>
    kind === 'voucher'
      ? `${enc(input.tenantId)}:${enc(payout.id)}:voucher`
      : `${enc(input.tenantId)}:${enc(payout.id)}:${enc(lineId)}:${kind}`;

  // Betalningar före återbetalningar, så att en återbetalning mot en faktura som
  // betalas i samma utbetalning inte beror på radernas ordning.
  // Rader behandlas i id-ordning så att utfallet inte beror på i vilken ordning leverantören listar dem.
  const ordered = [...payout.lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const line of ordered) {
    if (line.type !== 'payment' || settled.has(line.id)) continue;
    const outcome = resolveInvoice(line, byReference, invoices);
    if ('exception' in outcome) {
      exceptions.push(outcome.exception);
      continue;
    }
    const invoice = outcome.invoice;
    if (line.amount <= 0) {
      exceptions.push(lineException('INVALID_AMOUNT', line, 'Betalning måste vara större än noll'));
    } else if (invoice.status !== 'open' || invoice.balance <= 0) {
      exceptions.push(
        lineException('INVOICE_NOT_OPEN', line, `Faktura ${invoice.id} är inte öppen för betalning`),
      );
    } else if (line.amount !== invoice.balance) {
      exceptions.push(
        lineException(
          'AMOUNT_MISMATCH',
          line,
          `Betalning ${line.amount} stämmer inte med fakturans obetalda ${invoice.balance}`,
        ),
      );
    } else {
      invoice.balance = 0;
      invoice.status = 'paid';
      commands.push({
        kind: 'register_invoice_payment',
        key: keyFor(line.id, 'payment'),
        lineId: line.id,
        invoiceId: invoice.id,
        amount: line.amount,
        currency: line.currency,
        date: payout.date,
      });
    }
  }

  for (const line of ordered) {
    if (line.type !== 'refund' || settled.has(line.id)) continue;
    const outcome = resolveInvoice(line, byReference, invoices);
    if ('exception' in outcome) {
      exceptions.push(outcome.exception);
      continue;
    }
    const invoice = outcome.invoice;
    const remaining = invoice.total - invoice.creditedTotal;
    if (line.amount <= 0) {
      exceptions.push(lineException('INVALID_AMOUNT', line, 'Återbetalning måste vara större än noll'));
    } else if (invoice.status !== 'paid') {
      exceptions.push(
        lineException('INVOICE_NOT_OPEN', line, `Faktura ${invoice.id} är inte betald, kan inte krediteras`),
      );
    } else if (line.amount > remaining) {
      exceptions.push(
        lineException(
          'REFUND_EXCEEDS_INVOICE',
          line,
          `Återbetalning ${line.amount} överstiger återstående krediterbart ${remaining}`,
        ),
      );
    } else {
      const { vat, net } = splitCreditVat(invoice, line.amount);
      invoice.creditedTotal += line.amount;
      invoice.creditedVatTotal += vat;
      commands.push({
        kind: 'credit_invoice',
        key: keyFor(line.id, 'credit'),
        lineId: line.id,
        invoiceId: invoice.id,
        mode: line.amount === invoice.total && invoice.creditedTotal === line.amount ? 'full' : 'partial',
        amount: line.amount,
        net,
        vat,
        currency: line.currency,
        date: payout.date,
      });
    }
  }

  if (exceptions.length > 0) {
    return { status: 'partial', commands, exceptions };
  }

  const voucher = buildVoucher(input, keyFor);
  if ('exception' in voucher) {
    return { status: 'partial', commands, exceptions: [voucher.exception] };
  }
  if (voucher.command) commands.push(voucher.command);
  return { status: 'complete', commands, exceptions: [] };
}

interface WorkingInvoice extends Invoice {}

const LINE_TYPES = new Set(['payment', 'refund', 'fee']);

function validateInvoiceIds(invoices: readonly Invoice[]): ReconcileException | null {
  const seen = new Set<string>();
  for (const invoice of invoices) {
    if (seen.has(invoice.id)) {
      return { code: 'DUPLICATE_INVOICE_ID', message: `Faktura-id ${invoice.id} förekommer flera gånger i indata` };
    }
    seen.add(invoice.id);
  }
  return null;
}

function validatePayout(payout: Payout): ReconcileException | null {
  if (!payout.id.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(payout.date)) {
    return { code: 'INVALID_PAYOUT', message: 'Utbetalningen saknar id eller har ogiltigt datum (YYYY-MM-DD)' };
  }
  if (payout.lines.length === 0) {
    return { code: 'EMPTY_PAYOUT', message: 'Utbetalningen har inga rader. Inget bokförs' };
  }
  const seen = new Set<string>();
  for (const line of payout.lines) {
    if (!LINE_TYPES.has(line.type) || !line.id.trim()) {
      return { code: 'INVALID_PAYOUT', lineId: line.id, message: 'Rad med okänd typ eller tomt id' };
    }
    if ((line.type === 'payment' || line.type === 'refund') && !line.reference.trim()) {
      return { code: 'INVALID_PAYOUT', lineId: line.id, message: 'Rad saknar referens' };
    }
    if (seen.has(line.id)) {
      return { code: 'DUPLICATE_LINE_ID', lineId: line.id, message: `Rad-id ${line.id} förekommer flera gånger` };
    }
    seen.add(line.id);

    if (line.currency !== payout.currency) {
      return {
        code: 'CURRENCY_MISMATCH',
        lineId: line.id,
        message: `Rad i ${line.currency} i en utbetalning i ${payout.currency}. Flervalutastöd saknas`,
      };
    }
    try {
      for (const value of amountsOf(line)) {
        assertMinor(value, `rad ${line.id}`);
        if (value < 0) throw new RangeError(`rad ${line.id} har negativt belopp`);
      }
    } catch (error) {
      return {
        code: 'INVALID_AMOUNT',
        lineId: line.id,
        message: error instanceof Error ? error.message : 'Ogiltigt belopp',
      };
    }
  }

  try {
    assertMinor(payout.netAmount, 'utbetalningens netto');
  } catch (error) {
    return { code: 'INVALID_AMOUNT', message: error instanceof Error ? error.message : 'Ogiltigt belopp' };
  }

  let expected: Minor;
  try {
    // Alla summor kontrolleras mot heltalsgränsen. Utan det kan en summa runda tyst nära 2^53.
    expected = 0;
    let payments = 0;
    let refunds = 0;
    let fees = 0;
    for (const line of payout.lines) {
      expected = checkedAdd(expected, netContribution(line));
      if (line.type === 'payment') {
        payments = checkedAdd(payments, line.amount);
        fees = checkedAdd(fees, line.fee ? line.fee.net + line.fee.vat : 0);
      } else if (line.type === 'refund') {
        refunds = checkedAdd(refunds, line.amount);
      } else {
        fees = checkedAdd(fees, line.fee.net + line.fee.vat);
      }
    }
    checkedAdd(checkedAdd(payments, refunds), fees);
  } catch {
    return { code: 'INVALID_AMOUNT', message: 'Beloppen är för stora för att summeras säkert' };
  }
  if (expected !== payout.netAmount) {
    return {
      code: 'PAYOUT_SUM_MISMATCH',
      message: `Raderna ger ${expected} men utbetalningen är ${payout.netAmount}. Inget bokförs`,
    };
  }
  return null;
}

function amountsOf(line: PayoutLine): Minor[] {
  switch (line.type) {
    case 'payment':
      return [line.amount, ...(line.fee ? [line.fee.net, line.fee.vat] : [])];
    case 'refund':
      return [line.amount];
    case 'fee':
      return [line.fee.net, line.fee.vat];
  }
}

/** Radens påverkan på utbetalt belopp. */
function netContribution(line: PayoutLine): Minor {
  switch (line.type) {
    case 'payment':
      return line.amount - (line.fee ? line.fee.net + line.fee.vat : 0);
    case 'refund':
      return -line.amount;
    case 'fee':
      return -(line.fee.net + line.fee.vat);
  }
}

function indexByReference(invoices: readonly Invoice[]): Map<string, Invoice[]> {
  const map = new Map<string, Invoice[]>();
  for (const invoice of invoices) {
    const ref = normalizeReference(invoice.reference);
    map.set(ref, [...(map.get(ref) ?? []), invoice]);
  }
  return map;
}

function normalizeReference(reference: string): string {
  return reference.trim();
}

type Resolved = { invoice: WorkingInvoice } | { exception: ReconcileException };

function resolveInvoice(
  line: Extract<PayoutLine, { type: 'payment' | 'refund' }>,
  byReference: Map<string, Invoice[]>,
  working: Map<string, WorkingInvoice>,
): Resolved {
  const candidates = byReference.get(normalizeReference(line.reference)) ?? [];
  if (candidates.length === 0) {
    return { exception: lineException('NO_MATCH', line, `Ingen faktura med referens ${line.reference}`) };
  }
  if (candidates.length > 1) {
    return {
      exception: lineException(
        'AMBIGUOUS_MATCH',
        line,
        `${candidates.length} fakturor har referens ${line.reference}`,
      ),
    };
  }
  const invoice = working.get(candidates[0]!.id)!;
  const problem = invoiceProblem(invoice);
  if (problem) {
    return {
      exception: lineException('INVALID_INVOICE', line, `Faktura ${invoice.id} har ogiltiga uppgifter: ${problem}`),
    };
  }
  if (invoice.currency !== line.currency) {
    return {
      exception: lineException(
        'CURRENCY_MISMATCH',
        line,
        `Faktura ${invoice.id} är i ${invoice.currency}, raden i ${line.currency}`,
      ),
    };
  }
  return { invoice };
}

/** Beskriver vad som är fel med en faktura från adaptern, eller null om den hänger ihop. */
function invoiceProblem(invoice: Invoice): string | null {
  const numbers = [invoice.total, invoice.vatTotal, invoice.balance, invoice.creditedTotal, invoice.creditedVatTotal];
  if (!numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) return 'belopp måste vara icke-negativa heltal';
  if (invoice.vatTotal > invoice.total) return 'momsen överstiger totalen';
  if (invoice.balance > invoice.total) return 'obetalt belopp överstiger totalen';
  if (invoice.creditedTotal > invoice.total) return 'krediterat belopp överstiger totalen';
  if (invoice.creditedVatTotal > invoice.vatTotal) return 'krediterad moms överstiger fakturans moms';
  if (invoice.creditedTotal - invoice.creditedVatTotal > invoice.total - invoice.vatTotal) {
    return 'krediterat netto överstiger fakturans netto';
  }
  if (invoice.status === 'paid' && invoice.balance !== 0) return 'betald faktura med obetalt belopp';
  return null;
}

/**
 * Delar en kreditering på moms och netto, proportionellt mot det som återstår att kreditera
 * (inte mot fakturans totaler). Därmed är moms och netto aldrig negativa, moms aldrig större
 * än beloppet, och en sista kreditering tar exakt kvarvarande moms.
 * Förutsätter en faktura som klarat `invoiceProblem` och 0 < amount <= remaining.
 */
function splitCreditVat(invoice: WorkingInvoice, amount: Minor): { vat: Minor; net: Minor } {
  const remainingVat = invoice.vatTotal - invoice.creditedVatTotal;
  const remainingNet = invoice.total - invoice.vatTotal - (invoice.creditedTotal - invoice.creditedVatTotal);
  const [vat = 0, net = 0] = allocate(amount, [remainingVat, remainingNet]);
  return { vat, net };
}

function buildVoucher(
  input: ReconcileInput,
  keyFor: (lineId: string, kind: string) => string,
): { command: LedgerCommand | null } | { exception: ReconcileException } {
  const { payout, accounts } = input;

  let payments = 0;
  let refunds = 0;
  let feeNet = 0;
  let feeVat = 0;
  for (const line of payout.lines) {
    if (line.type === 'payment') {
      payments += line.amount;
      feeNet += line.fee?.net ?? 0;
      feeVat += line.fee?.vat ?? 0;
    } else if (line.type === 'refund') {
      refunds += line.amount;
    } else {
      feeNet += line.fee.net;
      feeVat += line.fee.vat;
    }
  }

  const lines: VoucherLine[] = [];
  const push = (account: number, amount: Minor, side: 'debit' | 'credit') => {
    if (amount === 0) return;
    lines.push({ account, debit: side === 'debit' ? amount : 0, credit: side === 'credit' ? amount : 0 });
  };
  const pushSigned = (account: number, amount: Minor, positiveSide: 'debit' | 'credit') => {
    const other = positiveSide === 'debit' ? 'credit' : 'debit';
    if (amount >= 0) push(account, amount, positiveSide);
    else push(account, -amount, other);
  };

  pushSigned(accounts.bank, payout.netAmount, 'debit');
  push(accounts.feeExpense, feeNet, 'debit');
  push(accounts.feeVat, feeVat, 'debit');
  pushSigned(accounts.clearing, payments - refunds, 'credit');

  if (lines.length === 0) return { command: null };

  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) {
    return {
      exception: {
        code: 'INTERNAL_IMBALANCE',
        message: `Verifikatet balanserar inte (debet ${debit}, kredit ${credit}). Inget verifikat skapat`,
      },
    };
  }

  return {
    command: {
      kind: 'post_voucher',
      key: keyFor('voucher', 'voucher'),
      date: payout.date,
      description: `Utbetalning ${payout.id}`,
      lines,
    },
  };
}

function lineException(
  code: ReconcileException['code'],
  line: { id: string },
  message: string,
): ReconcileException {
  return { code, lineId: line.id, message };
}
