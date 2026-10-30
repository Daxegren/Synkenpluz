import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import type { LedgerCommand } from '../../src/domain/types.js';
import { createMemoryStore } from '../../src/testing/memory.js';

const now = new Date('2026-10-28T12:00:00Z');
const KEYS: Record<string, string> = { 'key-a': 'A', 'key-b': 'B' };

let store: ReturnType<typeof createMemoryStore>;
let app: FastifyInstance;
let exA: string;
let exB: string;

const hA = { 'x-api-key': 'key-a' };
const hB = { 'x-api-key': 'key-b' };

function voucher(key: string): LedgerCommand {
  return { kind: 'post_voucher', key, date: '2026-10-28', description: 'HEMLIG-BESKRIVNING', lines: [{ account: 1930, debit: 100, credit: 0 }] };
}

beforeEach(async () => {
  store = createMemoryStore();
  app = buildServer({
    ...store,
    authenticate: async (k) => KEYS[k] ?? null,
    clock: { now: () => now },
  });
  await store.exceptions.add('A', 'P1', [{ code: 'NO_MATCH', lineId: 'l1', message: 'A-avvikelse' }, { code: 'AMOUNT_MISMATCH', lineId: 'l2', message: 'A2' }], now);
  await store.exceptions.add('B', 'P1', [{ code: 'NO_MATCH', lineId: 'l1', message: 'B-avvikelse' }], now);
  exA = (await store.exceptions.list('A', { payoutId: 'P1' }))[0]!.id;
  exB = (await store.exceptions.list('B'))[0]!.id;
  await store.payouts.record({ tenantId: 'A', payoutId: 'P1', status: 'partial', processedAt: now });
  await store.payouts.record({ tenantId: 'A', payoutId: 'P2', status: 'complete', processedAt: now });
  await store.payouts.record({ tenantId: 'B', payoutId: 'PB', status: 'rejected', processedAt: now });
  await store.commands.enqueue('A', 'P1', [voucher('secret-key-1')], now);
  const [c] = await store.commands.claimDue(now, 1);
  await store.commands.markFailed(c!.id, 'Fortnox token abc123 expired', null, now);
});

describe('auth', () => {
  it('/health är öppen', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  it.each([
    ['saknad nyckel', {}],
    ['ogiltig nyckel', { 'x-api-key': 'fel' }],
    ['tom nyckel', { 'x-api-key': '' }],
    ['för lång nyckel', { 'x-api-key': 'x'.repeat(1000) }],
  ])('401 för %s', async (_n, headers) => {
    for (const url of ['/v1/exceptions', '/v1/payouts', `/v1/exceptions/${exA}`, '/v1/payouts/P1']) {
      const r = await app.inject({ url, headers });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    }
    const post = await app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers, payload: { status: 'resolved', note: 'x' } });
    expect(post.statusCode).toBe(401);
  });

  it('nyckeln ekas aldrig i svaret', async () => {
    const r = await app.inject({ url: '/v1/exceptions', headers: { 'x-api-key': 'hemlig-nyckel-123' } });
    expect(r.body).not.toContain('hemlig-nyckel-123');
  });

  it('authenticate som kastar ger generiskt 500 utan läcka', async () => {
    const bad = buildServer({ ...store, authenticate: async () => { throw new Error('db password=hunter2'); }, clock: { now: () => now } });
    const r = await bad.inject({ url: '/v1/exceptions', headers: hA });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'internal_error', message: 'Internt fel' } });
    expect(r.body).not.toContain('hunter2');
  });
});

