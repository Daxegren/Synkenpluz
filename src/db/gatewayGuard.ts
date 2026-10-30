import type { GatewayGuardStore, GuardBegin } from '../ports/index.js';
import type { Db } from './db.js';

/** Postgres-version av journalen över gateway-anrop. Se GuardedLedgerGateway. */
export function createGatewayGuardStore(db: Db): GatewayGuardStore {
  return {
    async begin(tenantId, key, now): Promise<GuardBegin> {
      return db.transaction(async (tx) => {
        const inserted = await tx.query(
          `insert into gateway_guard (tenant_id, key, state, started_at) values ($1, $2, 'started', $3)
           on conflict (tenant_id, key) do nothing returning key`,
          [tenantId, key, now],
        );
        if (inserted.length > 0) return { outcome: 'acquired' };
        const [row] = await tx.query<{ state: 'started' | 'done'; external_id: string | null; started_at: Date }>(
          'select state, external_id, started_at from gateway_guard where tenant_id = $1 and key = $2',
          [tenantId, key],
        );
        if (row?.state === 'done') return { outcome: 'done', externalId: row.external_id ?? '' };
        return { outcome: 'in_doubt', startedAt: row?.started_at ?? now };
      });
    },

    async complete(tenantId, key, externalId, now) {
      await db.query(
        `update gateway_guard set state = 'done', external_id = $3, completed_at = $4
          where tenant_id = $1 and key = $2`,
        [tenantId, key, externalId, now],
      );
    },

    async abort(tenantId, key) {
      // Bara ett pågående anrop släpps. Ett som redan är klart får aldrig raderas.
      await db.query(`delete from gateway_guard where tenant_id = $1 and key = $2 and state = 'started'`, [tenantId, key]);
    },

    async resolve(tenantId, key, outcome, now) {
      if (outcome.applied) {
        const rows = await db.query(
          `update gateway_guard set state = 'done', external_id = $3, completed_at = $4
            where tenant_id = $1 and key = $2 and state = 'started' returning key`,
          [tenantId, key, outcome.externalId, now],
        );
        return rows.length > 0;
      }
      const rows = await db.query(
        `delete from gateway_guard where tenant_id = $1 and key = $2 and state = 'started' returning key`,
        [tenantId, key],
      );
      return rows.length > 0;
    },

    async listInDoubt(tenantId) {
      const rows = await db.query<{ tenant_id: string; key: string; started_at: Date }>(
        `select tenant_id, key, started_at from gateway_guard
          where state = 'started' and ($1::text is null or tenant_id = $1) order by started_at`,
        [tenantId ?? null],
      );
      return rows.map((r) => ({ tenantId: r.tenant_id, key: r.key, startedAt: r.started_at }));
    },
  };
}
