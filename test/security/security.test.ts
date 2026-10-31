import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApiKeyRepository, createTenantRepository } from '../../src/db/tenants.js';
import { createConnectionRepository } from '../../src/db/connections.js';
import { createAuthenticator, generateApiKey, hashApiKey, parseApiKeyId, verifyApiKey } from '../../src/security/apiKeys.js';
import { CryptoError, StaticKeyProvider, decryptSecret, encryptSecret, type SecretContext } from '../../src/security/crypto.js';
import { createTestDb, TestClock } from '../helpers.js';

const ctx: SecretContext = { tenantId: 't1', connectionId: 'c1', field: 'credentials' };
const SECRET = 'SUPERHEMLIG-token-123';
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const provider1 = new StaticKeyProvider({ k1 }, 'k1');

describe('crypto', () => {
  it('rundtur, olika nonce per kryptering', async () => {
    const a = await encryptSecret(SECRET, provider1, ctx);
    const b = await encryptSecret(SECRET, provider1, ctx);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SECRET);
    expect(await decryptSecret(a, provider1, ctx)).toBe(SECRET);
    expect(await decryptSecret(b, provider1, ctx)).toBe(SECRET);
  });

  it('fel AAD (annan tenant, connection eller fält) misslyckas', async () => {
    const blob = await encryptSecret(SECRET, provider1, ctx);
    for (const bad of [{ ...ctx, tenantId: 't2' }, { ...ctx, connectionId: 'c2' }, { ...ctx, field: 'other' }]) {
      await expect(decryptSecret(blob, provider1, bad)).rejects.toMatchObject({ code: 'decryption_failed' });
    }
  });

  it('manipulerad blob misslyckas utan att läcka klartext', async () => {
    const blob = await encryptSecret(SECRET, provider1, ctx);
    const parts = blob.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString('base64url');
    const err = await decryptSecret(parts.join('.'), provider1, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CryptoError);
    expect((err as Error).message).not.toContain(SECRET);
    await expect(decryptSecret('skräp', provider1, ctx)).rejects.toMatchObject({ code: 'invalid_blob' });
    await expect(decryptSecret('v2.a.b.c.d', provider1, ctx)).rejects.toMatchObject({ code: 'invalid_blob' });
  });

  it('nyckelrotation: gammal blob läsbar, nya använder ny nyckel', async () => {
    const old = await encryptSecret(SECRET, provider1, ctx);
    const rotated = new StaticKeyProvider({ k1, k2 }, 'k2');
    expect(await decryptSecret(old, rotated, ctx)).toBe(SECRET);
    const fresh = await encryptSecret(SECRET, rotated, ctx);
    expect(Buffer.from(fresh.split('.')[1]!, 'base64url').toString()).toBe('k2');
    // k1 borttagen: gammal blob går inte längre att läsa
    const onlyK2 = new StaticKeyProvider({ k2 }, 'k2');
    await expect(decryptSecret(old, onlyK2, ctx)).rejects.toMatchObject({ code: 'unknown_key' });
  });

  it('fel nyckel (samma id, annat värde) misslyckas', async () => {
    const blob = await encryptSecret(SECRET, provider1, ctx);
    const wrong = new StaticKeyProvider({ k1: k2 }, 'k1');
    await expect(decryptSecret(blob, wrong, ctx)).rejects.toMatchObject({ code: 'decryption_failed' });
  });

  it('nyckellängd verifieras', async () => {
    expect(() => new StaticKeyProvider({ k: randomBytes(16) }, 'k')).toThrow(CryptoError);
    expect(() => new StaticKeyProvider({ k: randomBytes(33) }, 'k')).toThrow(/32 byte/);
    const bad = { currentKeyId: () => 'x', getKey: async () => randomBytes(16) };
    await expect(encryptSecret(SECRET, bad, ctx)).rejects.toMatchObject({ code: 'invalid_key' });
  });
});

describe('API-nycklar (ren logik)', () => {
  const pepper = randomBytes(32);
  it('format, hash och verifiering', () => {
    const k = generateApiKey(pepper);
    expect(k.rawKey).toMatch(/^synk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKeyId(k.rawKey)).toBe(k.id);
    expect(k.hash).not.toContain(k.rawKey.split('_').slice(2).join('_'));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKey(k.rawKey, k.hash, pepper)).toBe(true);
    expect(verifyApiKey(k.rawKey + 'x', k.hash, pepper)).toBe(false);
    expect(verifyApiKey(k.rawKey, k.hash, randomBytes(32))).toBe(false);
    expect(hashApiKey(k.rawKey, pepper)).toBe(k.hash);
    expect(() => generateApiKey(randomBytes(8))).toThrow();
  });
});

