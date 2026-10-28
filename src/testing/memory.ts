import { randomUUID } from 'node:crypto';
import type { LedgerCommand, ReconcileException } from '../domain/types.js';
import type {
  CommandRepository,
  ExceptionRepository,
  ExceptionStatus,
  PayoutRecord,
  PayoutRepository,
  PayoutStatus,
  StoredCommand,
  StoredException,
} from '../ports/index.js';

/**
 * In-memory-implementationer av portarna, för tester. Alla läsningar returnerar
 * kopior så att anropare aldrig kan mutera lagrat tillstånd. Allt är scope:at
 * per tenant (även idempotensnycklar).
 */

const copy = <T>(value: T): T => structuredClone(value);

/** Tupel-nyckel utan risk för kollisioner mellan fält. */
const k = (...parts: readonly (string | null)[]): string => JSON.stringify(parts);

// ---------------------------------------------------------------- kommandon

interface CommandRow {
  stored: StoredCommand;
  lockedAt: Date | null;
}

export function createMemoryCommandRepository(): CommandRepository {
  const rows = new Map<string, CommandRow>(); // id -> rad, i insättningsordning
  const keys = new Set<string>(); // (tenant, key)

  return {
    async enqueue(tenantId, payoutId, commands: readonly LedgerCommand[], now) {
      let added = 0;
      for (const command of commands) {
        const uniq = k(tenantId, command.key);
        if (keys.has(uniq)) continue;
        keys.add(uniq);
        const id = randomUUID();
        rows.set(id, {
          lockedAt: null,
          stored: {
            id,
            tenantId,
            payoutId,
            key: command.key,
            command: copy(command),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(now),
            lastError: null,
            externalId: null,
          },
        });
        added++;
      }
      return added;
    },

    async claimDue(now, limit) {
      if (limit <= 0) return [];
      const due = [...rows.values()]
        .filter(
          (r) =>
            (r.stored.status === 'pending' || r.stored.status === 'failed') &&
            r.stored.nextAttemptAt.getTime() <= now.getTime(),
        )
        .sort((a, b) => a.stored.nextAttemptAt.getTime() - b.stored.nextAttemptAt.getTime())
        .slice(0, limit);
      for (const r of due) {
        r.stored.status = 'in_progress';
        r.stored.attempts += 1;
        r.lockedAt = new Date(now);
      }
      return due.map((r) => copy(r.stored));
    },

    async markSucceeded(id, externalId) {
      const r = rows.get(id);
      if (!r) return; // okänt id: no-op
      r.stored.status = 'succeeded';
      r.stored.externalId = externalId;
      r.stored.lastError = null;
      r.lockedAt = null;
    },

    async markFailed(id, error, retryAt) {
      const r = rows.get(id);
      if (!r) return;
      r.stored.lastError = error;
      r.lockedAt = null;
      if (retryAt === null) {
        r.stored.status = 'dead';
      } else {
        r.stored.status = 'failed';
        r.stored.nextAttemptAt = new Date(retryAt);
      }
    },

    async releaseStale(olderThan, now) {
      let released = 0;
      for (const r of rows.values()) {
        if (r.stored.status === 'in_progress' && r.lockedAt !== null && r.lockedAt.getTime() < olderThan.getTime()) {
          r.stored.status = 'pending';
          r.stored.nextAttemptAt = new Date(now);
          r.lockedAt = null;
          released++;
        }
      }
      return released;
    },

    async countDead() {
      return [...rows.values()].filter((r) => r.stored.status === 'dead').length;
    },

    async requeue(tenantId, id, now) {
      const r = rows.get(id);
      if (!r || r.stored.tenantId !== tenantId || r.stored.status !== 'dead') return false;
      r.stored.status = 'pending';
      r.stored.attempts = 0;
      r.stored.nextAttemptAt = new Date(now);
      r.lockedAt = null;
      return true;
    },

    async listByPayout(tenantId, payoutId) {
      return [...rows.values()]
        .filter((r) => r.stored.tenantId === tenantId && r.stored.payoutId === payoutId)
        .map((r) => copy(r.stored));
    },
  };
}

// ---------------------------------------------------------------- avvikelser

export function createMemoryExceptionRepository(): ExceptionRepository {
  const rows = new Map<string, StoredException>();
  const uniq = new Set<string>();

  return {
    async add(tenantId, payoutId, exceptions: readonly ReconcileException[], now) {
      let added = 0;
      for (const ex of exceptions) {
        const u = k(tenantId, payoutId, ex.code, ex.lineId ?? null);
        if (uniq.has(u)) continue;
        uniq.add(u);
        const id = randomUUID();
        rows.set(id, {
          id,
          tenantId,
          payoutId,
          code: ex.code,
          lineId: ex.lineId ?? null,
          message: ex.message,
          status: 'open',
          resolutionNote: null,
          createdAt: new Date(now),
          resolvedAt: null,
        });
        added++;
      }
      return added;
    },

    async list(tenantId, filter?: { status?: ExceptionStatus; payoutId?: string }) {
      return [...rows.values()]
        .filter(
          (e) =>
            e.tenantId === tenantId &&
            (filter?.status === undefined || e.status === filter.status) &&
            (filter?.payoutId === undefined || e.payoutId === filter.payoutId),
        )
        .map(copy);
    },

    async get(tenantId, id) {
      const e = rows.get(id);
      return e && e.tenantId === tenantId ? copy(e) : null;
    },

    async resolve(tenantId, id, outcome, now) {
      const e = rows.get(id);
      if (!e || e.tenantId !== tenantId || e.status !== 'open') return false;
      e.status = outcome.status;
      e.resolutionNote = outcome.note;
      e.resolvedAt = new Date(now);
      return true;
    },
  };
}

// ---------------------------------------------------------------- utbetalningar

export function createMemoryPayoutRepository(): PayoutRepository {
  const rows = new Map<string, PayoutRecord>();

  return {
    async record(entry) {
      rows.set(k(entry.tenantId, entry.payoutId), copy(entry));
    },
    async get(tenantId, payoutId) {
      const r = rows.get(k(tenantId, payoutId));
      return r ? copy(r) : null;
    },
    async list(tenantId, filter?: { status?: PayoutStatus }) {
      return [...rows.values()]
        .filter((p) => p.tenantId === tenantId && (filter?.status === undefined || p.status === filter.status))
        .map(copy);
    },
  };
}

export function createMemoryStore(): {
  commands: CommandRepository;
  exceptions: ExceptionRepository;
  payouts: PayoutRepository;
} {
  return {
    commands: createMemoryCommandRepository(),
    exceptions: createMemoryExceptionRepository(),
    payouts: createMemoryPayoutRepository(),
  };
}
