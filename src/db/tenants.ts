import { generateApiKey, type ApiKeyRecord, type ApiKeyStore } from '../security/apiKeys.js';
import type { Db } from './db.js';

export type TenantStatus = 'active' | 'suspended';
export type TenantMode = 'dry_run' | 'live';

export interface Tenant {
  id: string;
  name: string;
  status: TenantStatus;
  mode: TenantMode;
  createdAt: Date;
}

export interface TenantRepository {
  /** Nya tenants startar alltid i dry_run. */
  create(input: { id: string; name: string }, now: Date): Promise<Tenant>;
  get(id: string): Promise<Tenant | null>;
  setStatus(id: string, status: TenantStatus): Promise<boolean>;
  setMode(id: string, mode: TenantMode): Promise<boolean>;
}

interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  mode: TenantMode;
  created_at: Date;
}

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  name: r.name,
  status: r.status,
  mode: r.mode,
  createdAt: r.created_at,
});

export function createTenantRepository(db: Db): TenantRepository {
  return {
    async create(input, now) {
      const rows = await db.query<TenantRow>(
        `insert into tenant (id, name, created_at) values ($1, $2, $3)
         returning id, name, status, mode, created_at`,
        [input.id, input.name, now],
      );
      return toTenant(rows[0] as TenantRow);
    },
    async get(id) {
      const rows = await db.query<TenantRow>('select id, name, status, mode, created_at from tenant where id = $1', [id]);
      return rows[0] ? toTenant(rows[0]) : null;
    },
    async setStatus(id, status) {
      const rows = await db.query('update tenant set status = $2 where id = $1 returning id', [id, status]);
      return rows.length > 0;
    },
    async setMode(id, mode) {
      const rows = await db.query('update tenant set mode = $2 where id = $1 returning id', [id, mode]);
      return rows.length > 0;
    },
  };
}

// ---------------------------------------------------------------- API-nycklar

/** Metadata om en nyckel. Innehåller varken hemligheten eller hashen. */
export interface ApiKeyInfo {
  id: string;
  tenantId: string;
  createdAt: Date;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

export interface ApiKeyRepository extends ApiKeyStore {
  /** Skapar en nyckel. `rawKey` returneras här och aldrig mer. */
  issue(tenantId: string, opts: { expiresAt?: Date | null }, now: Date, pepper: Buffer): Promise<{ id: string; rawKey: string }>;
  /** Tenant-scopead. Returnerar false om nyckeln inte tillhör tenant eller redan är återkallad. */
  revoke(tenantId: string, id: string, now: Date): Promise<boolean>;
  list(tenantId: string): Promise<ApiKeyInfo[]>;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  created_at: Date;
  revoked_at: Date | null;
  expires_at: Date | null;
  last_used_at: Date | null;
}

export function createApiKeyRepository(db: Db): ApiKeyRepository {
  return {
    async issue(tenantId, opts, now, pepper) {
      const key = generateApiKey(pepper);
      await db.query(
        'insert into api_key (id, tenant_id, hash, created_at, expires_at) values ($1, $2, $3, $4, $5)',
        [key.id, tenantId, key.hash, now, opts.expiresAt ?? null],
      );
      return { id: key.id, rawKey: key.rawKey };
    },
    async revoke(tenantId, id, now) {
      const rows = await db.query(
        'update api_key set revoked_at = $3 where id = $1 and tenant_id = $2 and revoked_at is null returning id',
        [id, tenantId, now],
      );
      return rows.length > 0;
    },
    async list(tenantId) {
      const rows = await db.query<ApiKeyRow>(
        `select id, tenant_id, created_at, revoked_at, expires_at, last_used_at
           from api_key where tenant_id = $1 order by created_at, id`,
        [tenantId],
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        lastUsedAt: r.last_used_at,
      }));
    },
    async findById(id): Promise<ApiKeyRecord | null> {
      const rows = await db.query<{
        id: string;
        tenant_id: string;
        hash: string;
        revoked_at: Date | null;
        expires_at: Date | null;
        tenant_status: TenantStatus;
      }>(
        `select k.id, k.tenant_id, k.hash, k.revoked_at, k.expires_at, t.status as tenant_status
           from api_key k join tenant t on t.id = k.tenant_id where k.id = $1`,
        [id],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        hash: r.hash,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        tenantStatus: r.tenant_status,
      };
    },
    async touchLastUsed(id, now) {
      await db.query('update api_key set last_used_at = $2 where id = $1', [id, now]);
    },
  };
}
