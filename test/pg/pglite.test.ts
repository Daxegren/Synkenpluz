import { PGlite } from '@electric-sql/pglite';
import { createPgliteDb } from '../../src/db/db.js';
import { dbContract } from './contract.js';

// Kör kontraktssviten mot PGlite så att sviten själv är verifierad även utan riktig Postgres.
dbContract('PGlite', async () => {
  const pg = new PGlite();
  return { db: createPgliteDb(pg), close: () => pg.close() };
});
