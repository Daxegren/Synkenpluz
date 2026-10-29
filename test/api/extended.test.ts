import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { createGatewayGuardStore } from '../../src/db/gatewayGuard.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { GatewayGuardStore, Repositories, UnitOfWork } from '../../src/ports/index.js';
import { collectMetrics, renderPrometheus } from '../../src/db/metrics.js';
import type { ReconcileResult } from '../../src/domain/types.js';
import { createMemoryStore } from '../../src/testing/memory.js';
import { createTestStack } from '../helpers.js';

const now = new Date('2026-10-28T12:00:00Z');
const KEYS: Record<string, string> = { 'key-a': 'A', 'key-b': 'B' };
const hA = { 'x-api-key': 'key-a' };
const hB = { 'x-api-key': 'key-b' };
const base = {
  authenticate: async (k: string) => KEYS[k] ?? null,
  clock: { now: () => now },
  rateLimit: false as const,
};

describe('paginering', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let app: FastifyInstance;
  beforeEach(async () => {
    store = createMemoryStore();
    app = buildServer({ ...store, ...base });
    const exs = Array.from({ length: 7 }, (_, i) => ({ code: 'NO_MATCH' as const, lineId: `l${i}`, message: `m${i}` }));
    await store.exceptions.add('A', 'P1', exs, now);
    await store.exceptions.add('B', 'P1', exs.slice(0, 2), now);
    for (let i = 0; i < 5; i++) await store.payouts.record({ tenantId: 'A', payoutId: `P${i}`, status: 'complete', processedAt: new Date(now.getTime() + i) });
  });
  const list = async (url: string) => (await app.inject({ url, headers: hA })).json();

  it('standard är limit 100, offset 0, hasMore false', async () => {
    const r = await list('/v1/exceptions');
    expect(r).toMatchObject({ limit: 100, offset: 0, hasMore: false });
    expect(r.items).toHaveLength(7);
  });

  it('sidor, hasMore och offset bortom slutet', async () => {
    const p1 = await list('/v1/exceptions?limit=3');
    expect(p1).toMatchObject({ limit: 3, offset: 0, hasMore: true });
    expect(p1.items.map((i: { message: string }) => i.message)).toEqual(['m0', 'm1', 'm2']);
    const p2 = await list('/v1/exceptions?limit=3&offset=3');
    expect(p2.items.map((i: { message: string }) => i.message)).toEqual(['m3', 'm4', 'm5']);
    expect(p2.hasMore).toBe(true);
    const p3 = await list('/v1/exceptions?limit=3&offset=6');
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
    const exact = await list('/v1/exceptions?limit=7');
    expect(exact.hasMore).toBe(false);
    const beyond = await list('/v1/exceptions?offset=100');
    expect(beyond).toMatchObject({ items: [], hasMore: false, offset: 100 });
  });

  it('payouts paginerar och respekterar statusfilter', async () => {
    const p = await list('/v1/payouts?limit=2&offset=1&status=complete');
    expect(p.items.map((i: { payoutId: string }) => i.payoutId)).toEqual(['P1', 'P2']);
    expect(p.hasMore).toBe(true);
  });

  it('gränser: 500 ok, 501/0/negativt/decimal/text/dubletter ger 400', async () => {
    expect((await app.inject({ url: '/v1/exceptions?limit=500', headers: hA })).statusCode).toBe(200);
    for (const q of ['limit=501', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'offset=-1', 'offset=x', 'limit=1&limit=2', 'offset=1000001', 'limit=1e2']) {
      for (const path of ['/v1/exceptions', '/v1/payouts']) {
        const r = await app.inject({ url: `${path}?${q}`, headers: hA });
        expect(r.statusCode, `${path}?${q}`).toBe(400);
        expect(r.json().error.code).toBe('validation_error');
      }
    }
  });

  it('paginering korsar inte kunder', async () => {
    const b = (await app.inject({ url: '/v1/exceptions?limit=1', headers: hB })).json();
    expect(b.items).toHaveLength(1);
    expect(b.hasMore).toBe(true);
    expect(await app.inject({ url: '/v1/exceptions?limit=5&offset=2', headers: hB }).then((r) => r.json().items)).toEqual([]);
  });
});

