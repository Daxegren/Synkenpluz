import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerError } from '../../src/ports/index.js';
import { createHttpClient } from '../../src/http/client.js';
import { createOAuth2TokenProvider } from '../../src/http/oauth.js';
import { createRateLimiter } from '../../src/http/rateLimiter.js';

const SECRET = 'SUPERHEMLIG-TOKEN-4711';

let server: Server;
let baseUrl: string;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];

const handlers: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      const path = new URL(req.url!, 'http://x').pathname;
      const h = handlers[path];
      if (!h) return void res.writeHead(404).end();
      h(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(body));

const client = (o: object = {}) =>
  createHttpClient({ baseUrl, getAuthHeader: async () => `Bearer ${SECRET}`, timeoutMs: 2000, ...o });

async function fail(p: Promise<unknown>): Promise<LedgerError> {
  const e = await p.then(
    () => undefined,
    (x) => x,
  );
  expect(e).toBeInstanceOf(LedgerError);
  return e as LedgerError;
}

function expectNoSecret(e: Error) {
  const text = `${e.message}\n${e.stack}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('token=');
}

describe('framgångsrika anrop', () => {
  it('skickar headers, query, JSON-body och idempotensnyckel; parsar JSON', async () => {
    handlers['/ok'] = (_req, res) => json(res, 201, { id: 7 });
    seen.length = 0;
    const res = await client({ defaultHeaders: { 'x-app': 'a' } }).request({
      method: 'POST',
      path: '/ok',
      query: { a: 1, b: undefined, c: 'x y' },
      body: { hello: 'världen' },
      headers: { 'x-extra': 'e' },
      idempotencyKey: 'key-1',
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: 7 });
    const s = seen[0]!;
    expect(s.url).toBe('/ok?a=1&c=x+y');
    expect(s.headers['idempotency-key']).toBe('key-1');
    expect(s.headers['x-app']).toBe('a');
    expect(s.headers['x-extra']).toBe('e');
    expect(s.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(s.headers['content-type']).toBe('application/json');
    expect(JSON.parse(s.body)).toEqual({ hello: 'världen' });
  });

  it('json är undefined för icke-JSON och tomma svar', async () => {
    handlers['/text'] = (_r, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('hej');
    handlers['/empty'] = (_r, res) => res.writeHead(204).end();
    expect((await client().request({ method: 'GET', path: '/text' })).json).toBeUndefined();
    expect((await client().request({ method: 'DELETE', path: '/empty' })).status).toBe(204);
  });

  it('acceptStatuses returnerar t.ex. 404 i stället för att kasta', async () => {
    const res = await client().request({ method: 'GET', path: '/finns-inte', acceptStatuses: [404] });
    expect(res.status).toBe(404);
  });

  it('avvisar path som pekar utanför baseUrl', async () => {
    await expect(client().request({ method: 'GET', path: '//evil.test/x' })).rejects.toThrow(TypeError);
    await expect(client().request({ method: 'GET', path: 'x' })).rejects.toThrow(TypeError);
  });
});

describe('statusklasser mot riktig server', () => {
  const cases: Array<[number, boolean, boolean]> = [
    [400, false, true],
    [401, false, true],
    [403, false, true],
    [404, false, true],
    [409, false, true],
    [422, false, true],
    [408, true, false],
    [425, true, false],
    [429, true, true],
    [500, true, false],
    [502, true, false],
    [503, true, false],
    [504, true, false],
  ];
  it.each(cases)('HTTP %i', async (status, retryable, notApplied) => {
    handlers['/s'] = (req, res) => {
      // Svarskroppen ekar hemligheten; den får aldrig hamna i felet.
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ echo: req.headers.authorization }));
    };
    const e = await fail(client().request({ method: 'POST', path: `/s?token=${SECRET}`, body: { a: 1 }, idempotencyKey: 'k' }));
    expect(e.retryable).toBe(retryable);
    expect(e.notApplied).toBe(notApplied);
    expect(e.message).toContain(`HTTP ${status}`);
    expect(e.message).toContain('POST /s');
    expectNoSecret(e);
  });

  it('3xx följs inte och är okänt utfall', async () => {
    handlers['/redir'] = (_r, res) => res.writeHead(302, { location: '/ok' }).end();
    const e = await fail(client().request({ method: 'POST', path: '/redir' }));
    expect(e).toMatchObject({ retryable: false, notApplied: false });
  });
});

describe('Retry-After', () => {
  const future = () => new Date(Date.now() + 30_000).toUTCString();
  const cases: Array<[string, () => string, (ms: number | undefined) => boolean]> = [
    ['sekunder', () => '12', (ms) => ms === 12_000],
    ['HTTP-datum', future, (ms) => ms !== undefined && ms > 25_000 && ms <= 30_000],
    ['skräp', () => 'asap', (ms) => ms === undefined],
    ['negativt', () => '-10', (ms) => ms === undefined],
    ['NaN', () => 'NaN', (ms) => ms === undefined],
    ['enormt', () => '9999999999999', (ms) => ms === 3_600_000],
    ['datum i det förflutna', () => new Date(Date.now() - 60_000).toUTCString(), (ms) => ms === undefined],
  ];
  it.each(cases)('429 med %s', async (_n, value, check) => {
    handlers['/ra'] = (_r, res) => res.writeHead(429, { 'retry-after': value() }).end();
    const e = await fail(client().request({ method: 'POST', path: '/ra' }));
    expect(check(e.retryAfterMs)).toBe(true);
    expect(e).toMatchObject({ retryable: true, notApplied: true });
  });

  it('429 utan header ger inget retryAfterMs', async () => {
    handlers['/ra'] = (_r, res) => res.writeHead(429).end();
    expect((await fail(client().request({ method: 'POST', path: '/ra' }))).retryAfterMs).toBeUndefined();
  });
});

describe('transportfel', () => {
  it('timeout när servern aldrig svarar: retryable, utfall okänt', async () => {
    handlers['/hang'] = () => undefined;
    const started = Date.now();
    const e = await fail(client({ timeoutMs: 100 }).request({ method: 'POST', path: `/hang?token=${SECRET}` }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(e).toMatchObject({ retryable: true, notApplied: false });
    expectNoSecret(e);
  });

  it('timeout under svarskroppen räknas som okänt utfall', async () => {
    handlers['/slowbody'] = (_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
    };
    const e = await fail(client({ timeoutMs: 150 }).request({ method: 'POST', path: '/slowbody' }));
    expect(e).toMatchObject({ retryable: true, notApplied: false });
  });

  it('ECONNREFUSED på stängd port: retryable och notApplied', async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const c = createHttpClient({ baseUrl: `http://127.0.0.1:${port}`, getAuthHeader: async () => `Bearer ${SECRET}`, timeoutMs: 2000 });
    const e = await fail(c.request({ method: 'POST', path: `/x?token=${SECRET}` }));
    expect(e).toMatchObject({ retryable: true, notApplied: true });
    expectNoSecret(e);
  });

  it('anslutning som bryts mitt i svaret: retryable, okänt', async () => {
    handlers['/reset'] = (req) => req.socket.destroy();
    const e = await fail(client().request({ method: 'POST', path: '/reset' }));
    expect(e).toMatchObject({ retryable: true, notApplied: false });
    expectNoSecret(e);
  });

  it('för stor respons (Content-Length) och för stor ström utan längd', async () => {
    handlers['/big'] = (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(2000));
    handlers['/bigstream'] = (_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 10; i++) res.write('y'.repeat(500));
      res.end();
    };
    for (const path of ['/big', '/bigstream']) {
      const e = await fail(client({ maxResponseBytes: 1000 }).request({ method: 'GET', path }));
      expect(e).toMatchObject({ retryable: false, notApplied: false });
    }
  });

  it('standardgränsen är 5 MB', async () => {
    handlers['/mb'] = (_r, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('z'.repeat(5 * 1024 * 1024 + 1));
    const e = await fail(client().request({ method: 'GET', path: '/mb' }));
    expect(e.message).toContain('för stort');
  });

  it('ogiltig JSON i 2xx-svar', async () => {
    handlers['/badjson'] = (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{inte json');
    const e = await fail(client().request({ method: 'POST', path: '/badjson' }));
    expect(e).toMatchObject({ retryable: false, notApplied: false });
  });
});

describe('injicerad fetch', () => {
  it('nätverksfel med hemlighet i orsaken läcker inte', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError(`fetch failed Bearer ${SECRET}`), {
        cause: Object.assign(new Error(`connect ECONNREFUSED ?token=${SECRET}`), { code: 'ECONNREFUSED' }),
      });
    }) as typeof fetch;
    const e = await fail(client({ fetchImpl }).request({ method: 'POST', path: `/a?token=${SECRET}` }));
    expect(e).toMatchObject({ retryable: true, notApplied: true });
    expectNoSecret(e);
    expect(e.cause).toBeUndefined();
  });

  it('kastande getAuthHeader läcker inte sitt meddelande men LedgerError passerar orört', async () => {
    const e1 = await fail(
      client({ getAuthHeader: async () => { throw new Error(`nyckel ${SECRET}`); } }).request({ method: 'GET', path: '/ok' }),
    );
    expectNoSecret(e1);
    const own = new LedgerError('förnyelse nere', true, undefined, true);
    const e2 = await fail(client({ getAuthHeader: async () => { throw own; } }).request({ method: 'GET', path: '/ok' }));
    expect(e2).toBe(own);
  });
});

