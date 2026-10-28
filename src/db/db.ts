import type { PGlite, Transaction } from '@electric-sql/pglite';

/**
 * Minimalt databasgränssnitt som repositorierna skrivs mot. Implementeras av
 * PGlite i tester och av en riktig Postgres-klient i drift.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Kör flera SQL-satser utan parametrar (migrationer). */
  exec(sql: string): Promise<void>;
  /** Kör `fn` i en transaktion. Kastar `fn` rullas allt tillbaka. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

type Queryable = Pick<PGlite | Transaction, 'query' | 'exec'>;

function wrap(client: Queryable, inTransaction: boolean, pg: PGlite): Db {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const result = await client.query<T>(sql, [...params]);
      return result.rows;
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      // Kapslade anrop återanvänder den pågående transaktionen.
      if (inTransaction) return fn(wrap(client, true, pg));
      return pg.transaction((tx) => fn(wrap(tx, true, pg)));
    },
  };
}

export function createPgliteDb(pg: PGlite): Db {
  return wrap(pg, false, pg);
}
