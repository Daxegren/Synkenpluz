import { describe, expect, it } from 'vitest';
import { LedgerError } from '../../src/ports/index.js';
import { createOAuth2TokenProvider } from '../../src/http/oauth.js';

const SECRET = 'KLIENT-HEMLIGHET-xyz';
const RT = 'REFRESH-HEMLIG-abc';

function setup(responder: (call: number, body: URLSearchParams, headers: Headers) => Response | Promise<Response>, extra: object = {}) {
  let now = Date.UTC(2026, 0, 1);
  const calls: Array<{ body: URLSearchParams; headers: Headers }> = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    const headers = new Headers(init.headers);
    calls.push({ body, headers });
    return responder(calls.length, body, headers);
  }) as typeof fetch;
  const rotated: string[] = [];
  const provider = createOAuth2TokenProvider({
    tokenUrl: 'https://auth.example.test/oauth/token?x=1',
    clientId: 'id',
    clientSecret: SECRET,
    refreshToken: RT,
    fetchImpl,
    clock: { now: () => new Date(now) },
    onRefreshTokenRotated: (t) => void rotated.push(t),
    ...extra,
  });
  return { provider, calls, rotated, advance: (ms: number) => void (now += ms) };
}

const tokenResponse = (n: number, extra: object = {}) =>
  new Response(JSON.stringify({ access_token: `at-${n}`, expires_in: 3600, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('createOAuth2TokenProvider', () => {
  it('cachar token och förnyar före utgång (60 s marginal)', async () => {
    const s = setup((n) => tokenResponse(n));
    expect(await s.provider.getAccessToken()).toBe('at-1');
    s.advance(3600_000 - 61_000);
    expect(await s.provider.getAccessToken()).toBe('at-1');
    expect(s.calls).toHaveLength(1);
    s.advance(2000); // nu inom marginalen
    expect(await s.provider.getAccessToken()).toBe('at-2');
    expect(s.calls).toHaveLength(2);
  });

  it('samtidiga anrop ger exakt ETT förnyelseanrop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async (n) => {
      await gate;
      return tokenResponse(n);
    });
    const all = Promise.all(Array.from({ length: 50 }, () => s.provider.getAccessToken()));
    await new Promise((r) => setImmediate(r));
    release();
    const tokens = await all;
    expect(new Set(tokens)).toEqual(new Set(['at-1']));
    expect(s.calls).toHaveLength(1);
  });

  it('skickar refresh_token-grant med Basic-auth, annars client_credentials', async () => {
    const s = setup((n) => tokenResponse(n));
    await s.provider.getAccessToken();
    expect(s.calls[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(s.calls[0]!.body.get('refresh_token')).toBe(RT);
    expect(s.calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from(`id:${SECRET}`).toString('base64')}`);
    const c = setup((n) => tokenResponse(n), { refreshToken: undefined });
    await c.provider.getAccessToken();
    expect(c.calls[0]!.body.get('grant_type')).toBe('client_credentials');
  });

  it('refresh-token-rotation anropar callbacken och använder nya tokenet nästa gång', async () => {
    const s = setup((n) => tokenResponse(n, { refresh_token: `rt-${n}` }));
    await s.provider.getAccessToken();
    expect(s.rotated).toEqual(['rt-1']);
    s.advance(3600_000);
    await s.provider.getAccessToken();
    expect(s.calls[1]!.body.get('refresh_token')).toBe('rt-1');
    expect(s.rotated).toEqual(['rt-1', 'rt-2']);
  });

  it('samma refresh-token i svaret räknas inte som rotation', async () => {
    const s = setup((n) => tokenResponse(n, { refresh_token: RT }));
    await s.provider.getAccessToken();
    expect(s.rotated).toEqual([]);
  });

  it('misslyckad sparning av roterat token försöks igen och förlorar det inte', async () => {
    let fail = true;
    const seen: string[] = [];
    const s = setup((n) => tokenResponse(n, { refresh_token: 'rt-new' }), {
      onRefreshTokenRotated: (t: string) => {
        seen.push(t);
        if (fail) throw new Error(`disk full ${RT}`);
      },
    });
    const err = await s.provider.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.message).not.toContain(RT);
    fail = false;
    expect(await s.provider.getAccessToken()).toBe('at-1');
    expect(seen).toEqual(['rt-new', 'rt-new']);
    expect(s.calls).toHaveLength(1);
  });

  it('invalidate med gammal header kastar inte ett redan förnyat token', async () => {
    const s = setup((n) => tokenResponse(n));
    const h = await s.provider.getAuthHeader();
    s.provider.invalidate(h);
    const h2 = await s.provider.getAuthHeader();
    expect(h2).toBe('Bearer at-2');
    s.provider.invalidate(h); // sen anropare med gammal header
    expect(await s.provider.getAuthHeader()).toBe('Bearer at-2');
    expect(s.calls).toHaveLength(2);
  });

  const failures: Array<[string, () => Response | Promise<Response>, boolean]> = [
    ['400 invalid_grant', () => new Response(`{"error":"invalid_grant","refresh_token":"${RT}"}`, { status: 400 }), false],
    ['401', () => new Response('nej', { status: 401 }), false],
    ['429', () => new Response('', { status: 429, headers: { 'retry-after': '9' } }), true],
    ['503', () => new Response(`${SECRET}`, { status: 503 }), true],
    ['ogiltig JSON', () => new Response('<html>', { status: 200 }), false],
    ['saknar access_token', () => new Response('{}', { status: 200 }), false],
  ];
  it.each(failures)('fel %s ger LedgerError utan hemligheter', async (_n, respond, retryable) => {
    const s = setup(() => respond());
    const err = await s.provider.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.retryable).toBe(retryable);
    expect(err.notApplied).toBe(true);
    const text = `${err.message}\n${err.stack}`;
    for (const secret of [SECRET, RT, Buffer.from(`id:${SECRET}`).toString('base64')]) expect(text).not.toContain(secret);
    expect(text).not.toContain('x=1');
    // misslyckande cachas inte: nästa anrop försöker igen
    await s.provider.getAccessToken().catch(() => undefined);
    expect(s.calls).toHaveLength(2);
  });

  it('429 för med sig retryAfterMs', async () => {
    const s = setup(() => new Response('', { status: 429, headers: { 'retry-after': '9' } }));
    const err = await s.provider.getAccessToken().catch((e) => e);
    expect(err.retryAfterMs).toBe(9000);
  });

  it('nätverksfel utan hemligheter i meddelandet', async () => {
    const s = setup(() => {
      throw Object.assign(new TypeError(`fetch failed ${SECRET}`), { cause: Object.assign(new Error(SECRET), { code: 'ECONNREFUSED' }) });
    });
    const err = await s.provider.getAccessToken().catch((e) => e);
    expect(err).toMatchObject({ retryable: true, notApplied: true });
    expect(`${err.message}${err.stack}`).not.toContain(SECRET);
  });
});
