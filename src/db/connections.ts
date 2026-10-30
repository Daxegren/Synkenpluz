import { randomUUID } from 'node:crypto';
import { blobKeyId, decryptSecret, encryptSecret, type KeyProvider } from '../security/crypto.js';
import type { Db } from './db.js';

export type ConnectionStatus = 'active' | 'disabled' | 'needs_reauth';

/** Leverantörens inloggningsuppgifter (token, refresh-token m.m.). Lämnas bara ut av getCredentialsForExecution. */
export type Credentials = Record<string, string>;

/** Metadata. Innehåller aldrig uppgifter, varken i klartext eller krypterad form. */
export interface ConnectionInfo {
  id: string;
  tenantId: string;
  provider: string;
  status: ConnectionStatus;
  /** Nyckel-id som uppgifterna är krypterade med (för att följa upp rotation). */
  keyId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionRepository {
  /** Skapar eller ersätter uppgifterna för (tenant, provider). Krypteras med aktuell nyckel. */
  upsert(tenantId: string, provider: string, credentials: Credentials, now: Date): Promise<ConnectionInfo>;
  list(tenantId: string): Promise<ConnectionInfo[]>;
  getInfo(tenantId: string, provider: string): Promise<ConnectionInfo | null>;
  setStatus(tenantId: string, provider: string, status: ConnectionStatus, now: Date): Promise<boolean>;
  /** ENDAST för intern körning mot leverantörens API. Returnerar klartext; får aldrig loggas eller skickas ut. */
  getCredentialsForExecution(tenantId: string, provider: string): Promise<Credentials | null>;
  /** Krypterar om med aktuell nyckel (nyckelrotation). Returnerar antal omkrypterade rader. */
  reencryptAll(now: Date, tenantId?: string): Promise<number>;
  delete(tenantId: string, provider: string): Promise<boolean>;
}

const FIELD = 'credentials';

interface InfoRow {
  id: string;
  tenant_id: string;
  provider: string;
  status: ConnectionStatus;
  key_id: string;
  created_at: Date;
  updated_at: Date;
}

const INFO_COLUMNS = 'id, tenant_id, provider, status, key_id, created_at, updated_at';

const toInfo = (r: InfoRow): ConnectionInfo => ({
  id: r.id,
  tenantId: r.tenant_id,
  provider: r.provider,
  status: r.status,
  keyId: r.key_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createConnectionRepository(db: Db, keys: KeyProvider): ConnectionRepository {
  const seal = (c: Credentials, tenantId: string, connectionId: string) =>
    encryptSecret(JSON.stringify(c), keys, { tenantId, connectionId, field: FIELD });

  return {
    async upsert(tenantId, provider, credentials, now) {
      return db.transaction(async (tx) => {
        const existing = await tx.query<{ id: string }>(
          'select id from connection where tenant_id = $1 and provider = $2 for update',
          [tenantId, provider],
        );
        if (existing[0]) {
          const blob = await seal(credentials, tenantId, existing[0].id);
          const rows = await tx.query<InfoRow>(
            `update connection set encrypted_credentials = $3, key_id = $4, updated_at = $5, status = 'active'
              where id = $1 and tenant_id = $2 returning ${INFO_COLUMNS}`,
            [existing[0].id, tenantId, blob, blobKeyId(blob), now],
          );
          return toInfo(rows[0] as InfoRow);
        }
        const id = randomUUID();
        const blob = await seal(credentials, tenantId, id);
        const rows = await tx.query<InfoRow>(
          `insert into connection (id, tenant_id, provider, encrypted_credentials, key_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $6) returning ${INFO_COLUMNS}`,
          [id, tenantId, provider, blob, blobKeyId(blob), now],
        );
        return toInfo(rows[0] as InfoRow);
      });
    },

    async list(tenantId) {
      const rows = await db.query<InfoRow>(
        `select ${INFO_COLUMNS} from connection where tenant_id = $1 order by provider`,
        [tenantId],
      );
      return rows.map(toInfo);
    },

    async getInfo(tenantId, provider) {
      const rows = await db.query<InfoRow>(
        `select ${INFO_COLUMNS} from connection where tenant_id = $1 and provider = $2`,
        [tenantId, provider],
      );
      return rows[0] ? toInfo(rows[0]) : null;
    },

    async setStatus(tenantId, provider, status, now) {
      const rows = await db.query(
        'update connection set status = $3, updated_at = $4 where tenant_id = $1 and provider = $2 returning id',
        [tenantId, provider, status, now],
      );
      return rows.length > 0;
    },

    async getCredentialsForExecution(tenantId, provider) {
      const rows = await db.query<{ id: string; encrypted_credentials: string }>(
        // Bara aktiva kopplingar lämnar ut uppgifter. En avstängd koppling eller en som behöver ny inloggning får inte användas.
        `select id, encrypted_credentials from connection where tenant_id = $1 and provider = $2 and status = 'active'`,
        [tenantId, provider],
      );
      const row = rows[0];
      if (!row) return null;
      const json = await decryptSecret(row.encrypted_credentials, keys, {
        tenantId,
        connectionId: row.id,
        field: FIELD,
      });
      return JSON.parse(json) as Credentials;
    },

    async reencryptAll(now, tenantId) {
      return db.transaction(async (tx) => {
        const rows = await tx.query<{ id: string; tenant_id: string; encrypted_credentials: string; key_id: string }>(
          `select id, tenant_id, encrypted_credentials, key_id from connection
            ${tenantId === undefined ? '' : 'where tenant_id = $1'} for update`,
          tenantId === undefined ? [] : [tenantId],
        );
        const current = keys.currentKeyId();
        let n = 0;
        for (const r of rows) {
          if (r.key_id === current) continue;
          const ctx = { tenantId: r.tenant_id, connectionId: r.id, field: FIELD };
          const plain = await decryptSecret(r.encrypted_credentials, keys, ctx);
          const blob = await encryptSecret(plain, keys, ctx);
          await tx.query(
            'update connection set encrypted_credentials = $2, key_id = $3, updated_at = $4 where id = $1',
            [r.id, blob, blobKeyId(blob), now],
          );
          n++;
        }
        return n;
      });
    },

    async delete(tenantId, provider) {
      const rows = await db.query('delete from connection where tenant_id = $1 and provider = $2 returning id', [tenantId, provider]);
      return rows.length > 0;
    },
  };
}
