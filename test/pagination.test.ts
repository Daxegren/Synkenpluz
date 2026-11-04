import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createGatewayGuardStore } from '../src/db/gatewayGuard.js';
import { createProposalRepository } from '../src/db/proposals.js';
import { MemoryGatewayGuardStore } from '../src/gateways/fakeGuard.js';
import { FORTNOX_RATE_LIMIT, createRateLimiter } from '../src/http/rateLimiter.js';
import type { ReconcileResult } from '../src/domain/types.js';
import type { GatewayGuardStore, ProposalRepository } from '../src/ports/index.js';
import { createMemoryGatewayGuardStore, createMemoryProposalRepository, createMemoryStore } from '../src/testing/memory.js';
import { TestClock, createTestDb } from './helpers.js';

const result = (n: number): ReconcileResult => ({
  status: 'partial',
  commands: [],
  exceptions: [{ code: 'NO_MATCH', lineId: `L${n}`, message: `m${n}` }],
});

/** Samma krav på varje implementation: sidor är stabila, täcker allt exakt en gång, och kunder är isolerade. */
function proposalContract(name: string, make: () => Promise<{ repo: ProposalRepository; clock: TestClock }>) {
  describe(`förslag: sidindelning (${name})`, () => {
    it('ger stabila sidor som tillsammans täcker allt exakt en gång', async () => {
      const { repo, clock } = await make();
      // Samma tidsstämpel för flera: ordningen avgörs då av utbetalnings-id.
      for (let i = 0; i < 12; i++) {
        await repo.upsert('T1', `P${String(i).padStart(2, '0')}`, result(i), clock.now());
        if (i % 4 === 3) clock.advance(1000);
      }
      await repo.upsert('T2', 'ANNAN', result(99), clock.now());

      const all = (await repo.list('T1')).map((p) => p.payoutId);
      expect(all).toHaveLength(12);
      const pages: string[] = [];
      for (let offset = 0; offset < 12; offset += 5) pages.push(...(await repo.list('T1', { limit: 5, offset })).map((p) => p.payoutId));
      expect(pages).toEqual(all);
      expect(new Set(pages).size).toBe(12);
      expect(await repo.list('T1', { limit: 5, offset: 12 })).toEqual([]);
      expect(all).not.toContain('ANNAN');
    });

    it('kombinerar status med sidindelning', async () => {
      const { repo, clock } = await make();
      for (let i = 0; i < 6; i++) await repo.upsert('T1', `P${i}`, i % 2 === 0 ? result(i) : { status: 'complete', commands: [], exceptions: [] }, clock.now());
      const partial = await repo.list('T1', { status: 'partial', limit: 2, offset: 1 });
      expect(partial.map((p) => p.payoutId)).toEqual(['P2', 'P4']);
    });
  });
}

function guardContract(name: string, make: () => Promise<{ guard: GatewayGuardStore; clock: TestClock }>) {
  describe(`osäkra anrop: sidindelning (${name})`, () => {
    it('ger stabila sidor, och en annan kunds anrop räknas inte', async () => {
      const { guard, clock } = await make();
      for (let i = 0; i < 7; i++) {
        await guard.begin('T1', `k${i}`, clock.now()); // samma starttid: nyckeln avgör ordningen
        if (i === 4) clock.advance(1000);
      }
      await guard.begin('T2', 'annan', clock.now());
      const all = (await guard.listInDoubt('T1')).map((g) => g.key);
      expect(all).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
      const paged: string[] = [];
      for (let offset = 0; offset < 7; offset += 3) paged.push(...(await guard.listInDoubt('T1', { limit: 3, offset })).map((g) => g.key));
      expect(paged).toEqual(all);
    });
  });
}