describe('PGlite: paginering i SQL', () => {
  it('limit/offset tillämpas i databasen', async () => {
    const { repos } = await createTestStack();
    await repos.exceptions.add('A', 'P', Array.from({ length: 5 }, (_, i) => ({ code: 'NO_MATCH' as const, lineId: `l${i}`, message: 'm' })), now);
    for (let i = 0; i < 4; i++) await repos.payouts.record({ tenantId: 'A', payoutId: `P${i}`, status: 'partial', processedAt: new Date(now.getTime() + i) });
    expect(await repos.exceptions.list('A', { limit: 2, offset: 1 })).toHaveLength(2);
    expect(await repos.exceptions.list('A', { offset: 4 })).toHaveLength(1);
    expect((await repos.payouts.list('A', { limit: 2, offset: 1 })).map((p) => p.payoutId)).toEqual(['P1', 'P2']);
    expect((await repos.payouts.list('A', { status: 'partial', limit: 10 })).length).toBe(4);
    expect(await repos.payouts.list('A')).toHaveLength(4);
  });
});

describe('body- och fältgränser', () => {
  it('för stor body ger 413 med enhetligt felformat, och inga bieffekter', async () => {
    const store = createMemoryStore();
    const app = buildServer({ ...store, ...base, bodyLimit: 1024 });
    await store.exceptions.add('A', 'P', [{ code: 'NO_MATCH', lineId: 'l', message: 'm' }], now);
    const id = (await store.exceptions.list('A'))[0]!.id;
    const r = await app.inject({ method: 'POST', url: `/v1/exceptions/${id}/resolve`, headers: hA, payload: { status: 'resolved', note: 'x'.repeat(5000) } });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ error: { code: 'payload_too_large', message: expect.any(String) } });
    expect((await store.exceptions.get('A', id))!.status).toBe('open');
  });

  it('standardgränsen är 64 KB', async () => {
    const app = buildServer({ ...createMemoryStore(), ...base });
    const big = await app.inject({ method: 'POST', url: '/v1/exceptions/x/resolve', headers: hA, payload: { status: 'resolved', note: 'x'.repeat(70_000) } });
    expect(big.statusCode).toBe(413);
    const ok = await app.inject({ method: 'POST', url: '/v1/exceptions/x/resolve', headers: hA, payload: { status: 'resolved', note: 'x'.repeat(2000) } });
    expect(ok.statusCode).toBe(404);
  });

  it('fel content-type ger 415 med enhetligt felformat', async () => {
    const app = buildServer({ ...createMemoryStore(), ...base });
    const r = await app.inject({ method: 'POST', url: '/v1/exceptions/x/resolve', headers: { ...hA, 'content-type': 'application/xml' }, payload: '<a/>' });
    expect(r.statusCode).toBe(415);
    expect(r.json().error.code).toBe('unsupported_media_type');
  });

  it('guard/resolve validerar fältgränser', async () => {
    const app = buildServer({ ...createMemoryStore(), ...base });
    for (const payload of [
      { key: 'k'.repeat(257), applied: false },
      { key: '', applied: false },
      { key: 'k', applied: true },
      { key: 'k', applied: false, externalId: 'x' },
      { key: 'k', applied: true, externalId: 'e'.repeat(129) },
      { key: 'k', applied: 'ja' },
      { key: 'k', applied: false, extra: 1 },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/v1/guard/resolve', headers: hA, payload });
      expect(r.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(r.json().error.code).toBe('validation_error');
    }
  });
});

describe('actor med nyckel-id', () => {
  it('revisionsposten får api:<nyckel-id> med authenticateDetailed, annars api', async () => {
    const { repos, uow } = await createTestStack();
    await repos.exceptions.add('A', 'P', [{ code: 'NO_MATCH', lineId: 'l', message: 'm' }], now);
    const [ex] = await repos.exceptions.list('A');
    const app = buildServer({
      ...base,
      exceptions: repos.exceptions,
      payouts: repos.payouts,
      commands: repos.commands,
      audit: repos.audit,
      uow,
      authenticateDetailed: async (k) => (k === 'key-a' ? { tenantId: 'A', keyId: 'abc123def456' } : null),
      authenticate: async () => null,
    });
    const r = await app.inject({ method: 'POST', url: `/v1/exceptions/${ex!.id}/resolve`, headers: hA, payload: { status: 'resolved', note: 'FRITEXT-HEMLIG' } });
    expect(r.statusCode).toBe(200);
    const log = await repos.audit.list('A');
    expect(log[0]).toMatchObject({ actor: 'api:abc123def456', action: 'exception.resolved' });
    expect(JSON.stringify(log)).not.toContain('key-a');
    expect(JSON.stringify(log)).not.toContain('FRITEXT-HEMLIG');
  });

  it('faller tillbaka på api när bara authenticate finns', async () => {
    const { repos, uow } = await createTestStack();
    await repos.exceptions.add('A', 'P', [{ code: 'NO_MATCH', lineId: 'l', message: 'm' }], now);
    const [ex] = await repos.exceptions.list('A');
    const app = buildServer({ ...base, exceptions: repos.exceptions, payouts: repos.payouts, commands: repos.commands, audit: repos.audit, uow });
    await app.inject({ method: 'POST', url: `/v1/exceptions/${ex!.id}/resolve`, headers: hA, payload: { status: 'dismissed', note: 'x' } });
    expect((await repos.audit.list('A'))[0]!.actor).toBe('api');
  });
});

