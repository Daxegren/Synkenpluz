import type { LedgerCommand } from '../domain/types.js';
import type {
  AuditEntry,
  AuditLog,
  CommandRepository,
  CommandStatus,
  ExceptionRepository,
  ExceptionStatus,
  PayoutRepository,
  PayoutStatus,
  Repositories,
  StoredCommand,
  StoredException,
  UnitOfWork,
} from '../ports/index.js';
import type { Db } from './db.js';

interface CommandRow {
  id: string;
  tenant_id: string;
  payout_id: string;
  key: string;
  command: LedgerCommand;
  status: CommandStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  external_id: string | null;
  seq: number;
}

const toCommand = (r: CommandRow): StoredCommand => ({
  id: r.id,
  tenantId: r.tenant_id,
  payoutId: r.payout_id,
  key: r.key,
  command: r.command,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  externalId: r.external_id,
});

export function createCommandRepository(db: Db): CommandRepository {
  return {
    async enqueue(tenantId, payoutId, commands, now) {
      if (commands.length === 0) return 0;
      // Kommandona i en utbetalning utförs i ordning (seq). Nya kommandon vid omkörning
      // hamnar efter redan köade, så att t.ex. verifikatet aldrig går före sina betalningar.
      return db.transaction(async (tx) => {
        // Serialisera köande per utbetalning så att två samtidiga omkörningar inte får samma seq.
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:${payoutId}`]);
        const [{ next_seq } = { next_seq: 0 }] = await tx.query<{ next_seq: number }>(
          'select coalesce(max(seq) + 1, 0)::int as next_seq from ledger_command where tenant_id = $1 and payout_id = $2',
          [tenantId, payoutId],
        );
        let seq = next_seq;
        let inserted = 0;
        for (const command of commands) {
          const rows = await tx.query(
            `insert into ledger_command
               (tenant_id, payout_id, seq, key, command, status, next_attempt_at, created_at, updated_at)
             values ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $6, $6)
             on conflict (key) do nothing
             returning id`,
            [tenantId, payoutId, seq, command.key, JSON.stringify(command), now],
          );
          if (rows.length > 0) {
            inserted++;
            seq++;
          }
        }
        return inserted;
      });
    },

    async claimDue(now, limit) {
      // Ett kommando är körbart först när alla tidigare kommandon i samma utbetalning lyckats.
      // Ett kommando som blivit 'dead' blockerar därmed resten tills en människa tagit hand om det.
      const rows = await db.query<CommandRow>(
        `with due as (
           select c.id from ledger_command c
            where c.status in ('pending', 'failed')
              and c.next_attempt_at <= $1
              and not exists (
                select 1 from ledger_command earlier
                 where earlier.tenant_id = c.tenant_id
                   and earlier.payout_id = c.payout_id
                   and earlier.seq < c.seq
                   and earlier.status <> 'succeeded')
            order by c.next_attempt_at, c.created_at, c.seq
            limit $2
            for update skip locked)
         update ledger_command c
            set status = 'in_progress', attempts = c.attempts + 1, locked_at = $1, updated_at = $1
           from due where c.id = due.id
         returning c.*`,
        [now, limit],
      );
      return rows.sort((a, b) => a.seq - b.seq).map(toCommand);
    },

    async markSucceeded(id, externalId, now) {
      await db.query(
        `update ledger_command
            set status = 'succeeded', external_id = $2, last_error = null, locked_at = null, updated_at = $3
          where id = $1`,
        [id, externalId, now],
      );
    },

    async markFailed(id, error, retryAt, now) {
      await db.query(
        `update ledger_command
            set status = $2, last_error = $3, locked_at = null, updated_at = $4,
                next_attempt_at = coalesce($5, next_attempt_at)
          where id = $1`,
        [id, retryAt ? 'failed' : 'dead', error, now, retryAt],
      );
    },

    async releaseStale(olderThan, now) {
      const rows = await db.query(
        `update ledger_command
            set status = 'failed', locked_at = null, updated_at = $2, next_attempt_at = $2,
                last_error = coalesce(last_error, 'Frisläppt efter avbrott')
          where status = 'in_progress' and locked_at < $1
          returning id`,
        [olderThan, now],
      );
      return rows.length;
    },

    async listByPayout(tenantId, payoutId) {
      const rows = await db.query<CommandRow>(
        'select * from ledger_command where tenant_id = $1 and payout_id = $2 order by seq',
        [tenantId, payoutId],
      );
      return rows.map(toCommand);
    },
  };
}

interface ExceptionRow {
  id: string;
  tenant_id: string;
  payout_id: string;
  code: StoredException['code'];
  line_id: string | null;
  message: string;
  status: ExceptionStatus;
  resolution_note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

const toException = (r: ExceptionRow): StoredException => ({
  id: r.id,
  tenantId: r.tenant_id,
  payoutId: r.payout_id,
  code: r.code,
  lineId: r.line_id,
  message: r.message,
  status: r.status,
  resolutionNote: r.resolution_note,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

export function createExceptionRepository(db: Db): ExceptionRepository {
  return {
    async add(tenantId, payoutId, exceptions, now) {
      let inserted = 0;
      for (const ex of exceptions) {
        const rows = await db.query(
          `insert into reconcile_exception (tenant_id, payout_id, code, line_id, message, status, created_at)
           values ($1, $2, $3, $4, $5, 'open', $6)
           on conflict (tenant_id, payout_id, code, coalesce(line_id, '')) where status = 'open' do nothing
           returning id`,
          [tenantId, payoutId, ex.code, ex.lineId ?? null, ex.message, now],
        );
        inserted += rows.length;
      }
      return inserted;
    },

    async list(tenantId, filter = {}) {
      const rows = await db.query<ExceptionRow>(
        `select * from reconcile_exception
          where tenant_id = $1
            and ($2::text is null or status = $2)
            and ($3::text is null or payout_id = $3)
          order by created_at, id`,
        [tenantId, filter.status ?? null, filter.payoutId ?? null],
      );
      return rows.map(toException);
    },

    async get(tenantId, id) {
      const rows = await db.query<ExceptionRow>(
        'select * from reconcile_exception where tenant_id = $1 and id::text = $2',
        [tenantId, id],
      );
      return rows[0] ? toException(rows[0]) : null;
    },

    async resolve(tenantId, id, outcome, now) {
      const rows = await db.query(
        `update reconcile_exception
            set status = $3, resolution_note = $4, resolved_at = $5
          where tenant_id = $1 and id::text = $2 and status = 'open'
          returning id`,
        [tenantId, id, outcome.status, outcome.note, now],
      );
      return rows.length > 0;
    },
  };
}

interface PayoutRow {
  tenant_id: string;
  payout_id: string;
  status: PayoutStatus;
  processed_at: Date;
}

const toPayout = (r: PayoutRow) => ({
  tenantId: r.tenant_id,
  payoutId: r.payout_id,
  status: r.status,
  processedAt: r.processed_at,
});

export function createPayoutRepository(db: Db): PayoutRepository {
  return {
    async record(entry) {
      await db.query(
        `insert into payout (tenant_id, payout_id, status, processed_at)
         values ($1, $2, $3, $4)
         on conflict (tenant_id, payout_id) do update
           set status = excluded.status, processed_at = excluded.processed_at`,
        [entry.tenantId, entry.payoutId, entry.status, entry.processedAt],
      );
    },
    async get(tenantId, payoutId) {
      const rows = await db.query<PayoutRow>('select * from payout where tenant_id = $1 and payout_id = $2', [
        tenantId,
        payoutId,
      ]);
      return rows[0] ? toPayout(rows[0]) : null;
    },
    async list(tenantId, filter = {}) {
      const rows = await db.query<PayoutRow>(
        `select * from payout where tenant_id = $1 and ($2::text is null or status = $2) order by processed_at, payout_id`,
        [tenantId, filter.status ?? null],
      );
      return rows.map(toPayout);
    },
  };
}

export function createAuditLog(db: Db): AuditLog {
  return {
    async append(entry: AuditEntry, now: Date) {
      await db.query(
        'insert into audit_log (tenant_id, at, actor, action, details) values ($1, $2, $3, $4, $5::jsonb)',
        [entry.tenantId, now, entry.actor, entry.action, JSON.stringify(entry.details)],
      );
    },
    async list(tenantId, limit = 100) {
      const rows = await db.query<{ tenant_id: string; at: Date; actor: string; action: string; details: Record<string, unknown> }>(
        'select * from audit_log where tenant_id = $1 order by id desc limit $2',
        [tenantId, limit],
      );
      return rows.map((r) => ({ tenantId: r.tenant_id, at: r.at, actor: r.actor, action: r.action, details: r.details }));
    },
  };
}

export function createRepositories(db: Db): Repositories {
  return {
    commands: createCommandRepository(db),
    exceptions: createExceptionRepository(db),
    payouts: createPayoutRepository(db),
    audit: createAuditLog(db),
  };
}

export function createUnitOfWork(db: Db): UnitOfWork {
  return {
    run: (fn) => db.transaction((tx) => fn(createRepositories(tx))),
  };
}
