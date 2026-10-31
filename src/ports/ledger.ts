/**
 * Vad en kopplad leverantör av affärssystem kan, och om kundens anslutning fungerar.
 * Skrivningarna ligger i LedgerGateway (./index.ts) och läsningen i InvoiceReader (./sources.ts).
 * Den här porten är till för onboarding och drift: den gör Fortnox, Spiris och Briox utbytbara
 * i checklistan, och beskriver ärligt vad respektive adapter inte kan.
 */

export interface LedgerCapabilities {
  /** Kan hitta en faktura på referensen som betalleverantören anger. Utan det går ingenting att matcha. */
  searchByReference: boolean;
  /** Upprepade skrivningar med samma nyckel ger samma resultat hos affärssystemet självt. */
  idempotentWrites: boolean;
  /** Kan avgöra om ett anrop med okänt utfall utfördes (genom att söka på en referens vi skrev dit). */
  verifyByReference: boolean;
  /** Kan kreditera en betald faktura (delkreditering vid återbetalning). */
  creditInvoice: boolean;
  /** Kan skapa ett verifikat med flera rader. */
  postVoucher: boolean;
}

export interface ConnectionCheck {
  ok: boolean;
  /** Läsbara problem för en handläggare (t.ex. "token har gått ut"). Aldrig uppgifter eller svar i rått skick. */
  problems: string[];
}

export interface LedgerProvider {
  /** Leverantörens namn, samma som `provider` i tabellen `connection` (t.ex. "fortnox"). */
  readonly provider: string;
  readonly capabilities: LedgerCapabilities;
  /** Gör ett ofarligt läsanrop med kundens uppgifter. Ska aldrig skriva något i affärssystemet. */
  checkConnection(tenantId: string): Promise<ConnectionCheck>;
}
