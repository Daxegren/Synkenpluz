import type { Db } from './db.js';

export interface Migration {
  id: string;
  sql: string;
}

/** Migrationer körs i ordning, exakt en gång. Ändra aldrig en körd migration, lägg till en ny. */
export const migrations: readonly Migration[] = [
  {
    id: '001_init',
    sql: `
      create table ledger_command (
        id              uuid primary key default gen_random_uuid(),
        tenant_id       text        not null,
        payout_id       text        not null,
        seq             integer     not null,
        key             text        not null unique,
        command         jsonb       not null,
        status          text        not null check (status in ('pending','in_progress','succeeded','failed','dead')),
        attempts        integer     not null default 0,
        next_attempt_at timestamptz not null,
        last_error      text,
        external_id     text,
        locked_at       timestamptz,
        created_at      timestamptz not null,
        updated_at      timestamptz not null,
        unique (tenant_id, payout_id, seq)
      );
      create index ledger_command_due on ledger_command (status, next_attempt_at);
      create index ledger_command_payout on ledger_command (tenant_id, payout_id, seq);

      create table reconcile_exception (
        id              uuid primary key default gen_random_uuid(),
        tenant_id       text        not null,
        payout_id       text        not null,
        code            text        not null,
        line_id         text,
        message         text        not null,
        status          text        not null check (status in ('open','resolved','dismissed')),
        resolution_note text,
        created_at      timestamptz not null,
        resolved_at     timestamptz
      );
      create unique index reconcile_exception_identity
        on reconcile_exception (tenant_id, payout_id, code, coalesce(line_id, ''))
        where status = 'open';
      create index reconcile_exception_tenant on reconcile_exception (tenant_id, status);

      create table payout (
        tenant_id    text        not null,
        payout_id    text        not null,
        status       text        not null check (status in ('rejected','partial','complete')),
        processed_at timestamptz not null,
        primary key (tenant_id, payout_id)
      );

      create table audit_log (
        id        bigserial primary key,
        tenant_id text        not null,
        at        timestamptz not null,
        actor     text        not null,
        action    text        not null,
        details   jsonb       not null
      );
      create index audit_log_tenant on audit_log (tenant_id, id desc);

      -- Revisionsloggen är append-only: uppdatering och radering är förbjudet.
      create function audit_log_immutable() returns trigger as $$
      begin
        raise exception 'audit_log är append-only';
      end;
      $$ language plpgsql;
      create trigger audit_log_no_update before update or delete on audit_log
        for each row execute function audit_log_immutable();
    `,
  },
  {
    id: '002_tenants_connections',
    sql: `
      create table tenant (
        id         text primary key,
        name       text        not null,
        status     text        not null default 'active' check (status in ('active','suspended')),
        mode       text        not null default 'dry_run' check (mode in ('dry_run','live')),
        created_at timestamptz not null
      );

      create table api_key (
        id           text primary key,
        tenant_id    text        not null references tenant (id),
        hash         text        not null,
        created_at   timestamptz not null,
        revoked_at   timestamptz,
        expires_at   timestamptz,
        last_used_at timestamptz
      );
      create index api_key_tenant on api_key (tenant_id);

      create table connection (
        id                    text primary key,
        tenant_id             text        not null references tenant (id),
        provider              text        not null,
        encrypted_credentials text        not null,
        key_id                text        not null,
        status                text        not null default 'active' check (status in ('active','disabled','needs_reauth')),
        created_at            timestamptz not null,
        updated_at            timestamptz not null,
        unique (tenant_id, provider)
      );
    `,
  },
  {
    id: '003_sync_state_and_accounts',
    sql: `
      -- Kontoplan per kund för bokföring av utbetalningar: {bank, clearing, feeExpense, feeVat}.
      alter table tenant add column accounts jsonb;

      create table sync_state (
        tenant_id  text primary key references tenant (id),
        cursor     text,
        updated_at timestamptz not null
      );
    `,
  },
  {
    id: '004_command_key_per_tenant_and_audit_truncate',
    sql: `
      -- Idempotensnyckeln var globalt unik: en kunds nyckel kunde tyst blockera en annans kommando.
      alter table ledger_command drop constraint ledger_command_key_key;
      alter table ledger_command add constraint ledger_command_tenant_key unique (tenant_id, key);

      -- Radtriggern stoppar UPDATE/DELETE men inte TRUNCATE. Samma funktion stoppar även den.
      create trigger audit_log_no_truncate before truncate on audit_log
        for each statement execute function audit_log_immutable();
    `,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await db.query<{ id: string }>('select id from schema_migrations')).map((r) => r.id));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('insert into schema_migrations (id) values ($1)', [migration.id]);
    });
    ran.push(migration.id);
  }
  return ran;
}
