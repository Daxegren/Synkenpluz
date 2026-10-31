import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrations.js';
import { createRepositories, createUnitOfWork } from '../../src/db/repositories.js';
import { parseInt8 } from '../../src/db/pg.js';
import { dbContract, pay, type DbHandle } from './contract.js';
import { createSchemaDb, PG_URL } from './support.js';

const skip = !PG_URL;

dbContract('Postgres', () => createSchemaDb(), { skip });

describe.skipIf(skip)('Postgres: samtidighet och adapter', () => {
  const open: DbHandle[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });
  async function setup(poolSize = 20) {
    const handle = await createSchemaDb(poolSize);
    open.push(handle);
    await migrate(handle.db);
    return { ...handle, repos: createRepositories(handle.db), uow: createUnitOfWork(handle.db) };
  }
  const now = new Date('2026-10-28T08:00:00Z');

  it('8 parallella arbetare tilldelas aldrig samma kommando och ordningen inom utbetalning hålls', async () => {
    const { repos } = await setup();
    // 50 kommandon: 10 utbetalningar x 5 kommandon.
    for (let p = 0; p < 10; p++) {
      await repos.commands.enqueue('T1', `P${p}`, Array.from({ length: 5 }, (_, i) => pay(`p${p}-${i}`)), now);
    }

    const claimedKeys: string[] = [];
    const worker = async () => {
      // Varje arbetare plockar och slutför tills inget är körbart.
      let idleRounds = 0;
      while (idleRounds < 3) {
        const batch = await repos.commands.claimDue(now, 3);
        if (batch.length === 0) {
          idleRounds++;
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }
        idleRounds = 0;
        for (const c of batch) {
          claimedKeys.push(c.key);
          await repos.commands.markSucceeded(c.id, `EXT-${c.key}`, now);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));

    expect(claimedKeys).toHaveLength(50);
    expect(new Set(claimedKeys).size).toBe(50); // inga dubbletter
    for (let p = 0; p < 10; p++) {
      const order = claimedKeys.filter((k) => k.startsWith(`p${p}-`));
      expect(order).toEqual([0, 1, 2, 3, 4].map((i) => `p${p}-${i}`));
    }
    for (let p = 0; p < 10; p++) {
      const stored = await repos.commands.listByPayout('T1', `P${p}`);
      expect(stored.every((c) => c.status === 'succeeded' && c.attempts === 1)).toBe(true);
    }
  });

  it('8 samtidiga claimDue på 50 köade (olika utbetalningar) ger disjunkta mängder', async () => {
    const { repos } = await setup();
    for (let p = 0; p < 50; p++) await repos.commands.enqueue('T1', `P${p}`, [pay(`k${p}`)], now);
    const results = await Promise.all(Array.from({ length: 8 }, () => repos.commands.claimDue(now, 10)));
    const keys = results.flat().map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(50);
    expect(await repos.commands.claimDue(now, 10)).toEqual([]);
  });

  it('claimDue under samtidig markSucceeded släpper aldrig fram ett kommando före dess föregångare', async () => {
    const { repos } = await setup();
    await repos.commands.enqueue('T1', 'P1', [pay('a1'), pay('a2'), pay('a3')], now);
    const done: string[] = [];
    const started: string[] = [];
    const worker = async () => {
      for (let i = 0; i < 40; i++) {
        for (const c of await repos.commands.claimDue(now, 5)) {
          started.push(c.key);
          // Föregångaren ska redan vara klar när efterföljaren startar. Det kontrolleras mot databasen, inte mot
          // `done`: en annan arbetare kan hinna hämta efterföljaren mellan att databasen markerat föregångaren
          // klar och att den arbetarens egen kod hunnit skriva i `done`. Status "klar" ändras aldrig tillbaka,
          // så en kontroll i efterhand är säker.
          const predecessor = c.key === 'a2' ? 'a1' : c.key === 'a3' ? 'a2' : null;
          if (predecessor) {
            const stored = await repos.commands.listByPayout('T1', 'P1');
            expect(stored.find((s) => s.key === predecessor)?.status).toBe('succeeded');
          }
          await repos.commands.markSucceeded(c.id, 'x', now);
          done.push(c.key);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(started).toEqual(['a1', 'a2', 'a3']);
  });

  it('två samtidiga enqueue för samma utbetalning med överlappande nycklar ger unika seq och inga förlorade/duplicerade kommandon', async () => {
    for (let round = 0; round < 5; round++) {
      const { repos, db } = await setup();
      const setA = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
      const setB = ['k4', 'k5', 'k6', 'k7', 'k8', 'k9'];
      const [a, b] = await Promise.all([
        repos.commands.enqueue('T1', 'P1', setA.map((k) => pay(k)), now),
        repos.commands.enqueue('T1', 'P1', setB.map((k) => pay(k)), now),
      ]);
      expect(a + b).toBe(9); // varje nyckel infogas exakt en gång
      const stored = await repos.commands.listByPayout('T1', 'P1');
      expect(stored.map((c) => c.key).sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
      // seq är 0..8 utan luckor eller dubbletter (listByPayout sorterar på seq).
      const rows = await db.query<{ seq: number }>('select seq from ledger_command order by seq');
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it('transaktion som kastar rullar tillbaka och frisläpper klienten', async () => {
    const { db, pool, repos } = await setup(2);
    for (let i = 0; i < 6; i++) {
      await expect(
        db.transaction(async (tx) => {
          await createRepositories(tx).payouts.record({ tenantId: 'T1', payoutId: `P${i}`, status: 'complete', processedAt: now });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    }
    expect(await repos.payouts.list('T1')).toEqual([]);
    expect(pool.idleCount).toBe(pool.totalCount); // inga läckta klienter (poolen har max 2)
    expect(pool.waitingCount).toBe(0);
  });

  it('ett SQL-fel inuti en transaktion rullar tillbaka tidigare satser', async () => {
    const { db, repos } = await setup();
    await expect(
      db.transaction(async (tx) => {
        await createRepositories(tx).payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'complete', processedAt: now });
        await tx.query('select * from finns_inte');
      }),
    ).rejects.toThrow(/finns_inte/);
    expect(await repos.payouts.get('T1', 'P1')).toBeNull();
  });

  it('en pågående transaktion är osynlig för andra anslutningar före commit', async () => {
    const { db, repos } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const tx = db.transaction(async (t) => {
      await createRepositories(t).payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'complete', processedAt: now });
      inserted();
      await gate;
    });
    await insertedP;
    expect(await repos.payouts.get('T1', 'P1')).toBeNull();
    release();
    await tx;
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
  });

  it('exec kör flera satser', async () => {
    const { db } = await setup();
    await db.exec('create table x (a int); insert into x values (1); insert into x values (2);');
    expect(await db.query('select a from x order by a')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('append-only-triggern gäller även över anslutningar och inuti transaktion', async () => {
    const { db, repos } = await setup();
    await repos.audit.append({ tenantId: 'T1', actor: 'a', action: 'x', details: {} }, now);
    await expect(db.transaction((tx) => tx.query("update audit_log set actor = 'z'"))).rejects.toThrow(/append-only/);
  });

  it('bigint: säkra heltal blir number, osäkra kastar i stället för att tappa precision', async () => {
    const { db } = await setup();
    expect(await db.query('select 9007199254740991::bigint as n')).toEqual([{ n: 9007199254740991 }]);
    await expect(db.query('select 9007199254740993::bigint as n')).rejects.toThrow(RangeError);
    expect(await db.query('select 9007199254740993::bigint::text as n')).toEqual([{ n: '9007199254740993' }]);
    expect(() => parseInt8('9223372036854775807')).toThrow(RangeError);
  });
});
