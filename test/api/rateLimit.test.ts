import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/api/rateLimit.js';
import { buildServer } from '../../src/api/server.js';
import { createMemoryStore } from '../../src/testing/memory.js';

class Clk {
  constructor(public t = Date.parse('2026-10-28T12:00:00Z')) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

describe('RateLimiter', () => {
  it('släpper igenom upp till capacity, nekar sedan med retryAfter och återhämtar sig', () => {
    const c = new Clk();
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: () => c.t });
    for (let i = 0; i < 3; i++) expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a')).toEqual({ allowed: false, retryAfterSec: 1 });
    c.advance(500);
    expect(rl.take('a')).toEqual({ allowed: false, retryAfterSec: 1 });
    c.advance(500);
    expect(rl.take('a').allowed).toBe(true);
    c.advance(10_000);
    for (let i = 0; i < 3; i++) expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(false); // aldrig mer än capacity
  });

  it('nycklar är isolerade och peek förbrukar ingenting', () => {
    const c = new Clk();
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.1, now: () => c.t });
    expect(rl.peek('a').allowed).toBe(true);
    expect(rl.size).toBe(0);
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.peek('a')).toEqual({ allowed: false, retryAfterSec: 10 });
    expect(rl.take('b').allowed).toBe(true);
  });

  it('fulla hinkar städas och antalet hinkar har tak', () => {
    const c = new Clk();
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => c.t, maxBuckets: 5, sweepIntervalMs: 1000 });
    for (let i = 0; i < 100; i++) rl.take(`ip-${i}`);
    expect(rl.size).toBe(5);
    c.advance(5000);
    rl.take('ny');
    expect(rl.size).toBe(1); // de gamla hade fyllts på helt och städades bort
  });

  it('ogiltig konfiguration kastar', () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSec: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, refillPerSec: 0 })).toThrow();
  });
});

describe('rate limiting i API:t', () => {
  const KEYS: Record<string, string> = { 'key-a': 'A', 'key-a2': 'A', 'key-b': 'B' };
  function make(clk: Clk, rateLimit = { perKey: { capacity: 3, refillPerSec: 1 }, perIpAuthFailure: { capacity: 2, refillPerSec: 0.5 }, perIpAnonymous: { capacity: 2, refillPerSec: 1 } }) {
    return buildServer({
      ...createMemoryStore(),
      authenticate: async (k) => KEYS[k] ?? null,
      authenticateDetailed: async (k) => (KEYS[k] ? { tenantId: KEYS[k]!, keyId: k.replace('key-', 'id') } : null),
      clock: clk,
      rateLimit,
    });
  }
  const get = (app: ReturnType<typeof make>, key: string) => app.inject({ url: '/v1/payouts', headers: { 'x-api-key': key } });

  it('429 med Retry-After och enhetligt felformat, sedan återhämtning', async () => {
    const clk = new Clk();
    const app = make(clk);
    for (let i = 0; i < 3; i++) expect((await get(app, 'key-a')).statusCode).toBe(200);
    const r = await get(app, 'key-a');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
    clk.advance(1000);
    expect((await get(app, 'key-a')).statusCode).toBe(200);
    expect((await get(app, 'key-a')).statusCode).toBe(429);
  });

  it('begränsningen gäller per nyckel, inte globalt eller per kund', async () => {
    const clk = new Clk();
    const app = make(clk);
    for (let i = 0; i < 3; i++) await get(app, 'key-a');
    expect((await get(app, 'key-a')).statusCode).toBe(429);
    expect((await get(app, 'key-b')).statusCode).toBe(200);
    expect((await get(app, 'key-a2')).statusCode).toBe(200); // annan nyckel, samma kund
  });

  it('misslyckade autentiseringar begränsas per IP och stoppar även nyckeluppslag', async () => {
    const clk = new Clk();
    const app = make(clk);
    expect((await get(app, 'fel1')).statusCode).toBe(401);
    expect((await get(app, 'fel2')).statusCode).toBe(401);
    const blocked = await get(app, 'fel3');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Saknad nyckel räknas också
    expect((await app.inject({ url: '/v1/payouts' })).statusCode).toBe(429);
    clk.advance(2000);
    expect((await get(app, 'fel4')).statusCode).toBe(401);
  });

  it('öppna rutter begränsas per IP, men /health inte', async () => {
    const clk = new Clk();
    const app = make(clk);
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    const r = await app.inject({ url: '/ready' });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    for (let i = 0; i < 10; i++) expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('rateLimit: false stänger av', async () => {
    const app = buildServer({ ...createMemoryStore(), authenticate: async () => 'A', clock: new Clk(), rateLimit: false });
    for (let i = 0; i < 300; i++) expect((await get(app as never, 'x')).statusCode).toBe(200);
  });

  it('standardvärden tillåter normal användning', async () => {
    const app = buildServer({ ...createMemoryStore(), authenticate: async () => 'A', clock: new Clk() });
    for (let i = 0; i < 30; i++) expect((await get(app as never, 'x')).statusCode).toBe(200);
  });
});