describe('401 och tokenförnyelse', () => {
  it('401 -> förnya -> lyckas (en gång)', async () => {
    handlers['/needs-new'] = (req, res) =>
      req.headers.authorization === 'Bearer at-2' ? json(res, 200, { ok: true }) : json(res, 401, { error: 'expired' });
    let n = 0;
    const tokenFetch = (async () => {
      n++;
      return new Response(JSON.stringify({ access_token: `at-${n}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const provider = createOAuth2TokenProvider({
      tokenUrl: 'https://auth.test/token',
      clientId: 'i',
      clientSecret: 's',
      fetchImpl: tokenFetch,
      clock: { now: () => new Date() },
    });
    const c = client({ getAuthHeader: provider.asAuthHeaderSource() });
    const res = await c.request({ method: 'POST', path: '/needs-new', body: {} });
    expect(res.json).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('förnyar bara EN gång: fortsatt 401 kastas', async () => {
    handlers['/always401'] = (_r, res) => json(res, 401, {});
    let invalidations = 0;
    let calls = 0;
    const source = Object.assign(async () => `Bearer ${SECRET}-${++calls}`, { invalidate: () => void invalidations++ });
    seen.length = 0;
    const e = await fail(client({ getAuthHeader: source }).request({ method: 'POST', path: '/always401' }));
    expect(invalidations).toBe(1);
    expect(seen.filter((s) => s.url === '/always401')).toHaveLength(2);
    expect(e).toMatchObject({ retryable: false, notApplied: true });
    expect((e as { authExpired?: boolean }).authExpired).toBe(true);
    expectNoSecret(e);
  });

  it('utan invalidate görs inget nytt försök', async () => {
    handlers['/always401'] = (_r, res) => json(res, 401, {});
    seen.length = 0;
    await fail(client().request({ method: 'POST', path: '/always401' }));
    expect(seen.filter((s) => s.url === '/always401')).toHaveLength(1);
  });

  it('samtidiga 401 delar en förnyelse', async () => {
    handlers['/conc'] = (req, res) =>
      req.headers.authorization === 'Bearer at-2' ? json(res, 200, {}) : json(res, 401, {});
    let n = 0;
    const provider = createOAuth2TokenProvider({
      tokenUrl: 'https://auth.test/token',
      clientId: 'i',
      clientSecret: 's',
      fetchImpl: (async () => {
        n++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ access_token: `at-${n}`, expires_in: 3600 }));
      }) as typeof fetch,
      clock: { now: () => new Date() },
    });
    const c = client({ getAuthHeader: provider.asAuthHeaderSource() });
    const results = await Promise.all(Array.from({ length: 10 }, () => c.request({ method: 'POST', path: '/conc' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(n).toBe(2);
  });
});

describe('rate limiter i klienten', () => {
  it('anropar acquire före varje försök (även omförsök efter 401)', async () => {
    handlers['/rl'] = (_r, res) => json(res, 200, {});
    let acquired = 0;
    const c = client({ rateLimiter: { acquire: async () => void acquired++ } });
    await c.request({ method: 'GET', path: '/rl' });
    await c.request({ method: 'GET', path: '/rl' });
    expect(acquired).toBe(2);
    const rl = createRateLimiter({ perSecond: 1000 });
    await client({ rateLimiter: rl }).request({ method: 'GET', path: '/rl' });
  });
});
