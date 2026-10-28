import type { Payout } from '../domain/types.js';
import type { PayoutSource, SyncStateStore, TenantConfig, TenantConfigProvider } from '../ports/sources.js';

/**
 * Simulerad betalleverantör för tester. Cursorn är ett löpnummer i listan. Inte en
 * Mondido-implementation: det finns ingen verifierad kunskap om Mondidos API här.
 */
export class FakePayoutSource implements PayoutSource {
  private readonly entries: Array<{ tenantId: string | null; payout: Payout }> = [];
  failListing: Error | null = null;

  /** Utan `tenantId` syns utbetalningen för alla kunder. Med `tenantId` bara för den kunden. */
  add(payout: Payout, tenantId: string | null = null): void {
    this.entries.push({ tenantId, payout: structuredClone(payout) });
  }

  private visible(tenantId: string) {
    return this.entries.filter((e) => e.tenantId === null || e.tenantId === tenantId);
  }

  async listPayoutsSince(tenantId: string, cursor: string | null) {
    if (this.failListing) throw this.failListing;
    const visible = this.visible(tenantId);
    const start = cursor === null ? 0 : Number(cursor);
    return {
      payouts: visible.slice(start).map((e) => structuredClone(e.payout)),
      nextCursor: String(visible.length),
    };
  }

  async getPayout(tenantId: string, payoutId: string) {
    const found = this.visible(tenantId).find((e) => e.payout.id === payoutId);
    return found ? structuredClone(found.payout) : null;
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
