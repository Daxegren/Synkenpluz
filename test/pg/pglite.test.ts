import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll } from 'vitest';
import { createPgliteDb } from '../../src/db/db.js';
import { dbContract } from './contract.js';

// Kör kontraktssviten mot PGlite så att sviten själv är verifierad även utan riktig Postgres.
// En enda PGlite-instans (dyr att starta) delas; varje test får ett eget schema.
const pg = new PGlite();
afterAll(() => pg.close());

dbContract('PGlite', async () => {
  const schema = `t_${randomUUID().replace(/-/g, '')}`;
  await pg.exec(`create schema ${schema}; set search_path = ${schema}, pg_catalog;`);
  return { db: createPgliteDb(pg), close: async () => void (await pg.exec(`set search_path = public; drop schema ${schema} cascade;`)) };
});