describe('tenant-isolering', () => {
  it('A ser bara sina avvikelser, B bara sina', async () => {
    const a = (await app.inject({ url: '/v1/exceptions', headers: hA })).json();
    const b = (await app.inject({ url: '/v1/exceptions', headers: hB })).json();
    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(1);
    expect(JSON.stringify(a)).not.toContain('B-avvikelse');
    expect(JSON.stringify(b)).not.toContain('A-avvikelse');
  });

  it('A kan inte läsa B:s avvikelse (404, inte 403)', async () => {
    const r = await app.inject({ url: `/v1/exceptions/${exB}`, headers: hA });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('B-avvikelse');
  });

  it('A kan inte lösa B:s avvikelse, och den förblir öppen', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/exceptions/${exB}/resolve`, headers: hA, payload: { status: 'resolved', note: 'försök' } });
    expect(r.statusCode).toBe(404);
    const still = await store.exceptions.get('B', exB);
    expect(still).toMatchObject({ status: 'open', resolutionNote: null, resolvedAt: null });
    const own = await app.inject({ url: `/v1/exceptions/${exB}`, headers: hB });
    expect(own.json().status).toBe('open');
  });

  it('payoutId-filter korsar inte tenants', async () => {
    const r = (await app.inject({ url: '/v1/exceptions?payoutId=P1', headers: hB })).json();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].message).toBe('B-avvikelse');
  });

  it('utbetalningar och kommandon är isolerade', async () => {
    expect((await app.inject({ url: '/v1/payouts/PB', headers: hA })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/payouts/P1', headers: hB })).statusCode).toBe(404);
    const listB = (await app.inject({ url: '/v1/payouts', headers: hB })).json();
    expect(listB.items.map((p: { payoutId: string }) => p.payoutId)).toEqual(['PB']);
    const a = (await app.inject({ url: '/v1/payouts/P1', headers: hA })).json();
    expect(a.commands).toHaveLength(1);
  });
});

describe('exceptions', () => {
  it('lista med filter', async () => {
    const all = (await app.inject({ url: '/v1/exceptions?status=open', headers: hA })).json();
    expect(all.items).toHaveLength(2);
    const none = (await app.inject({ url: '/v1/exceptions?status=resolved', headers: hA })).json();
    expect(none.items).toHaveLength(0);
    const byPayout = (await app.inject({ url: '/v1/exceptions?payoutId=nope', headers: hA })).json();
    expect(byPayout.items).toHaveLength(0);
  });

  it('get returnerar avvikelsen', async () => {
    const r = await app.inject({ url: `/v1/exceptions/${exA}`, headers: hA });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: exA, payoutId: 'P1', status: 'open', resolvedAt: null });
  });

  it('get okänt id ger 404 med enhetlig felform', async () => {
    const r = await app.inject({ url: '/v1/exceptions/finns-inte', headers: hA });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('resolve -> 200, sedan 409', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers: hA, payload: { status: 'resolved', note: 'Matchad manuellt' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: exA, status: 'resolved', resolutionNote: 'Matchad manuellt', resolvedAt: now.toISOString() });
    const again = await app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers: hA, payload: { status: 'dismissed', note: 'igen' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('conflict');
    expect((await store.exceptions.get('A', exA))!.status).toBe('resolved');
  });

  it('resolve okänd -> 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/exceptions/nope/resolve', headers: hA, payload: { status: 'dismissed', note: 'x' } });
    expect(r.statusCode).toBe(404);
  });
});

describe('validering', () => {
  const post = (payload: unknown, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers: hA, payload: payload as never, ...extra });

  it.each([
    ['saknad status', { note: 'x' }],
    ['ogiltig status', { status: 'open', note: 'x' }],
    ['saknad note', { status: 'resolved' }],
    ['tom note', { status: 'resolved', note: '' }],
    ['blank note', { status: 'resolved', note: '   ' }],
    ['för lång note', { status: 'resolved', note: 'x'.repeat(2001) }],
    ['note fel typ', { status: 'resolved', note: 5 }],
    ['okända fält', { status: 'resolved', note: 'x', tenantId: 'B' }],
  ])('400 för %s', async (_n, payload) => {
    const r = await post(payload);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
    expect(r.json().error.message).toMatch(/body/);
    expect((await store.exceptions.get('A', exA))!.status).toBe('open');
  });

  it('note på exakt 2000 tecken accepteras', async () => {
    expect((await post({ status: 'dismissed', note: 'x'.repeat(2000) })).statusCode).toBe(200);
  });

  it('400 för saknad body och trasig JSON', async () => {
    const none = await app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers: hA });
    expect(none.statusCode).toBe(400);
    const broken = await app.inject({ method: 'POST', url: `/v1/exceptions/${exA}/resolve`, headers: { ...hA, 'content-type': 'application/json' }, payload: '{trasig' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toEqual({ error: { code: 'bad_request', message: expect.any(String) } });
  });

  it('400 för ogiltiga query-parametrar', async () => {
    for (const url of ['/v1/exceptions?status=bogus', '/v1/exceptions?foo=1', '/v1/exceptions?payoutId=', '/v1/exceptions?status=open&status=resolved', '/v1/payouts?status=open', '/v1/payouts?x=1']) {
      const r = await app.inject({ url, headers: hA });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error.code).toBe('validation_error');
    }
  });

  it('400 för för långt id', async () => {
    const r = await app.inject({ url: `/v1/exceptions/${'x'.repeat(200)}`, headers: hA });
    expect(r.statusCode).toBe(400);
  });
});

describe('payouts', () => {
  it('lista och statusfilter', async () => {
    const all = (await app.inject({ url: '/v1/payouts', headers: hA })).json();
    expect(all.items).toHaveLength(2);
    const done = (await app.inject({ url: '/v1/payouts?status=complete', headers: hA })).json();
    expect(done.items).toEqual([{ payoutId: 'P2', status: 'complete', processedAt: now.toISOString() }]);
  });

  it('get inkluderar kommandon, tom lista om inga', async () => {
    const p1 = (await app.inject({ url: '/v1/payouts/P1', headers: hA })).json();
    expect(p1).toMatchObject({ payoutId: 'P1', status: 'partial' });
    expect(p1.commands).toEqual([{ id: expect.any(String), kind: 'post_voucher', status: 'dead', attempts: 1, nextAttemptAt: now.toISOString(), hasError: true }]);
    const p2 = (await app.inject({ url: '/v1/payouts/P2', headers: hA })).json();
    expect(p2.commands).toEqual([]);
  });

  it('okänd utbetalning -> 404', async () => {
    expect((await app.inject({ url: '/v1/payouts/nope', headers: hA })).statusCode).toBe(404);
  });
});

describe('inga känsliga fält läcker', () => {
  it('svar saknar tenantId, nycklar, kommandoinnehåll och felmeddelanden', async () => {
    const bodies = [
      (await app.inject({ url: '/v1/payouts/P1', headers: hA })).body,
      (await app.inject({ url: '/v1/payouts', headers: hA })).body,
      (await app.inject({ url: '/v1/exceptions', headers: hA })).body,
      (await app.inject({ url: `/v1/exceptions/${exA}`, headers: hA })).body,
    ].join('\n');
    for (const forbidden of ['tenantId', 'secret-key-1', 'idempotency', 'HEMLIG-BESKRIVNING', 'Fortnox token', 'abc123', 'lastError', 'externalId', 'lines', '"key"', '"command"']) {
      expect(bodies, forbidden).not.toContain(forbidden);
    }
  });

  it('500 från repo ger generiskt svar utan intern information', async () => {
    const bad = buildServer({
      ...store,
      exceptions: { ...store.exceptions, list: async () => { throw new Error('connection to 10.0.0.5 refused, password=hunter2'); } },
      authenticate: async (k) => KEYS[k] ?? null,
      clock: { now: () => now },
    });
    const r = await bad.inject({ url: '/v1/exceptions', headers: hA });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'internal_error', message: 'Internt fel' } });
    expect(r.body).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it('okänd route ger enhetligt 404', async () => {
    const r = await app.inject({ url: '/v1/nope', headers: hA });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });
});
