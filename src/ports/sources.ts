import type { AccountMapping, Invoice, Payout } from '../domain/types.js';

/**
 * Läsportar mot omvärlden. Skrivportar (bokföring) finns i ./index.ts (LedgerGateway).
 * Alla implementationer ansvarar själva för autentisering, rate limiting och för att
 * översätta leverantörens format till de normaliserade typerna i src/domain.
 */

/** Betalleverantören, t.ex. Mondido. */
export interface PayoutSource {
  /**
   * Utbetalningar som tillkommit efter `cursor` (null = från början). Returnerar en ny cursor
   * att spara. Får returnera samma utbetalning flera gånger: bearbetningen är idempotent.
   */
  listPayoutsSince(tenantId: string, cursor: string | null): Promise<{ payouts: Payout[]; nextCursor: string | null }>;

  /** Hämtar en enskild utbetalning på nytt, t.ex. för att återuppta en delvis avstämd. */
  getPayout(tenantId: string, payoutId: string): Promise<Payout | null>;
}

/** Läsning av fakturor i affärssystemet, t.ex. Fortnox. Ska ge FÄRSK status vid varje anrop. */
export interface InvoiceReader {
  findByReferences(tenantId: string, references: readonly string[]): Promise<Invoice[]>;
}

/** Per-kund-konfiguration som styr bokföringen. */
export interface TenantConfig {
  accounts: AccountMapping;
  /** Nya kunder startar i dry_run tills förslagen godkänts. */
  mode: 'dry_run' | 'live';
}

export interface TenantConfigProvider {
  get(tenantId: string): Promise<TenantConfig | null>;
}

/** Håller reda på hur långt vi kommit i leverantörens utbetalningslista. */
export interface SyncStateStore {
  getCursor(tenantId: string): Promise<string | null>;
  setCursor(tenantId: string, cursor: string | null): Promise<void>;
}
