import type { Minor } from './money.js';

/**
 * Normaliserat format. Adaptrarna (Mondido, Fortnox) översätter till och från
 * dessa typer. Avstämningsmotorn känner inte till något leverantörsspecifikt.
 */

export type CurrencyCode = string;

/** Kundens bokföringsvaluta. Utbetalningar i andra valutor kräver egna konton (`AccountMapping.foreign`). */
export const BASE_CURRENCY: CurrencyCode = 'SEK';

/** ISO-datum, YYYY-MM-DD. */
export type IsoDate = string;

/** Avgift på en betalning eller som fristående rad. Moms redovisas separat. */
export interface Fee {
  net: Minor;
  vat: Minor;
}

export type PayoutLine =
  | {
      type: 'payment';
      id: string;
      /** Referens som binder ihop betalningen med fakturan (se SPEC 5.1). */
      reference: string;
      /** Brutto, icke-negativt. */
      amount: Minor;
      currency: CurrencyCode;
      fee?: Fee;
    }
  | {
      type: 'refund';
      id: string;
      reference: string;
      /** Återbetalt belopp, icke-negativt. Tecknet bestäms av typen. */
      amount: Minor;
      currency: CurrencyCode;
    }
  | {
      type: 'fee';
      id: string;
      currency: CurrencyCode;
      fee: Fee;
    };

export interface Payout {
  id: string;
  date: IsoDate;
  currency: CurrencyCode;
  /** Beloppet som faktiskt betalas ut till kunden, efter avgifter och återbetalningar. */
  netAmount: Minor;
  lines: readonly PayoutLine[];
}

export type InvoiceStatus = 'open' | 'paid' | 'cancelled';

/** Faktura i affärssystemet, normaliserad. */
export interface Invoice {
  id: string;
  reference: string;
  currency: CurrencyCode;
  total: Minor;
  vatTotal: Minor;
  /** Obetalt belopp. */
  balance: Minor;
  /** Redan krediterat belopp. */
  creditedTotal: Minor;
  /** Moms som ingår i redan krediterat belopp. */
  creditedVatTotal: Minor;
  status: InvoiceStatus;
}

/** De fyra konton en utbetalning bokförs mot. */
export interface PayoutAccounts {
  bank: number;
  clearing: number;
  feeExpense: number;
  feeVat: number;
}

/**
 * Kontoplan för bokföring av utbetalningen. Konfigureras per kund. Huvudkontona gäller utbetalningar i
 * bokföringsvalutan (SEK). `foreign` ger egna konton per annan valuta, t.ex. { EUR: { ... } }. Saknas konton för en
 * valuta bokförs inget verifikat (avvikelsen ACCOUNTS_MISSING), så belopp i en valuta aldrig hamnar på konton för en annan.
 */
export interface AccountMapping extends PayoutAccounts {
  foreign?: Record<CurrencyCode, PayoutAccounts>;
}

export interface VoucherLine {
  account: number;
  debit: Minor;
  credit: Minor;
}

export type LedgerCommand =
  | {
      kind: 'register_invoice_payment';
      key: string;
      lineId: string;
      invoiceId: string;
      amount: Minor;
      currency: CurrencyCode;
      date: IsoDate;
      /** Finns bara vid en delbetalning: fakturans obetalda belopp efter den här betalningen (större än noll). */
      remaining?: Minor;
    }
  | {
      kind: 'credit_invoice';
      key: string;
      lineId: string;
      invoiceId: string;
      mode: 'full' | 'partial';
      amount: Minor;
      net: Minor;
      vat: Minor;
      currency: CurrencyCode;
      date: IsoDate;
    }
  | {
      kind: 'post_voucher';
      key: string;
      date: IsoDate;
      description: string;
      lines: VoucherLine[];
      /** Finns bara när verifikatet inte är i bokföringsvalutan. Saknas den är det SEK. */
      currency?: CurrencyCode;
    };

export type ExceptionCode =
  | 'PAYOUT_SUM_MISMATCH'
  | 'DUPLICATE_LINE_ID'
  | 'INVALID_AMOUNT'
  | 'CURRENCY_MISMATCH'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'INVOICE_NOT_OPEN'
  | 'AMOUNT_MISMATCH'
  | 'REFUND_EXCEEDS_INVOICE'
  | 'INTERNAL_IMBALANCE'
  | 'INVALID_PAYOUT'
  | 'INVALID_INVOICE'
  | 'DUPLICATE_INVOICE_ID'
  | 'EMPTY_PAYOUT'
  | 'COMMAND_CONFLICT'
  | 'ACCOUNTS_MISSING';

export interface ReconcileException {
  code: ExceptionCode;
  lineId?: string;
  message: string;
}

/**
 * rejected: inget får bokföras (utbetalningen går inte att lita på).
 * partial:  rader som matchats säkert har kommandon, resten ligger i exceptions.
 *           Verifikatet skapas inte förrän alla rader är lösta.
 * complete: alla rader lösta, verifikat skapat.
 */
export type ReconcileStatus = 'complete' | 'partial' | 'rejected';

export interface ReconcileResult {
  status: ReconcileStatus;
  commands: LedgerCommand[];
  exceptions: ReconcileException[];
}

export interface ReconcileInput {
  tenantId: string;
  payout: Payout;
  /** Kandidatfakturor som adaptern hämtat för utbetalningens referenser. */
  invoices: readonly Invoice[];
  accounts: AccountMapping;
  /**
   * Rader som redan har bokföringskommandon från en tidigare körning. De räknas med i
   * summakontrollen och verifikatet men matchas och bokförs inte igen. Utan detta
   * skulle en omkörning se redan betalda fakturor som fel.
   */
  settledLineIds?: ReadonlySet<string>;
  /**
   * Registrera en betalning som är mindre än fakturans obetalda belopp som en delbetalning. Av som standard:
   * då blir det en avvikelse (AMOUNT_MISMATCH) som en människa avgör. Betalningar som är större än saldot
   * blir alltid en avvikelse.
   */
  allowPartialPayments?: boolean;
}