const result = (status: ReconcileResult['status'], n = 1): ReconcileResult => ({
  status,
  commands: Array.from({ length: n }, (_, i) => ({ kind: 'post_voucher' as const, key: `SECRET-KEY-${i}`, date: '2026-10-28', description: 'Utbetalning', lines: [{ account: 1930, debit: 100, credit: 0 }] })),
  exceptions: status === 'complete' ? [] : [{ code: 'NO_MATCH', lineId: 'l1', message: 'ingen match' }],
});

describe('förslagsrutter', () => {
  let store: ReturnType<typeof createMemoryStore>;
  let app: FastifyInstance;
  beforeEach(async () => {
    store = createMemoryStore();
    app = buildServer({ ...store, ...base });
    await store.proposals.upsert('A', 'P1', result('partial', 2), now);
    await store.proposals.upsert('A', 'P2', result('complete'), new Date(now.getTime() + 1));
    await store.proposals.upsert('B', 'PB', result('rejected'), now);
  });

  it('lista, statusfilter och paginering', async () => {
    const all = (await app.inject({ url: '/v1/proposals', headers: hA })).json();
    expect(all).toMatchObject({ limit: 100, offset: 0, hasMore: false });
    expect(all.items).toEqual([
      { payoutId: 'P1', status: 'partial', commandCount: 2, exceptionCount: 1, updatedAt: now.toISOString() },
      { payoutId: 'P2', status: 'complete', commandCount: 1, exceptionCount: 0, updatedAt: new Date(now.getTime() + 1).toISOString() },
    ]);
    const f = (await app.inject({ url: '/v1/proposals?status=complete', headers: hA })).json();
    expect(f.items.map((i: { payoutId: string }) => i.payoutId)).toEqual(['P2']);
    const pg = (await app.inject({ url: '/v1/proposals?limit=1', headers: hA })).json();
    expect(pg.hasMore).toBe(true);
    expect(pg.items).toHaveLength(1);
    expect((await app.inject({ url: '/v1/proposals?status=bogus', headers: hA })).statusCode).toBe(400);
    expect((await app.inject({ url: '/v1/proposals?limit=0', headers: hA })).statusCode).toBe(400);
  });

  it('detalj visar kommandon och avvikelser men inte idempotensnycklar eller tenantId', async () => {
    const r = await app.inject({ url: '/v1/proposals/P1', headers: hA });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.commands).toHaveLength(2);
    expect(body.exceptions).toEqual([{ code: 'NO_MATCH', lineId: 'l1', message: 'ingen match' }]);
    expect(r.body).not.toContain('SECRET-KEY');
    expect(r.body).not.toContain('tenantId');
  });

  it('tenant-isolering: A ser aldrig B:s förslag', async () => {
    expect((await app.inject({ url: '/v1/proposals/PB', headers: hA })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/proposals/PB', headers: hB })).statusCode).toBe(200);
    expect(JSON.stringify((await app.inject({ url: '/v1/proposals', headers: hA })).json())).not.toContain('PB');
    expect((await app.inject({ url: '/v1/proposals', headers: hB })).json().items).toHaveLength(1);
  });

  it('kräver nyckel, okänt id ger 404, och saknad dep ger 404 för rutten', async () => {
    expect((await app.inject({ url: '/v1/proposals' })).statusCode).toBe(401);
    const r = await app.inject({ url: '/v1/proposals/nope', headers: hA });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
    const { proposals: _p, ...without } = store;
    const bare = buildServer({ ...without, ...base });
    expect((await bare.inject({ url: '/v1/proposals', headers: hA })).statusCode).toBe(404);
    expect((await bare.inject({ url: '/v1/proposals/P1', headers: hA })).statusCode).toBe(404);
  });
});

describe('guard-rutter (PGlite, atomiskt med revision)', () => {
  async function setup(opts: { atomicGuard: boolean } = { atomicGuard: true }) {
    const stack = await createTestStack();
    const guard = createGatewayGuardStore(stack.db);
    // En arbetsenhet som även ger en transaktionsbunden guard-journal till guardForUow.
    const txGuards = new WeakMap<object, GatewayGuardStore>();
    const uow: UnitOfWork = {
      run: (fn) =>
        stack.db.transaction((tx) => {
          const repos = createRepositories(tx);
          txGuards.set(repos, createGatewayGuardStore(tx));
          return fn(repos);
        }),
    };
    await guard.begin('A', 'cmd-a', now);
    await guard.begin('A', 'cmd-a2', new Date(now.getTime() + 1));
    await guard.begin('B', 'cmd-b', now);
    const app = buildServer({
      ...base,
      exceptions: stack.repos.exceptions,
      payouts: stack.repos.payouts,
      commands: stack.repos.commands,
      audit: stack.repos.audit,
      uow,
      guard,
      authenticateDetailed: async (k) => (KEYS[k] ? { tenantId: KEYS[k]!, keyId: k === 'key-a' ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb' } : null),
      ...(opts.atomicGuard ? { guardForUow: (r: Repositories) => txGuards.get(r)! } : {}),
    });
    return { ...stack, guard, app };
  }
  const resolve = (app: FastifyInstance, h: Record<string, string>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/guard/resolve', headers: h, payload: payload as never });

  it('listar bara den egna kundens osäkra anrop, paginerat', async () => {
    const { app } = await setup();
    const a = (await app.inject({ url: '/v1/guard/in-doubt', headers: hA })).json();
    expect(a.items).toEqual([
      { key: 'cmd-a', startedAt: now.toISOString() },
      { key: 'cmd-a2', startedAt: new Date(now.getTime() + 1).toISOString() },
    ]);
    expect(JSON.stringify(a)).not.toContain('cmd-b');
    const b = (await app.inject({ url: '/v1/guard/in-doubt', headers: hB })).json();
    expect(b.items.map((i: { key: string }) => i.key)).toEqual(['cmd-b']);
    const pg = (await app.inject({ url: '/v1/guard/in-doubt?limit=1&offset=1', headers: hA })).json();
    expect(pg).toMatchObject({ limit: 1, offset: 1, hasMore: false });
    expect(pg.items[0].key).toBe('cmd-a2');
    expect((await app.inject({ url: '/v1/guard/in-doubt?limit=9999', headers: hA })).statusCode).toBe(400);
  });

  it.each([[true], [false]])('applied=true/false avgör posten och skriver revision med nyckel-id (atomicGuard=%s)', async (atomicGuard) => {
    const { app, guard, repos } = await setup({ atomicGuard });
    const ok = await resolve(app, hA, { key: 'cmd-a', applied: true, externalId: 'EXT-9' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ key: 'cmd-a', applied: true, resolved: true });
    expect((await guard.begin('A', 'cmd-a', now))).toEqual({ outcome: 'done', externalId: 'EXT-9' });
    const no = await resolve(app, hA, { key: 'cmd-a2', applied: false });
    expect(no.statusCode).toBe(200);
    expect((await guard.begin('A', 'cmd-a2', now)).outcome).toBe('acquired'); // släppt för nytt försök
    const log = await repos.audit.list('A');
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.action === 'guard.resolved' && l.actor === 'api:aaaaaaaaaaaa')).toBe(true);
    const dump = JSON.stringify(log);
    expect(dump).not.toContain('EXT-9');
    expect(dump).not.toContain('cmd-a');
    expect(log.map((l) => l.details.applied).sort()).toEqual([false, true]);
  });

  it('409 när ingen osäker post finns, och ingen revisionspost skrivs', async () => {
    for (const atomicGuard of [true, false]) {
      const { app, repos } = await setup({ atomicGuard });
      const r = await resolve(app, hA, { key: 'finns-inte', applied: false });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('conflict');
      await resolve(app, hA, { key: 'cmd-a', applied: false });
      expect((await resolve(app, hA, { key: 'cmd-a', applied: false })).statusCode).toBe(409); // redan avgjord
      expect(await repos.audit.list('A')).toHaveLength(1);
    }
  });

  it('kund A kan aldrig lösa kund B:s post', async () => {
    const { app, guard, repos } = await setup();
    const r = await resolve(app, hA, { key: 'cmd-b', applied: true, externalId: 'X' });
    expect(r.statusCode).toBe(409);
    expect((await guard.listInDoubt('B')).map((g) => g.key)).toEqual(['cmd-b']);
    expect(await repos.audit.list('B')).toHaveLength(0);
    expect((await resolve(app, hB, { key: 'cmd-b', applied: false })).statusCode).toBe(200);
  });

  it('revisionsfel rullar tillbaka avgörandet (atomiskt)', async () => {
    const { app, guard, db } = await setup();
    await db.exec(`create or replace function audit_log_immutable() returns trigger language plpgsql as $$ begin raise exception 'blockerad'; end $$;`);
    await db.exec(`create trigger audit_block before insert on audit_log for each row execute function audit_log_immutable();`);
    const r = await resolve(app, hA, { key: 'cmd-a', applied: false });
    expect(r.statusCode).toBe(500);
    expect((await guard.listInDoubt('A')).map((g) => g.key)).toContain('cmd-a');
  });

  it('kräver nyckel, och saknad dep ger 404 för rutterna', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/v1/guard/in-doubt' })).statusCode).toBe(401);
    expect((await resolve(app, {}, { key: 'k', applied: false })).statusCode).toBe(401);
    const bare = buildServer({ ...createMemoryStore(), ...base, guard: undefined as never });
    const bare2 = buildServer({ exceptions: createMemoryStore().exceptions, payouts: createMemoryStore().payouts, commands: createMemoryStore().commands, ...base });
    expect((await bare2.inject({ url: '/v1/guard/in-doubt', headers: hA })).statusCode).toBe(404);
    expect((await resolve(bare2, hA, { key: 'k', applied: false })).statusCode).toBe(404);
    void bare;
  });

  it('fungerar även utan uow (memory-store)', async () => {
    const store = createMemoryStore();
    const audit: Array<{ actor: string; action: string }> = [];
    const app = buildServer({ ...store, ...base, audit: { append: async (e) => void audit.push(e), list: async () => [] } });
    await store.guard.begin('A', 'k1', now);
    expect((await resolve(app, hA, { key: 'k1', applied: false })).statusCode).toBe(200);
    expect(audit).toEqual([{ tenantId: 'A', actor: 'api', action: 'guard.resolved', details: expect.any(Object) }]);
  });
});

describe('/ready', () => {
  it('200 när ping lyckas eller saknas, 503 utan detaljer när den misslyckas eller hänger', async () => {
    const store = createMemoryStore();
    expect((await buildServer({ ...store, ...base }).inject({ url: '/ready' })).statusCode).toBe(200);
    expect((await buildServer({ ...store, ...base, ping: async () => {} }).inject({ url: '/ready' })).json()).toEqual({ status: 'ready' });
    const bad = await buildServer({ ...store, ...base, ping: async () => { throw new Error('password=hunter2 host=10.0.0.5'); } }).inject({ url: '/ready' });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toEqual({ status: 'unavailable' });
    expect(bad.body).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it('kräver ingen API-nyckel och fungerar mot PGlite', async () => {
    const { db } = await createTestStack();
    const store = createMemoryStore();
    const app = buildServer({ ...store, ...base, ping: async () => void (await db.query('select 1')) });
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
  });
});

describe('/metrics', () => {
  const store = createMemoryStore();
  const metrics = async () => 'synk_test 1\n';

  it('rutten finns inte utan token eller utan metrics', async () => {
    expect((await buildServer({ ...store, ...base, metrics }).inject({ url: '/metrics' })).statusCode).toBe(404);
    expect((await buildServer({ ...store, ...base, metricsToken: 'tok' }).inject({ url: '/metrics' })).statusCode).toBe(404);
  });

  it('401 vid saknad eller fel token, 200 med rätt, utan API-nyckel', async () => {
    const app = buildServer({ ...store, ...base, metrics, metricsToken: 'hemlig-token-123' });
    for (const headers of [{}, { authorization: 'Bearer fel' }, { authorization: 'hemlig-token-123' }, { authorization: 'Bearer hemlig-token-1234' }, { authorization: 'Basic hemlig-token-123' }, hA]) {
      const r = await app.inject({ url: '/metrics', headers });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('unauthorized');
      expect(r.body).not.toContain('hemlig-token-123');
    }
    const ok = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer hemlig-token-123' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(ok.body).toBe('synk_test 1\n');
  });

  it('fel i metrics ger generiskt 500', async () => {
    const app = buildServer({ ...store, ...base, metricsToken: 't', metrics: async () => { throw new Error('secret=1'); } });
    const r = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer t' } });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('secret');
  });

  it('collectMetrics + renderPrometheus: rätt värden, korrekt format, inga kund-id', async () => {
    const { db, repos, pg } = await createTestStack();
    void (pg as PGlite);
    await db.query(`insert into tenant (id, name, status, mode, created_at) values ('kund-hemlig-1','Hemligt AB','active','live',$1), ('kund-hemlig-2','Annat AB','active','dry_run',$1), ('kund-hemlig-3','Tredje','suspended','dry_run',$1)`, [now]);
    const cmd = (key: string) => ({ kind: 'post_voucher' as const, key, date: '2026-10-28', description: 'd', lines: [{ account: 1930, debit: 1, credit: 0 }] });
    await repos.commands.enqueue('kund-hemlig-1', 'PAY-HEMLIG', [cmd('a'), cmd('b')], new Date(now.getTime() - 90_000));
    await repos.commands.enqueue('kund-hemlig-2', 'PAY-2', [cmd('c')], new Date(now.getTime() - 10_000));
    const [first] = await repos.commands.claimDue(new Date(now.getTime() - 5000), 1);
    await repos.commands.markFailed(first!.id, 'fel', null, now);
    await repos.exceptions.add('kund-hemlig-1', 'PAY-HEMLIG', [{ code: 'NO_MATCH', lineId: 'l', message: 'm' }, { code: 'AMOUNT_MISMATCH', lineId: 'l2', message: 'm' }], now);
    await createGatewayGuardStore(db).begin('kund-hemlig-1', 'nyckel-hemlig', now);

    const m = await collectMetrics(db, now);
    expect(m.deadCommands).toBe(1);
    expect(m.queueDepth).toEqual({ pending: 2, in_progress: 0, succeeded: 0, failed: 0, dead: 1 });
    expect(m.oldestPendingAgeSeconds).toBe(90);
    expect(m.openExceptions).toBe(2);
    expect(m.guardInDoubt).toBe(1);
    expect(m.tenantsByMode).toEqual({ dry_run: 2, live: 1 });

    const text = renderPrometheus(m);
    expect(text).toContain('# TYPE synk_queue_depth gauge');
    expect(text).toContain('synk_queue_depth{status="pending"} 2');
    expect(text).toContain('synk_queue_depth{status="dead"} 1');
    expect(text).toContain('synk_dead_commands 1');
    expect(text).toContain('synk_oldest_pending_command_age_seconds 90');
    expect(text).toContain('synk_open_exceptions 2');
    expect(text).toContain('synk_guard_in_doubt 1');
    expect(text).toContain('synk_tenants{mode="live"} 1');
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.trim().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[a-z_]+"\})? -?\d+(\.\d+)?)$/);
    }
    expect(text).not.toMatch(/kund-hemlig|Hemligt|Annat AB|PAY-|nyckel-hemlig/i);
  });

  it('tom databas ger nollor', async () => {
    const { db } = await createTestStack();
    const m = await collectMetrics(db, now);
    expect(m).toEqual({ queueDepth: { pending: 0, in_progress: 0, succeeded: 0, failed: 0, dead: 0 }, deadCommands: 0, oldestPendingAgeSeconds: 0, openExceptions: 0, guardInDoubt: 0, tenantsByMode: { dry_run: 0, live: 0 } });
  });

  it('hela kedjan: /metrics levererar collectMetrics-utdata', async () => {
    const { db } = await createTestStack();
    const app = buildServer({ ...createMemoryStore(), ...base, metricsToken: 't', metrics: async () => renderPrometheus(await collectMetrics(db, now)) });
    const r = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer t' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('synk_dead_commands 0');
  });
});
