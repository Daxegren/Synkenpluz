import type { ReconcileResult } from '../domain/types.js';
import type { ProposalRepository, StoredProposal } from '../ports/index.js';
import type { Db } from './db.js';

interface Row {
  tenant_id: string;
  payout_id: string;
  status: ReconcileResult['status'];
  result: ReconcileResult;
  updated_at: Date;
}

const toProposal = (r: Row): StoredProposal => ({
  tenantId: r.tenant_id,
  payoutId: r.payout_id,
  status: r.status,
  result: r.result,
  updatedAt: r.updated_at,
});

/** Stabil serialisering (sorterade nycklar), eftersom jsonb inte bevarar nyckelordning. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createProposalRepository(db: Db): ProposalRepository {
  return {
    async upsert(tenantId, payoutId, result, now) {
      const existing = await db.query<Row>('select * from dry_run_proposal where tenant_id = $1 and payout_id = $2', [
        tenantId,
        payoutId,
      ]);
      // Oförändrat förslag: rör inte raden (så att updated_at visar när det senast ändrades).
      if (existing[0] && canonical(existing[0].result) === canonical(result)) return false;
      await db.query(
        `insert into dry_run_proposal (tenant_id, payout_id, status, result, updated_at)
         values ($1, $2, $3, $4::jsonb, $5)
         on conflict (tenant_id, payout_id) do update
           set status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`,
        [tenantId, payoutId, result.status, JSON.stringify(result), now],
      );
      return true;
    },

    async list(tenantId, filter = {}) {
      const rows = await db.query<Row>(
        `select * from dry_run_proposal
          where tenant_id = $1 and ($2::text is null or status = $2)
          order by updated_at, payout_id`,
        [tenantId, filter.status ?? null],
      );
      return rows.map(toProposal);
    },

    async get(tenantId, payoutId) {
      const rows = await db.query<Row>('select * from dry_run_proposal where tenant_id = $1 and payout_id = $2', [
        tenantId,
        payoutId,
      ]);
      return rows[0] ? toProposal(rows[0]) : null;
    },

    async delete(tenantId, payoutId) {
      const rows = await db.query('delete from dry_run_proposal where tenant_id = $1 and payout_id = $2 returning payout_id', [
        tenantId,
        payoutId,
      ]);
      return rows.length > 0;
    },
  };
}
