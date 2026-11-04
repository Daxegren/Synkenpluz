import { z } from 'zod';
import { BASE_CURRENCY, type AccountMapping } from '../domain/types.js';
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
const payoutAccountsShape = { bank: accountNumber, clearing: accountNumber, feeExpense: accountNumber, feeVat: accountNumber };
const foreignAccounts = z
  .record(
    z.string().regex(/^[A-Z]{3}$/, 'valutakod måste vara tre versaler, t.ex. EUR'),
    z.object(payoutAccountsShape).strict(),
  )
  .refine((all) => !(BASE_CURRENCY in all), { message: `${BASE_CURRENCY} är bokföringsvalutan och anges med huvudkontona` });
export const accountMappingSchema = z.object({ ...payoutAccountsShape, foreign: foreignAccounts.optional() }).strict();

/** Sparar kontoplanen för en kund. Validerar att alla konton är giltiga kontonummer (1000–9999), även för andra valutor. */
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
      const rows = await db.query<{ mode: 'dry_run' | 'live'; accounts: unknown; status: string; allow_partial_payments: boolean }>(
        'select mode, accounts, status, allow_partial_payments from tenant where id = $1',
        [tenantId],
      );
      const row = rows[0];
      if (!row || row.status !== 'active' || !row.accounts) return null;
      const accounts = accountMappingSchema.safeParse(row.accounts);
      if (!accounts.success) return null;
      const { foreign, ...main } = accounts.data;
      return { accounts: foreign ? { ...main, foreign } : main, mode: row.mode, allowPartialPayments: row.allow_partial_payments };
    },
  };
}

/** Inställningar per kund som är av eller på. */
export type TenantOption = 'allowPartialPayments';
const OPTION_COLUMN: Record<TenantOption, string> = { allowPartialPayments: 'allow_partial_payments' };

/** Slår på eller av en inställning. Returnerar false om kunden inte finns. */
export async function setTenantOption(db: Db, tenantId: string, option: TenantOption, value: boolean): Promise<boolean> {
  const column = OPTION_COLUMN[option];
  if (!column) throw new Error(`Okänd inställning: ${String(option)}`);
  const rows = await db.query(`update tenant set ${column} = $2 where id = $1 returning id`, [tenantId, value]);
  return rows.length > 0;
}

/** Kunder som är redo att synkas: aktiva och med kontoplan. */
export async function listSyncableTenants(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select id from tenant where status = 'active' and accounts is not null order by id`,
  );
  return rows.map((r) => r.id);
}
