import type {
  AccountMapping,
  Invoice,
  LedgerCommand,
  Payout,
  PayoutLine,
  ReconcileInput,
  ReconcileResult,
} from '../../src/domain/types.js';

export const accounts: AccountMapping = { bank: 1930, clearing: 1580, feeExpense: 6570, feeVat: 2641 };

export function invoice(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    reference: `REF-${overrides.id}`,
    currency: 'SEK',
    total: 12500,
    vatTotal: 2500,
    balance: overrides.total ?? 12500,
    creditedTotal: 0,
    creditedVatTotal: 0,
    status: 'open',
    ...overrides,
  };
}

export function payment(
  id: string,
  reference: string,
  amount: number,
  fee?: { net: number; vat: number },
  currency = 'SEK',
): PayoutLine {
  return { type: 'payment', id, reference, amount, currency, ...(fee ? { fee } : {}) };
}

export function refund(id: string, reference: string, amount: number, currency = 'SEK'): PayoutLine {
  return { type: 'refund', id, reference, amount, currency };
}

export function feeLine(id: string, net: number, vat: number, currency = 'SEK'): PayoutLine {
  return { type: 'fee', id, currency, fee: { net, vat } };
}

export function netOf(lines: readonly PayoutLine[]): number {
  return lines.reduce((sum, l) => {
    if (l.type === 'payment') return sum + l.amount - (l.fee ? l.fee.net + l.fee.vat : 0);
    if (l.type === 'refund') return sum - l.amount;
    return sum - (l.fee.net + l.fee.vat);
  }, 0);
}

export function makeInput(
  lines: PayoutLine[],
  invoices: Invoice[],
  overrides: Partial<Payout> = {},
  tenantId = 'T1',
): ReconcileInput {
  const payout: Payout = {
    id: 'PO-1',
    date: '2026-10-28',
    currency: 'SEK',
    netAmount: netOf(lines),
    lines,
    ...overrides,
  };
  return { tenantId, payout, invoices, accounts };
}

export function voucherOf(result: ReconcileResult) {
  const v = result.commands.find((c): c is Extract<LedgerCommand, { kind: 'post_voucher' }> => c.kind === 'post_voucher');
  if (!v) throw new Error('inget verifikat');
  return v;
}

export function voucherBalance(result: ReconcileResult): { debit: number; credit: number } {
  const v = result.commands.find((c) => c.kind === 'post_voucher');
  if (!v || v.kind !== 'post_voucher') return { debit: 0, credit: 0 };
  return {
    debit: v.lines.reduce((s, l) => s + l.debit, 0),
    credit: v.lines.reduce((s, l) => s + l.credit, 0),
  };
}

export function byKind<K extends LedgerCommand['kind']>(result: ReconcileResult, kind: K) {
  return result.commands.filter((c): c is Extract<LedgerCommand, { kind: K }> => c.kind === kind);
}

/** Kommandon som en ordningsoberoende mängd (sorterade på nyckel). */
export function commandSet(result: ReconcileResult): string[] {
  return result.commands.map((c) => JSON.stringify(c)).sort();
}
