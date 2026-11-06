import type { AccountMapping, Invoice, Payout, ReconcileException } from '../domain/types.js';
import { reconcile } from '../engine/reconcile.js';
import { summarizeProposals, type ProposalSummary } from './report.js';

/**
 * Provkörning: avstämning av utbetalningar mot fakturor utan databas, utan kund och utan att något sparas. Används för
 * att visa hur stor del som kan stämmas av automatiskt innan någon kopplat något system, med filer som kunden själv lämnar.
 * Rena funktioner.
 */

/** Exempelkonton (BAS) när kunden inte angett några. De påverkar bara verifikatet i förhandsvisningen, aldrig träffsäkerheten. */
export const EXAMPLE_ACCOUNTS: AccountMapping = { bank: 1930, clearing: 1580, feeExpense: 6570, feeVat: 2641 };

export interface PreviewInput {
  payouts: readonly Payout[];
  invoices: readonly Invoice[];
  accounts?: AccountMapping;
  allowPartialPayments?: boolean;
}

export interface PreviewPayout {
  payoutId: string;
  date: string;
  status: 'complete' | 'partial' | 'rejected';
  /** Rader som matchats säkert. */
  matchedLines: number;
  /** Rader som blev avvikelser. */
  unmatchedLines: number;
  exceptions: Array<Pick<ReconcileException, 'code' | 'lineId' | 'message'>>;
}

export interface Preview {
  summary: ProposalSummary;
  payouts: PreviewPayout[];
}

/**
 * Utbetalningarna körs i datum- och id-ordning, och varje utbetalnings resultat tillämpas på fakturorna innan nästa. Annars
 * skulle två utbetalningar mot samma faktura båda se den som öppen och bli dubbelt "klara".
 */
export function previewReconciliation(input: PreviewInput): Preview {
  const state = new Map<string, Invoice>(input.invoices.map((i) => [i.id, { ...i }]));
  const ordered = [...input.payouts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const results: PreviewPayout[] = [];
  const stored = [];

  for (const payout of ordered) {
    const result = reconcile({
      tenantId: 'preview',
      payout,
      invoices: [...state.values()],
      accounts: input.accounts ?? EXAMPLE_ACCOUNTS,
      ...(input.allowPartialPayments ? { allowPartialPayments: true } : {}),
    });

    for (const c of result.commands) {
      if (c.kind === 'register_invoice_payment') {
        const inv = state.get(c.invoiceId);
        if (!inv) continue;
        if (c.remaining === undefined) {
          inv.balance = 0;
          inv.status = 'paid';
        } else {
          inv.balance = c.remaining;
        }
      } else if (c.kind === 'credit_invoice') {
        const inv = state.get(c.invoiceId);
        if (inv) {
          inv.creditedTotal += c.amount;
          inv.creditedVatTotal += c.vat;
        }
      }
    }

    const unmatched = new Set(result.exceptions.flatMap((e) => (e.lineId === undefined ? [] : [e.lineId])));
    results.push({
      payoutId: payout.id,
      date: payout.date,
      status: result.status,
      matchedLines: result.commands.filter((c) => c.kind !== 'post_voucher').length,
      unmatchedLines: unmatched.size,
      exceptions: result.exceptions.map((e) => ({ code: e.code, ...(e.lineId !== undefined ? { lineId: e.lineId } : {}), message: e.message })),
    });
    stored.push({ tenantId: 'preview', payoutId: payout.id, status: result.status, result, updatedAt: new Date(0) });
  }
  return { summary: summarizeProposals(stored), payouts: results };
}
