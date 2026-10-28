import type { LedgerGateway } from '../ports/index.js';
import { LedgerError } from '../ports/index.js';
import type { InvoiceReader, PayoutSource } from '../ports/sources.js';

const MESSAGE =
  'Ingen adapter är konfigurerad. Mondido- och Fortnox-adaptrar är inte byggda ännu (kräver API-dokumentation och sandbox-konton).';

/**
 * Platshållare som misslyckas högt och tydligt. Det är bättre att processen startar och visar
 * ett tydligt fel per kund i varje cykel än att den låtsas fungera mot ett affärssystem.
 */
export const notConfiguredAdapters: {
  source: PayoutSource;
  invoices: InvoiceReader;
  gateway: LedgerGateway;
} = {
  source: {
    async listPayoutsSince() {
      throw new Error(MESSAGE);
    },
    async getPayout() {
      throw new Error(MESSAGE);
    },
  },
  invoices: {
    async findByReferences() {
      throw new Error(MESSAGE);
    },
  },
  gateway: {
    async execute() {
      throw new LedgerError(MESSAGE, true);
    },
  },
};
