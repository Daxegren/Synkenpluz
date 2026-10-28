import type pg from 'pg';
import type { Db } from './db.js';

/**
 * Typparsning (per fråga, ingen global mutation av pg-types):
 *  - timestamptz/timestamp -> Date och int4/int2 -> number, jsonb/json -> objekt (pg:s standard, förankrat här).
 *  - int8/bigint (t.ex. count(*), bigserial) -> number när värdet är ett säkert heltal
 *    (|n| <= Number.MAX_SAFE_INTEGER), annars kastas RangeError. Det tappar alltså aldrig
 *    precision tyst. Behöver man större värden: cast till text/numeric i SQL.
 *  - numeric lämnas som sträng (pg:s standard), eftersom decimaler inte får bli float.
 */
const OID = { int8: 20, int2: 21, int4: 23, json: 114, jsonb: 3802, timestamp: 1114, timestamptz: 1184 } as const;

export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`bigint ${value} ryms inte exakt i ett JS-tal; cast till text i SQL`);
  }
  return n;
}

// Satt via `types`-alternativet i varje fråga; pg använder detta i stället för globala parsers.
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format === 'binary') throw new Error('binärt format stöds inte');
    switch (oid) {
      case OID.int8:
        return parseInt8;
      case OID.int2:
      case OID.int4:
        return (v: string) => Number.parseInt(v, 10);
      case OID.json:
      case OID.jsonb:
        return (v: string) => JSON.parse(v) as unknown;
      case OID.timestamptz:
        return (v: string) => new Date(v);
      default:
        return (v: string) => v;
    }
  },
};

// Minimalt gemensamt gränssnitt för Pool och PoolClient.
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

function wrap(client: Queryable, inTransaction: boolean, pool: pg.Pool): Db {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const result = await client.query({ text: sql, values: [...params], types });
      return result.rows as T[];
    },
    async exec(sql: string) {
      // Utan values används simple query protocol, som tillåter flera satser.
      await client.query({ text: sql, types });
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // Kapslade anrop återanvänder den pågående transaktionen.
      if (inTransaction) return fn(wrap(client, true, pool));
      const conn = await pool.connect();
      let broken = false;
      try {
        await conn.query('BEGIN');
        try {
          const result = await fn(wrap(conn, true, pool));
          await conn.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await conn.query('ROLLBACK');
          } catch {
            broken = true; // okänt anslutningstillstånd: släng klienten
          }
          throw err;
        }
      } finally {
        conn.release(broken ? true : undefined);
      }
    },
  };
}

export function createPgDb(pool: pg.Pool): Db {
  return wrap(pool, false, pool);
}