proposalContract('PGlite', async () => {
  const { db } = await createTestDb();
  return { repo: createProposalRepository(db), clock: new TestClock() };
});
proposalContract('minnet', async () => ({ repo: createMemoryProposalRepository(), clock: new TestClock() }));
guardContract('PGlite', async () => {
  const { db } = await createTestDb();
  return { guard: createGatewayGuardStore(db), clock: new TestClock() };
});
guardContract('minnet', async () => ({ guard: createMemoryGatewayGuardStore(), clock: new TestClock() }));
guardContract('fakeGuard', async () => ({ guard: new MemoryGatewayGuardStore(), clock: new TestClock() }));

describe('API: sidindelning går via databasen', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  async function api() {
    const store = createMemoryStore();
    for (let i = 0; i < 7; i++) await store.proposals.upsert('T1', `P${i}`, result(i), new Date(now.getTime() + i));
    for (let i = 0; i < 4; i++) await store.guard.begin('T1', `k${i}`, new Date(now.getTime() + i));
    await store.proposals.upsert('T2', 'ANNAN', result(1), now);
    const server = buildServer({ ...store, authenticate: async (k) => ({ k1: 'T1', k2: 'T2' })[k] ?? null, clock: { now: () => now }, rateLimit: false });
    const get = async (url: string, key = 'k1') => (await server.inject({ method: 'GET', url, headers: { 'x-api-key': key } })).json();
    return { get, store };
  }

  it('förslag: limit, offset och hasMore', async () => {
    const { get } = await api();
    const first = await get('/v1/proposals?limit=3');
    expect(first.items.map((p: { payoutId: string }) => p.payoutId)).toEqual(['P0', 'P1', 'P2']);
    expect(first.hasMore).toBe(true);
    const last = await get('/v1/proposals?limit=3&offset=6');
    expect(last.items.map((p: { payoutId: string }) => p.payoutId)).toEqual(['P6']);
    expect(last.hasMore).toBe(false);
  });

  it('osäkra anrop: limit, offset och hasMore, bara den egna kundens', async () => {
    const { get } = await api();
    const page = await get('/v1/guard/in-doubt?limit=3');
    expect(page.items.map((g: { key: string }) => g.key)).toEqual(['k0', 'k1', 'k2']);
    expect(page.hasMore).toBe(true);
    expect((await get('/v1/guard/in-doubt?limit=3&offset=3')).hasMore).toBe(false);
    expect((await get('/v1/guard/in-doubt', 'k2')).items).toEqual([]);
  });

  it('sammanställningen är begränsad och säger det när den kapats', async () => {
    const { get, store } = await api();
    expect((await get('/v1/proposals/summary')).truncated).toBe(false);
    for (let i = 7; i < 5003; i++) await store.proposals.upsert('T1', `P${i}`, result(i), new Date(now.getTime() + i));
    const big = await get('/v1/proposals/summary');
    expect(big.truncated).toBe(true);
    expect(big.payouts.total).toBe(5000);
  });
});

describe('Fortnox hastighetsgräns', () => {
  it('ger aldrig fler än 25 anrop i något fönster på 5 sekunder, ens under full belastning', async () => {
    let t = 0;
    const limiter = createRateLimiter({ ...FORTNOX_RATE_LIMIT, clock: { now: () => new Date(t) }, sleep: async (ms) => void (t += ms) });
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      await limiter.acquire();
      times.push(t);
    }
    let worst = 0;
    for (const start of times) worst = Math.max(worst, times.filter((x) => x >= start && x < start + 5000).length);
    expect(worst).toBeLessThanOrEqual(25);
    expect(worst).toBeGreaterThanOrEqual(20); // och den är inte onödigt långsam
  });

  it('en högre takt (5 per sekund med skur 25) skulle bryta gränsen: därför är förinställningen lägre', async () => {
    let t = 0;
    const limiter = createRateLimiter({ perSecond: 5, burst: 25, clock: { now: () => new Date(t) }, sleep: async (ms) => void (t += ms) });
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      await limiter.acquire();
      times.push(t);
    }
    const worst = Math.max(...times.map((start) => times.filter((x) => x >= start && x < start + 5000).length));
    expect(worst).toBeGreaterThan(25);
  });
});
