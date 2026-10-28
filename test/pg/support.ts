import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPgDb } from '../../src/db/pg.js';
import type { DbHandle } from './contract.js';

export const PG_URL = process.env.PG_TEST_URL;

/**
 * Skapar ett unikt schema per anrop och en egen pool vars search_path pekar dit.
 * Alla anslutningar i poolen ser därmed bara sitt eget schema; körningar stör inte varandra.
 */
export async function createSchemaDb(poolSize = 10): Promise<DbHandle & { pool: pg.Pool }> {
  const schema = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({
    connectionString: PG_URL,
    max: poolSize,
    options: `-c search_path=${schema},pg_catalog`,
  });
  return {
    db: createPgDb(pool),
    pool,
    async close() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
