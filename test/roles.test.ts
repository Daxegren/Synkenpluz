import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createApiKeyRepository, createTenantRepository } from '../src/db/tenants.js';
import { API_KEY_ROLES, createDetailedAuthenticator, hasRole, isApiKeyRole, type ApiKeyRole } from '../src/security/apiKeys.js';
import { createMemoryStore } from '../src/testing/memory.js';
import { createOnboardingService } from '../src/db/onboarding.js';
import { createTestStack } from './helpers.js';

const pepper = Buffer.alloc(32, 5);

describe('roller: ordning och validering', () => {
  it('är ordnade viewer < operator < approver', () => {
    expect(API_KEY_ROLES).toEqual(['viewer', 'operator', 'approver']);
    expect(hasRole('approver', 'viewer') && hasRole('approver', 'operator') && hasRole('approver', 'approver')).toBe(true);
    expect(hasRole('operator', 'viewer') && hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('operator', 'approver')).toBe(false);
    expect(hasRole('viewer', 'operator')).toBe(false);
  });

  it('godtar bara kända roller', () => {
    for (const ok of API_KEY_ROLES) expect(isApiKeyRole(ok)).toBe(true);
    for (const bad of ['admin', 'APPROVER', '', null, undefined, 3]) expect(isApiKeyRole(bad)).toBe(false);
  });
});

describe('roller i databasen', () => {
  async function setup() {
    const stack = await createTestStack();
    const tenants = createTenantRepository(stack.db);
    await tenants.create({ id: 'T1', name: 'Kund' }, stack.clock.now());
    const keys = createApiKeyRepository(stack.db);
    const authenticate = createDetailedAuthenticator({ store: keys, pepper, clock: stack.clock });
    return { ...stack, keys, authenticate };
  }

  it('ger nya nycklar rollen operator om inget annat anges, och autentiseringen returnerar rollen', async () => {
    const { keys, authenticate, clock } = await setup();
    const plain = await keys.issue('T1', {}, clock.now(), pepper);
    const viewer = await keys.issue('T1', { role: 'viewer' }, clock.now(), pepper);
    const approver = await keys.issue('T1', { role: 'approver' }, clock.now(), pepper);
    expect((await authenticate(plain.rawKey))?.role).toBe('operator');
    expect((await authenticate(viewer.rawKey))?.role).toBe('viewer');
    expect((await authenticate(approver.rawKey))?.role).toBe('approver');
    // Samma tidsstämpel: ordningen i listan är då id:ts, så jämför per nyckel.
    const listed = Object.fromEntries((await keys.list('T1')).map((k) => [k.id, k.role]));
    expect(listed).toEqual({ [plain.id]: 'operator', [viewer.id]: 'viewer', [approver.id]: 'approver' });
  });

  it('vägrar att utfärda en nyckel med okänd roll', async () => {
    const { keys, clock } = await setup();
    await expect(keys.issue('T1', { role: 'admin' as ApiKeyRole }, clock.now(), pepper)).rejects.toThrow('Ogiltig roll');
    expect(await keys.list('T1')).toEqual([]);
  });

  it('databasen själv avvisar en okänd roll', async () => {
    const { db, clock } = await setup();
    await expect(
      db.query(`insert into api_key (id, tenant_id, hash, created_at, role) values ('x', 'T1', 'h', $1, 'root')`, [clock.now()]),
    ).rejects.toThrow();
  });

  it('en nyckel utan uttryckt roll (som före migrationen) blir operator, aldrig approver', async () => {
    const { db, clock, keys } = await setup();
    await db.query(`insert into api_key (id, tenant_id, hash, created_at) values ('abcdef012345', 'T1', $1, $2)`, ['0'.repeat(64), clock.now()]);
    expect((await keys.findById('abcdef012345'))?.role).toBe('operator');
  });
});

