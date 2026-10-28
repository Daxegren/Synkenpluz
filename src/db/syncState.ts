import { z } from 'zod';
import type { AccountMapping } from '../domain/types.js';
import type { Clock } from '../ports/index.js';
import type { SyncStateStore, TenantConfig, TenantConfigProvider } from '../ports/sources.js';
import type { Db } from './db.js';

export function createSyncStateStore(db: Db, clock: Clock): SyncStateStore {
  return {
    async getCursor(tenantId) {
      const rows = await db.query<{ cursor: string | null }>('select cursor from sync_state where tenant_id = $1', [tenantId]);
      return rows[0]?.cursor ?? null;
    },
    async setCursor(tenantId, cursor) {
      await db.query(
        `insert into sync_state (tenant_id, cursor, updated_at) values ($1, $2, $3)
         on conflict (tenant_id) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`,
        [tenantId, cursor, clock.now()],
      );
    },
  };
}

const accountNumber = z.number().int().min(1000).max(9999);
export const accountMappingSchema = z
  .object({ bank: accountNumber, clearing: accountNumber, feeExpense: accountNumber, feeVat: accountNumber })
  .strict();

/** Sparar kontoplanen för en kund. Validerar att alla fyra konton är giltiga kontonummer (1000–9999). */
export async function setTenantAccounts(db: Db, tenantId: string, accounts: AccountMapping): Promise<boolean> {
  const parsed = accountMappingSchema.parse(accounts);
  const rows = await db.query('update tenant set accounts = $2::jsonb where id = $1 returning id', [
    tenantId,
    JSON.stringify(parsed),
  ]);
  return rows.length > 0;
}

/**
 * Kundkonfiguration för synk. En kund utan kontoplan, eller som är avstängd, har ingen
 * konfiguration och synkas därför inte (hellre inget än bokföring på gissade konton).
 */
export function createTenantConfigProvider(db: Db): TenantConfigProvider {
  return {
    async get(tenantId): Promise<TenantConfig | null> {
      const rows = await db.query<{ mode: 'dry_run' | 'live'; accounts: unknown; status: string }>(
        'select mode, accounts, status from tenant where id = $1',
        [tenantId],
      );
      const row = rows[0];
      if (!row || row.status !== 'active' || !row.accounts) return null;
      const accounts = accountMappingSchema.safeParse(row.accounts);
      if (!accounts.success) return null;
      return { accounts: accounts.data, mode: row.mode };
    },
  };
}

/** Kunder som är redo att synkas: aktiva och med kontoplan. */
export async function listSyncableTenants(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select id from tenant where status = 'active' and accounts is not null order by id`,
  );
  return rows.map((r) => r.id);
}
