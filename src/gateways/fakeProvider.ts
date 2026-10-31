import type { ConnectionCheck, LedgerCapabilities, LedgerProvider } from '../ports/ledger.js';

export const FULL_CAPABILITIES: LedgerCapabilities = {
  searchByReference: true,
  idempotentWrites: true,
  verifyByReference: true,
  creditInvoice: true,
  postVoucher: true,
};

/**
 * Simulerad leverantör för tester. Inte en riktig adapter: den svarar bara det testet har bett om
 * (`setResult`) och räknar anropen, så att tester kan visa att inget skrivs.
 */
export class FakeLedgerProvider implements LedgerProvider {
  private result: ConnectionCheck | Error = { ok: true, problems: [] };
  checks = 0;

  constructor(
    readonly provider = 'fortnox',
    readonly capabilities: LedgerCapabilities = FULL_CAPABILITIES,
  ) {}

  /** Nästa (och följande) kontroller returnerar detta, eller kastar om det är ett fel. */
  setResult(result: ConnectionCheck | Error): void {
    this.result = result;
  }

  async checkConnection(_tenantId: string): Promise<ConnectionCheck> {
    this.checks++;
    if (this.result instanceof Error) throw this.result;
    return { ...this.result, problems: [...this.result.problems] };
  }
}
