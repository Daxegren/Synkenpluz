import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepositories, createUnitOfWork } from '../../src/db/repositories.js';
import type { LedgerCommand } from '../../src/domain/types.js';
import { TestClock } from '../helpers.js';

/** En färsk, tom och ännu inte migrerad databas. `close` städar. */
export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}
export type DbFactory = () => Promise<DbHandle>;

export const pay = (key: string, invoiceId = 'A'): LedgerCommand => ({
  kind: 'register_invoice_payment',
  key,
  lineId: key,
  invoiceId,
  amount: 100,
  currency: 'SEK',
  date: '2026-10-28',
});

/**
 * Delad kontraktssvit: samma beteenden som test/db/repositories.test.ts, men mot valfri Db-implementation.
 * Varje test får en egen databas/schema från `factory`.
 */
export function dbContract(name: string, factory: DbFactory, options: { skip?: boolean } = {}): void {
  describe.skipIf(options.skip === true)(`${name}: Db-kontrakt`, () => {
    const open: DbHandle[] = [];
    afterEach(async () => {
      await Promise.all(open.splice(0).map((h) => h.close()));
    });

    async function stack() {
      const handle = await factory();
      open.push(handle);
      const { db } = handle;
      await migrate(db);
      return { db, clock: new TestClock(), repos: createRepositories(db), uow: createUnitOfWork(db) };
    }

    describe('migrationer', () => {
      it('körs exakt en gång', async () => {
        const { db } = await stack();
        expect(await migrate(db)).toEqual([]);
      });
    });

    describe('typer', () => {
      it('timestamptz -> Date, int4 -> number, count -> number, jsonb -> objekt', async () => {
        const { db } = await stack();
        const [row] = await db.query<{ t: Date; i: number; c: number; j: { a: number[] } }>(
          `select '2026-10-28T08:00:00Z'::timestamptz as t, 42::int4 as i, count(*) as c, '{"a":[1,2]}'::jsonb as j`,
        );
        expect(row?.t).toBeInstanceOf(Date);
        expect(row?.t.toISOString()).toBe('2026-10-28T08:00:00.000Z');
        expect(row?.i).toBe(42);
        expect(row?.c).toBe(1);
        expect(row?.j).toEqual({ a: [1, 2] });
      });
    });

    describe('kommandokö', () => {
      it('är idempotent på nyckel', async () => {
        const { repos, clock } = await stack();
        expect(await repos.commands.enqueue('T1', 'P1', [pay('k1'), pay('k2')], clock.now())).toBe(2);
        expect(await repos.commands.enqueue('T1', 'P1', [pay('k1'), pay('k2'), pay('k3')], clock.now())).toBe(1);
        const stored = await repos.commands.listByPayout('T1', 'P1');
        expect(stored.map((c) => c.key)).toEqual(['k1', 'k2', 'k3']);
      });

      it('släpper bara fram nästa kommando i en utbetalning när föregående lyckats', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1'), pay('a2')], clock.now());
        await repos.commands.enqueue('T1', 'P2', [pay('b1')], clock.now());

        const first = await repos.commands.claimDue(clock.now(), 10);
        expect(first.map((c) => c.key).sort()).toEqual(['a1', 'b1']);
        expect(first.every((c) => c.status === 'in_progress' && c.attempts === 1)).toBe(true);

        expect(await repos.commands.claimDue(clock.now(), 10)).toEqual([]);

        await repos.commands.markSucceeded(first.find((c) => c.key === 'a1')!.id, 'EXT-1', clock.now());
        const second = await repos.commands.claimDue(clock.now(), 10);
        expect(second.map((c) => c.key)).toEqual(['a2']);
      });

      it('ett dött kommando blockerar resten av utbetalningen', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1'), pay('a2')], clock.now());
        const [a1] = await repos.commands.claimDue(clock.now(), 10);
        await repos.commands.markFailed(a1!.id, 'permanent', null, clock.now());
        expect(await repos.commands.claimDue(clock.now(), 10)).toEqual([]);
        expect((await repos.commands.listByPayout('T1', 'P1'))[0]?.status).toBe('dead');
      });

      it('nya kommandon vid omkörning hamnar efter befintliga', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
        await repos.commands.enqueue('T1', 'P1', [pay('a2'), pay('a3')], clock.now());
        expect((await repos.commands.listByPayout('T1', 'P1')).map((c) => c.key)).toEqual(['a1', 'a2', 'a3']);
      });

      it('väntar med misslyckade kommandon tills retryAt', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
        const [a1] = await repos.commands.claimDue(clock.now(), 10);
        const retryAt = new Date(clock.now().getTime() + 60_000);
        await repos.commands.markFailed(a1!.id, 'tillfälligt', retryAt, clock.now());

        expect(await repos.commands.claimDue(clock.now(), 10)).toEqual([]);
        clock.advance(60_000);
        const [again] = await repos.commands.claimDue(clock.now(), 10);
        expect(again?.attempts).toBe(2);
        expect(again?.lastError).toBe('tillfälligt');
      });

      it('samma nyckel hos två kunder blockerar inte varandra', async () => {
        const { repos, clock } = await stack();
        expect(await repos.commands.enqueue('T1', 'P1', [pay('samma')], clock.now())).toBe(1);
        expect(await repos.commands.enqueue('T2', 'P1', [pay('samma')], clock.now())).toBe(1);
      });

      it('en försenad arbetare kan inte skriva över ett senare försöks utfall', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
        const [workerA] = await repos.commands.claimDue(clock.now(), 10);
        clock.advance(11 * 60_000);
        await repos.commands.releaseStale(new Date(clock.now().getTime() - 10 * 60_000), clock.now());
        const [workerB] = await repos.commands.claimDue(clock.now(), 10);
        await repos.commands.markSucceeded(workerB!.id, 'EXT-B', clock.now(), workerB!.attempts);
        await repos.commands.markFailed(workerA!.id, 'sent fel', new Date(clock.now().getTime() + 1000), clock.now(), workerA!.attempts);
        const [final] = await repos.commands.listByPayout('T1', 'P1');
        expect(final).toMatchObject({ status: 'succeeded', externalId: 'EXT-B', lastError: null });
      });

      it('släpper fastnade kommandon', async () => {
        const { repos, clock } = await stack();
        await repos.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
        await repos.commands.claimDue(clock.now(), 10);
        clock.advance(11 * 60_000);
        const released = await repos.commands.releaseStale(new Date(clock.now().getTime() - 10 * 60_000), clock.now());
        expect(released).toBe(1);
        expect(await repos.commands.claimDue(clock.now(), 10)).toHaveLength(1);
      });

      it('lagrar kommandot som det är', async () => {
        const { repos, clock } = await stack();
        const voucher: LedgerCommand = {
          kind: 'post_voucher',
          key: 'v1',
          date: '2026-10-28',
          description: 'Utbetalning P1',
          lines: [{ account: 1930, debit: 100, credit: 0 }, { account: 1580, debit: 0, credit: 100 }],
        };
        await repos.commands.enqueue('T1', 'P1', [voucher], clock.now());
        expect((await repos.commands.listByPayout('T1', 'P1'))[0]?.command).toEqual(voucher);
      });
    });

    describe('avvikelser', () => {
      const ex = { code: 'NO_MATCH' as const, lineId: 'L1', message: 'saknas' };

      it('lägger inte in samma öppna avvikelse två gånger', async () => {
        const { repos, clock } = await stack();
        expect(await repos.exceptions.add('T1', 'P1', [ex], clock.now())).toBe(1);
        expect(await repos.exceptions.add('T1', 'P1', [ex], clock.now())).toBe(0);
        expect(await repos.exceptions.list('T1')).toHaveLength(1);
      });

      it('en löst avvikelse kan uppstå igen som ny', async () => {
        const { repos, clock } = await stack();
        await repos.exceptions.add('T1', 'P1', [ex], clock.now());
        const [first] = await repos.exceptions.list('T1');
        expect(await repos.exceptions.resolve('T1', first!.id, { status: 'resolved', note: 'ok' }, clock.now())).toBe(true);
        expect(await repos.exceptions.add('T1', 'P1', [ex], clock.now())).toBe(1);
      });

      it('kan inte lösa samma avvikelse två gånger', async () => {
        const { repos, clock } = await stack();
        await repos.exceptions.add('T1', 'P1', [ex], clock.now());
        const [first] = await repos.exceptions.list('T1');
        expect(await repos.exceptions.resolve('T1', first!.id, { status: 'dismissed', note: 'a' }, clock.now())).toBe(true);
        expect(await repos.exceptions.resolve('T1', first!.id, { status: 'resolved', note: 'b' }, clock.now())).toBe(false);
      });

      it('isolerar tenants', async () => {
        const { repos, clock } = await stack();
        await repos.exceptions.add('T1', 'P1', [ex], clock.now());
        const [mine] = await repos.exceptions.list('T1');

        expect(await repos.exceptions.list('T2')).toEqual([]);
        expect(await repos.exceptions.get('T2', mine!.id)).toBeNull();
        expect(await repos.exceptions.resolve('T2', mine!.id, { status: 'resolved', note: 'x' }, clock.now())).toBe(false);
        expect((await repos.exceptions.get('T1', mine!.id))?.status).toBe('open');
      });

      it('filtrerar på status och utbetalning', async () => {
        const { repos, clock } = await stack();
        await repos.exceptions.add('T1', 'P1', [ex], clock.now());
        await repos.exceptions.add('T1', 'P2', [ex], clock.now());
        expect(await repos.exceptions.list('T1', { payoutId: 'P2' })).toHaveLength(1);
        expect(await repos.exceptions.list('T1', { status: 'resolved' })).toHaveLength(0);
      });
    });

    describe('utbetalningar', () => {
      it('skriver över senaste status och isolerar tenants', async () => {
        const { repos, clock } = await stack();
        await repos.payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'partial', processedAt: clock.now() });
        await repos.payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'complete', processedAt: clock.now() });
        expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
        expect(await repos.payouts.get('T2', 'P1')).toBeNull();
        expect(await repos.payouts.list('T1', { status: 'complete' })).toHaveLength(1);
      });
    });

    describe('revisionslogg', () => {
      it('är append-only', async () => {
        const { repos, db, clock } = await stack();
        await repos.audit.append({ tenantId: 'T1', actor: 'system', action: 'x', details: { n: 1 } }, clock.now());
        const [entry] = await repos.audit.list('T1');
        expect(entry?.details).toEqual({ n: 1 });
        expect(entry?.at).toBeInstanceOf(Date);
        await expect(db.query("update audit_log set action = 'y'")).rejects.toThrow(/append-only/);
        await expect(db.query('delete from audit_log')).rejects.toThrow(/append-only/);
        await expect(db.query('truncate audit_log')).rejects.toThrow(/append-only/);
        expect(await repos.audit.list('T1')).toHaveLength(1);
      });
    });

    describe('arbetsenhet', () => {
      it('rullar tillbaka allt om något misslyckas', async () => {
        const { uow, repos, clock } = await stack();
        await expect(
          uow.run(async (r) => {
            await r.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
            await r.payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'complete', processedAt: clock.now() });
            throw new Error('avbrott');
          }),
        ).rejects.toThrow('avbrott');

        expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
        expect(await repos.payouts.get('T1', 'P1')).toBeNull();
      });

      it('kapslade transaction återanvänder den pågående och rullar tillbaka tillsammans', async () => {
        const { db, repos, clock } = await stack();
        await expect(
          db.transaction(async (tx) => {
            await createRepositories(tx).payouts.record({ tenantId: 'T1', payoutId: 'P1', status: 'partial', processedAt: clock.now() });
            await tx.transaction(async (inner) => {
              await createRepositories(inner).payouts.record({ tenantId: 'T1', payoutId: 'P2', status: 'partial', processedAt: clock.now() });
            });
            throw new Error('yttre');
          }),
        ).rejects.toThrow('yttre');
        expect(await repos.payouts.list('T1')).toEqual([]);
      });
    });
  });
}