describe('roller i API:t', () => {
  const KEYS: Record<string, ApiKeyRole> = { viewer: 'viewer', operator: 'operator', approver: 'approver' };
  const as = (key: string) => ({ 'x-api-key': key });

  async function api() {
    const store = createMemoryStore();
    const stack = await createTestStack();
    await createTenantRepository(stack.db).create({ id: 'T1', name: 'Kund' }, stack.clock.now());
    const server = buildServer({
      ...store,
      onboarding: createOnboardingService(stack.db, stack.clock),
      authenticateDetailed: async (k) => (KEYS[k] ? { tenantId: 'T1', keyId: `id-${k}`, role: KEYS[k]! } : null),
      authenticate: async (k) => (KEYS[k] ? 'T1' : null),
      clock: stack.clock,
      rateLimit: false,
    });
    await store.exceptions.add('T1', 'P1', [{ code: 'NO_MATCH', lineId: 'l1', message: 'x' }], stack.clock.now());
    const [exception] = await store.exceptions.list('T1');
    return { server, exceptionId: exception!.id, store };
  }

  it('alla roller får läsa', async () => {
    const { server } = await api();
    for (const key of Object.keys(KEYS)) {
      for (const url of ['/v1/exceptions', '/v1/payouts', '/v1/onboarding']) {
        expect((await server.inject({ method: 'GET', url, headers: as(key) })).statusCode, `${key} ${url}`).toBe(200);
      }
    }
  });

  it('viewer får inte ändra något', async () => {
    const { server, exceptionId, store } = await api();
    const attempts = [
      { url: `/v1/exceptions/${exceptionId}/resolve`, payload: { status: 'resolved', note: 'ok' } },
      { url: '/v1/commands/abc/retry', payload: undefined },
      { url: '/v1/onboarding/go-live', payload: { approvedProposalCount: 0 } },
      { url: '/v1/onboarding/check-connection', payload: undefined },
    ];
    for (const a of attempts) {
      const r = await server.inject({ method: 'POST', url: a.url, headers: as('viewer'), ...(a.payload ? { payload: a.payload } : {}) });
      expect(r.statusCode, a.url).toBe(403);
      expect(r.json().error.code).toBe('forbidden');
    }
    // Och avvikelsen är orörd.
    expect((await store.exceptions.get('T1', exceptionId))?.status).toBe('open');
  });

  it('403 förklarar vilken roll som krävs utan att läcka något annat', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: as('operator'), payload: { approvedProposalCount: 0 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe('Åtgärden kräver rollen approver. Din nyckel har rollen operator');
  });

  it('operator får hantera avvikelser men inte godkänna go-live', async () => {
    const { server, exceptionId } = await api();
    const resolve = await server.inject({
      method: 'POST',
      url: `/v1/exceptions/${exceptionId}/resolve`,
      headers: as('operator'),
      payload: { status: 'resolved', note: 'Bokfört manuellt' },
    });
    expect(resolve.statusCode).toBe(200);
    const goLive = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: as('operator'), payload: { approvedProposalCount: 0 } });
    expect(goLive.statusCode).toBe(403);
  });

  it('approver når go-live (och får ett begripligt svar när kunden inte är redo)', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: as('approver'), payload: { approvedProposalCount: 0 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('not_ready');
  });

  it('rollen kontrolleras före validering av body, så en viewer lär sig inget om formatet', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: as('viewer'), payload: { fel: true } });
    expect(r.statusCode).toBe(403);
  });

  it('onboarding visar nyckelns egen roll så att gränssnittet kan förklara', async () => {
    const { server } = await api();
    for (const key of Object.keys(KEYS)) {
      const body = (await server.inject({ method: 'GET', url: '/v1/onboarding', headers: as(key) })).json();
      expect(body.you).toEqual({ role: key, canApprove: key === 'approver' });
    }
  });

  it('en tjänst som inte anger roller ger operator (aldrig mer)', async () => {
    const store = createMemoryStore();
    const stack = await createTestStack();
    const server = buildServer({
      ...store,
      onboarding: createOnboardingService(stack.db, stack.clock),
      authenticate: async () => 'T1',
      clock: stack.clock,
      rateLimit: false,
    });
    const r = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: as('x'), payload: { approvedProposalCount: 0 } });
    expect(r.statusCode).toBe(403);
  });
});
