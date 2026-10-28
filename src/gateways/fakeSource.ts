import type { Payout } from '../domain/types.js';
import type { PayoutSource, SyncStateStore, TenantConfig, TenantConfigProvider } from '../ports/sources.js';

/**
 * Simulerad betalleverantör för tester. Cursorn är ett löpnummer i listan. Inte en
 * Mondido-implementation: det finns ingen verifierad kunskap om Mondidos API här.
 */
export class FakePayoutSource implements PayoutSource {
  private readonly payouts: Payout[] = [];
  failListing: Error | null = null;

  add(payout: Payout): void {
    this.payouts.push(structuredClone(payout));
  }

  async listPayoutsSince(_tenantId: string, cursor: string | null) {
    if (this.failListing) throw this.failListing;
    const start = cursor === null ? 0 : Number(cursor);
    return {
      payouts: this.payouts.slice(start).map((p) => structuredClone(p)),
      nextCursor: String(this.payouts.length),
    };
  }

  async getPayout(_tenantId: string, payoutId: string) {
    const found = this.payouts.find((p) => p.id === payoutId);
    return found ? structuredClone(found) : null;
  }
}

export class MemoryTenantConfig implements TenantConfigProvider {
  constructor(private readonly configs: Record<string, TenantConfig>) {}
  async get(tenantId: string) {
    return this.configs[tenantId] ?? null;
  }
}

export class MemorySyncState implements SyncStateStore {
  private readonly cursors = new Map<string, string | null>();
  async getCursor(tenantId: string) {
    return this.cursors.get(tenantId) ?? null;
  }
  async setCursor(tenantId: string, cursor: string | null) {
    this.cursors.set(tenantId, cursor);
  }
}