describe('databas: tenants, API-nycklar, connections', () => {
  const pepper = randomBytes(32);
  let env: Awaited<ReturnType<typeof createTestDb>>;
  let clock: TestClock;

  beforeEach(async () => {
    env = await createTestDb();
    clock = new TestClock();
  });

  async function setup() {
    const tenants = createTenantRepository(env.db);
    const keys = createApiKeyRepository(env.db);
    const authenticate = createAuthenticator({ store: keys, pepper, clock });
    await tenants.create({ id: 'a', name: 'A' }, clock.now());
    await tenants.create({ id: 'b', name: 'B' }, clock.now());
    return { tenants, keys, authenticate };
  }

  it('tenant startar i dry_run och active', async () => {
    const { tenants } = await setup();
    expect(await tenants.get('a')).toMatchObject({ status: 'active', mode: 'dry_run' });
    await tenants.setMode('a', 'live');
    expect((await tenants.get('a'))?.mode).toBe('live');
  });

  it('API-nyckel: rätt, fel, okänd, återkallad, utgången, suspenderad tenant', async () => {
    const { tenants, keys, authenticate } = await setup();
    const ok = await keys.issue('a', {}, clock.now(), pepper);
    expect(await authenticate(ok.rawKey)).toBe('a');
    expect((await keys.list('a'))[0]?.lastUsedAt).toEqual(clock.now());

    expect(await authenticate(ok.rawKey.slice(0, -1) + (ok.rawKey.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await authenticate('skräp')).toBeNull();
    expect(await authenticate(generateApiKey(pepper).rawKey)).toBeNull();

    // Annan tenant kan inte återkalla
    expect(await keys.revoke('b', ok.id, clock.now())).toBe(false);
    expect(await authenticate(ok.rawKey)).toBe('a');
    expect(await keys.revoke('a', ok.id, clock.now())).toBe(true);
    expect(await authenticate(ok.rawKey)).toBeNull();

    const exp = await keys.issue('a', { expiresAt: new Date(clock.now().getTime() + 1000) }, clock.now(), pepper);
    expect(await authenticate(exp.rawKey)).toBe('a');
    clock.advance(1000);
    expect(await authenticate(exp.rawKey)).toBeNull();

    const k3 = await keys.issue('b', {}, clock.now(), pepper);
    expect(await authenticate(k3.rawKey)).toBe('b');
    await tenants.setStatus('b', 'suspended');
    expect(await authenticate(k3.rawKey)).toBeNull();
  });

  it('hash i databasen innehåller inte nyckeln, list visar ingen hash', async () => {
    const { keys } = await setup();
    const k = await keys.issue('a', {}, clock.now(), pepper);
    const rows = await env.db.query<{ hash: string }>('select hash from api_key');
    // Hemligheten är base64url och kan själv innehålla '_': ta allt efter prefixet och id:t, inte efter sista understrecket.
    const secretPart = k.rawKey.split('_').slice(2).join('_');
    expect(secretPart).toHaveLength(43);
    expect(JSON.stringify(rows)).not.toContain(secretPart);
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = JSON.stringify(await keys.list('a'));
    expect(listed).not.toContain(secretPart);
    expect(listed).not.toContain(rows[0]!.hash);
  });

  it('connections: kryptering i databasen, list utan hemligheter, tenant-isolering', async () => {
    await setup();
    const repo = createConnectionRepository(env.db, provider1);
    const creds = { accessToken: SECRET, refreshToken: 'REFRESH-xyz' };
    const info = await repo.upsert('a', 'fortnox', creds, clock.now());
    expect(info).toMatchObject({ tenantId: 'a', provider: 'fortnox', keyId: 'k1', status: 'active' });

    const raw = JSON.stringify(await env.db.query('select * from connection'));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('REFRESH-xyz');

    const listed = JSON.stringify(await repo.list('a')) + JSON.stringify(await repo.getInfo('a', 'fortnox'));
    expect(listed).not.toContain(SECRET);
    expect(listed).not.toContain('encrypted');
    expect(listed).not.toContain('v1.');

    expect(await repo.getCredentialsForExecution('a', 'fortnox')).toEqual(creds);
    expect(await repo.getCredentialsForExecution('b', 'fortnox')).toBeNull();
    expect(await repo.list('b')).toEqual([]);
    expect(await repo.setStatus('b', 'fortnox', 'disabled', clock.now())).toBe(false);
    expect(await repo.delete('b', 'fortnox')).toBe(false);
    expect((await repo.getInfo('a', 'fortnox'))?.status).toBe('active');

    // upsert behåller id (AAD) och ersätter uppgifterna
    const again = await repo.upsert('a', 'fortnox', { accessToken: 'ny' }, clock.now());
    expect(again.id).toBe(info.id);
    expect(await repo.getCredentialsForExecution('a', 'fortnox')).toEqual({ accessToken: 'ny' });
    expect(await repo.list('a')).toHaveLength(1);
  });

  it('blob flyttad mellan tenants i databasen kan inte dekrypteras, och fel innehåller inga hemligheter', async () => {
    await setup();
    const repo = createConnectionRepository(env.db, provider1);
    await repo.upsert('a', 'fortnox', { accessToken: SECRET }, clock.now());
    await repo.upsert('b', 'fortnox', { accessToken: 'annat' }, clock.now());
    const [a] = await env.db.query<{ encrypted_credentials: string }>(
      `select encrypted_credentials from connection where tenant_id = 'a'`,
    );
    await env.db.query(`update connection set encrypted_credentials = $1 where tenant_id = 'b'`, [a!.encrypted_credentials]);
    const err = await repo.getCredentialsForExecution('b', 'fortnox').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CryptoError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(SECRET);
  });

  it('nyckelrotation i databasen: reencryptAll', async () => {
    await setup();
    const repo1 = createConnectionRepository(env.db, provider1);
    await repo1.upsert('a', 'fortnox', { accessToken: SECRET }, clock.now());
    const rotated = new StaticKeyProvider({ k1, k2 }, 'k2');
    const repo2 = createConnectionRepository(env.db, rotated);
    expect(await repo2.getCredentialsForExecution('a', 'fortnox')).toEqual({ accessToken: SECRET });
    expect((await repo2.getInfo('a', 'fortnox'))?.keyId).toBe('k1');
    expect(await repo2.reencryptAll(clock.now())).toBe(1);
    expect((await repo2.getInfo('a', 'fortnox'))?.keyId).toBe('k2');
    expect(await repo2.reencryptAll(clock.now())).toBe(0);
    const onlyK2 = createConnectionRepository(env.db, new StaticKeyProvider({ k2 }, 'k2'));
    expect(await onlyK2.getCredentialsForExecution('a', 'fortnox')).toEqual({ accessToken: SECRET });
  });

  it('främmande nyckel (tenant saknas) avvisas av databasen', async () => {
    await setup();
    const repo = createConnectionRepository(env.db, provider1);
    await expect(repo.upsert('finns-inte', 'fortnox', { a: 'b' }, clock.now())).rejects.toThrow();
  });
});

describe('createDetailedAuthenticator', () => {
  it('returnerar tenantId och offentligt nyckel-id, och samma avslag som createAuthenticator', async () => {
    const { createDetailedAuthenticator } = await import('../../src/security/apiKeys.js');
    const pepper = Buffer.alloc(32, 7);
    const gen = generateApiKey(pepper);
    const touched: string[] = [];
    const store = {
      findById: async (id: string) => (id === gen.id ? { id, tenantId: 'T1', hash: gen.hash, revokedAt: null, expiresAt: null, tenantStatus: 'active' as const } : null),
      touchLastUsed: async (id: string) => void touched.push(id),
    };
    const clock = { now: () => new Date('2026-10-28T12:00:00Z') };
    const auth = createDetailedAuthenticator({ store, pepper, clock });
    expect(await auth(gen.rawKey)).toEqual({ tenantId: 'T1', keyId: gen.id });
    expect(JSON.stringify(await auth(gen.rawKey))).not.toContain(gen.rawKey);
    expect(touched).toEqual([gen.id, gen.id]);
    expect(await auth('synk_000000000000_' + 'a'.repeat(43))).toBeNull();
    expect(await auth('skräp')).toBeNull();
    const revoked = createDetailedAuthenticator({ store: { ...store, findById: async (id) => ({ ...(await store.findById(id))!, revokedAt: new Date(0) }) }, pepper, clock });
    expect(await revoked(gen.rawKey)).toBeNull();
    // bakåtkompatibel variant ger fortfarande bara tenantId
    expect(await createAuthenticator({ store, pepper, clock })(gen.rawKey)).toBe('T1');
  });
});
