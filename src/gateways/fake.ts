import type { Invoice, LedgerCommand, VoucherLine } from '../domain/types.js';
import { LedgerError, type LedgerGateway } from '../ports/index.js';
import type { InvoiceReader } from '../ports/sources.js';

export interface FakeLedgerOptions {
  invoices?: readonly Invoice[];
}

type ExecutedCommand = { tenantId: string; command: LedgerCommand; externalId: string };

/**
 * Simulerat affärssystem för tester. Inte en Fortnox-implementation: det finns ingen
 * verifierad kunskap om Fortnox API här. Den efterliknar bara de egenskaper vi kräver av
 * en gateway: idempotens på `command.key`, och att fakturors tillstånd ändras av kommandon.
 *
 * Hjälpmetoder (`failNext`, `executed`, `vouchers`) finns för att kunna provocera fram fel
 * och granska resultat i tester.
 */
export class FakeLedgerGateway implements LedgerGateway, InvoiceReader {
  private readonly invoices = new Map<string, Invoice>();
  private readonly byKey = new Map<string, ExecutedCommand>();
  private readonly failures: Array<LedgerError | Error> = [];
  private counter = 0;
  /** Antal anrop till execute, inklusive de som blev uppslag av redan utförda nycklar. */
  calls = 0;

  constructor(options: FakeLedgerOptions = {}) {
    for (const invoice of options.invoices ?? []) this.invoices.set(invoice.id, { ...invoice });
  }

  /** Nästa anrop till execute kastar detta fel. Köas i ordning. */
  failNext(error: LedgerError | Error): void {
    this.failures.push(error);
  }

  invoice(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }

  /** Lägger till en faktura efter att fakturan "skapats" i affärssystemet, för att simulera sen uppdykning. */
  addInvoice(invoice: Invoice): void {
    this.invoices.set(invoice.id, { ...invoice });
  }

  async findByReferences(_tenantId: string, references: readonly string[]): Promise<Invoice[]> {
    const wanted = new Set(references.map((r) => r.trim()));
    return [...this.invoices.values()].filter((i) => wanted.has(i.reference.trim())).map((i) => ({ ...i }));
  }

  get executed(): readonly ExecutedCommand[] {
    return [...this.byKey.values()];
  }

  get vouchers(): VoucherLine[][] {
    return this.executed.flatMap((e) => (e.command.kind === 'post_voucher' ? [e.command.lines] : []));
  }

  async execute(tenantId: string, command: LedgerCommand): Promise<{ externalId: string }> {
    this.calls++;
    const failure = this.failures.shift();
    if (failure) throw failure;

    // Idempotens: samma nyckel ger samma resultat utan ny skrivning.
    const done = this.byKey.get(command.key);
    if (done) return { externalId: done.externalId };

    switch (command.kind) {
      case 'register_invoice_payment': {
        const invoice = this.require(command.invoiceId);
        if (invoice.status !== 'open' || invoice.balance !== command.amount) {
          throw new LedgerError(`Faktura ${invoice.id} kan inte betalas med ${command.amount}`, false);
        }
        invoice.balance = 0;
        invoice.status = 'paid';
        break;
      }
      case 'credit_invoice': {
        const invoice = this.require(command.invoiceId);
        if (invoice.status !== 'paid' || invoice.creditedTotal + command.amount > invoice.total) {
          throw new LedgerError(`Faktura ${invoice.id} kan inte krediteras med ${command.amount}`, false);
        }
        invoice.creditedTotal += command.amount;
        invoice.creditedVatTotal += command.vat;
        break;
      }
      case 'post_voucher': {
        const debit = command.lines.reduce((s, l) => s + l.debit, 0);
        const credit = command.lines.reduce((s, l) => s + l.credit, 0);
        if (debit !== credit) throw new LedgerError('Verifikatet balanserar inte', false);
        break;
      }
    }

    const externalId = `EXT-${++this.counter}`;
    this.byKey.set(command.key, { tenantId, command, externalId });
    return { externalId };
  }

  private require(invoiceId: string): Invoice {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new LedgerError(`Faktura ${invoiceId} finns inte`, false);
    return invoice;
  }
}
