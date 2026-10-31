import { describe, expect, it } from 'vitest';
import { createOnboardingService } from '../src/db/onboarding.js';
import { createConnectionRepository } from '../src/db/connections.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import { createApiKeyRepository, createTenantRepository } from '../src/db/tenants.js';
import { buildServer } from '../src/api/server.js';
import { FakeLedgerProvider, FULL_CAPABILITIES } from '../src/gateways/fakeProvider.js';
import { StaticKeyProvider } from '../src/security/crypto.js';
import { describeCapabilities, evaluateOnboarding, type OnboardingFacts } from '../src/service/onboarding.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  tenantStatus: 'active',
  mode: 'dry_run',
  accountsValid: true,
  activeKeys: 1,
  activeProviders: ['mondido', 'fortnox'],
  proposalCount: 2,
  proposalsWithExceptions: 1,
  payoutCount: 0,
  inDoubtCount: 0,
  ...over,
});

describe('evaluateOnboarding', () => {
  it('är i fasen review när allt är klart i dry_run', () => {
    const s = evaluateOnboarding(facts());
    expect(s.phase).toBe('review');
    expect(s.blockers).toEqual([]);
    expect(s.proposals).toEqual({ count: 2, withExceptions: 1 });
  });

  it('listar varje steg som saknas som hinder', () => {
    const s = evaluateOnboarding(
      facts({ accountsValid: false, activeKeys: 0, activeProviders: [], proposalCount: 0, payoutCount: 0, inDoubtCount: 1, tenantStatus: 'suspended' }),
    );
    expect(s.phase).toBe('setup');
    expect(s.blockers).toEqual(['tenant_active', 'accounts', 'api_key', 'payout_connection', 'ledger_connection', 'dry_run', 'in_doubt']);
    expect(s.steps.every((step) => step.hint.length > 0)).toBe(true);
  });

  it('kräver både betalleverantör och affärssystem, och godtar vilket affärssystem som helst', () => {
    expect(evaluateOnboarding(facts({ activeProviders: ['fortnox'] })).blockers).toEqual(['payout_connection']);
    expect(evaluateOnboarding(facts({ activeProviders: ['mondido'] })).blockers).toEqual(['ledger_connection']);
    for (const ledger of ['fortnox', 'spiris', 'briox']) {
      expect(evaluateOnboarding(facts({ activeProviders: ['mondido', ledger] })).blockers).toEqual([]);
    }
    expect(evaluateOnboarding(facts({ activeProviders: ['mondido', 'okand'] })).blockers).toEqual(['ledger_connection']);
  });

  it('räknar bokförda utbetalningar som testkörning även när inga förslag finns kvar', () => {
    expect(evaluateOnboarding(facts({ proposalCount: 0, payoutCount: 3 })).blockers).toEqual([]);
  });

  it('visar inga hinder när kunden redan är live', () => {
    const s = evaluateOnboarding(facts({ mode: 'live', inDoubtCount: 2 }));
    expect(s.phase).toBe('live');
    expect(s.blockers).toEqual([]);
  });
});

describe('describeCapabilities', () => {
  it('ger inga anmärkningar för ett affärssystem som kan allt', () => {
    expect(describeCapabilities(FULL_CAPABILITIES)).toEqual([]);
  });

  it('säger ärligt vad som saknas', () => {
    const notes = describeCapabilities({ searchByReference: false, idempotentWrites: false, verifyByReference: false, creditInvoice: false, postVoucher: false });
    expect(notes).toHaveLength(4);
    expect(notes.join(' ')).toContain('människa');
  });

  it('skiljer på saknad idempotens med och utan sökning på referens', () => {
    const withVerify = describeCapabilities({ ...FULL_CAPABILITIES, idempotentWrites: false });
    expect(withVerify).toHaveLength(1);
    expect(withVerify[0]).toContain('skyddsgatewayen');
  });
});

async function setup(provider?: FakeLedgerProvider) {
  const stack = await createTestStack();
  const tenants = createTenantRepository(stack.db);
  const apiKeys = createApiKeyRepository(stack.db);
  const connections = createConnectionRepository(stack.db, new StaticKeyProvider({ k1: Buffer.alloc(32, 7) }, 'k1'));
  const service = createOnboardingService(stack.db, stack.clock, provider);
  const pepper = Buffer.alloc(32, 9);

  await tenants.create({ id: 'T1', name: 'Kund 1' }, stack.clock.now());
  await tenants.create({ id: 'T2', name: 'Kund 2' }, stack.clock.now());

  const prepare = async (tenantId = 'T1') => {
    await setTenantAccounts(stack.db, tenantId, accounts);
    await apiKeys.issue(tenantId, {}, stack.clock.now(), pepper);
    await connections.upsert(tenantId, 'mondido', { token: 'x' }, stack.clock.now());
    await connections.upsert(tenantId, 'fortnox', { token: 'y' }, stack.clock.now());
  };
  const propose = (payoutId: string, tenantId = 'T1') =>
    processPayout(
      { uow: stack.uow, clock: stack.clock },
      { tenantId, payout: makePayout(payoutId, [payment('L1', 'REF-A', 12500)]), invoices: [makeInvoice('A')], accounts },
      { mode: 'dry_run' },
    );
  return { ...stack, tenants, apiKeys, connections, service, prepare, propose, pepper };
}

describe('onboarding mot databasen', () => {
  it('ger null för okänd kund', async () => {
    const { service } = await setup();
    expect(await service.status('FINNS-INTE')).toBeNull();
  });

  it('följer en kund från tom till redo för granskning', async () => {
    const { service, prepare, propose } = await setup();
    expect((await service.status('T1'))?.blockers).toEqual(['accounts', 'api_key', 'payout_connection', 'ledger_connection', 'dry_run']);

    await prepare();
    expect((await service.status('T1'))?.blockers).toEqual(['dry_run']);

    await propose('P1');
    const ready = await service.status('T1');
    expect(ready).toMatchObject({ phase: 'review', blockers: [], proposals: { count: 1, withExceptions: 0 } });
  });

  it('räknar bara aktiva nycklar och aktiva kopplingar', async () => {
    const { service, prepare, propose, apiKeys, connections, db, clock } = await setup();
    await prepare();
    await propose('P1');

    await connections.setStatus('T1', 'fortnox', 'needs_reauth', clock.now());
    expect((await service.status('T1'))?.blockers).toEqual(['ledger_connection']);
    await connections.setStatus('T1', 'fortnox', 'active', clock.now());

    const [key] = await apiKeys.list('T1');
    await apiKeys.revoke('T1', key!.id, clock.now());
    expect((await service.status('T1'))?.blockers).toEqual(['api_key']);

    await apiKeys.issue('T1', { expiresAt: new Date(clock.now().getTime() - 1000) }, clock.now(), Buffer.alloc(32, 9));
    expect((await service.status('T1'))?.blockers).toEqual(['api_key']);
    await db.query('select 1');
  });

  it('räknar osäkra anrop som hinder', async () => {
    const { service, prepare, propose, db, clock } = await setup();
    await prepare();
    await propose('P1');
    await db.query(`insert into gateway_guard (tenant_id, key, state, started_at) values ('T1', 'k', 'started', $1)`, [clock.now()]);
    expect((await service.status('T1'))?.blockers).toEqual(['in_doubt']);
    // En annan kunds osäkra anrop räknas inte.
    await db.query(`insert into gateway_guard (tenant_id, key, state, started_at) values ('T2', 'k', 'started', $1)`, [clock.now()]);
    expect((await service.status('T2'))?.steps.find((s) => s.id === 'in_doubt')?.done).toBe(false);
    expect((await service.status('T1'))?.blockers).toEqual(['in_doubt']);
  });

  describe('go-live', () => {
    it('godkänner, byter läge och loggar atomiskt', async () => {
      const { service, prepare, propose, tenants, repos } = await setup();
      await prepare();
      await propose('P1');
      await propose('P2');

      expect(await service.goLive('T1', { approvedProposalCount: 2 }, 'api:k1')).toEqual({ result: 'ok' });
      expect((await tenants.get('T1'))?.mode).toBe('live');
      expect((await service.status('T1'))?.phase).toBe('live');

      const [entry] = await repos.audit.list('T1');
      expect(entry).toMatchObject({ actor: 'api:k1', action: 'tenant.go_live', details: { approvedProposalCount: 2, proposalsWithExceptions: 0 } });
      expect(await service.goLive('T1', { approvedProposalCount: 2 }, 'api:k1')).toEqual({ result: 'already_live' });
      expect(await repos.audit.list('T1')).toHaveLength(1);
    });

    it('vägrar när onboardingen inte är klar och ändrar ingenting', async () => {
      const { service, tenants, repos } = await setup();
      expect(await service.goLive('T1', { approvedProposalCount: 0 }, 'api')).toMatchObject({ result: 'not_ready' });
      expect((await tenants.get('T1'))?.mode).toBe('dry_run');
      expect(await repos.audit.list('T1')).toEqual([]);
    });

    it('vägrar när antalet förslag ändrats sedan granskningen', async () => {
      const { service, prepare, propose, tenants } = await setup();
      await prepare();
      await propose('P1');
      expect(await service.goLive('T1', { approvedProposalCount: 0 }, 'api')).toEqual({ result: 'stale_review', proposalCount: 1 });
      await propose('P2');
      expect(await service.goLive('T1', { approvedProposalCount: 1 }, 'api')).toEqual({ result: 'stale_review', proposalCount: 2 });
      expect((await tenants.get('T1'))?.mode).toBe('dry_run');
    });

    it('ger not_found för okänd kund och rör inte andra kunder', async () => {
      const { service, prepare, propose, tenants } = await setup();
      await prepare();
      await propose('P1');
      expect(await service.goLive('FINNS-INTE', { approvedProposalCount: 0 }, 'api')).toEqual({ result: 'not_found' });
      await service.goLive('T1', { approvedProposalCount: 1 }, 'api');
      expect((await tenants.get('T2'))?.mode).toBe('dry_run');
    });

    it('två godkännanden samtidigt ger exakt ett ok och en revisionspost', async () => {
      const { service, prepare, propose, repos } = await setup();
      await prepare();
      await propose('P1');
      const results = await Promise.all([
        service.goLive('T1', { approvedProposalCount: 1 }, 'api:a'),
        service.goLive('T1', { approvedProposalCount: 1 }, 'api:b'),
      ]);
      expect(results.filter((r) => r.result === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r.result === 'already_live')).toHaveLength(1);
      expect(await repos.audit.list('T1')).toHaveLength(1);
    });
  });

  describe('anslutningstest', () => {
    it('är null utan leverantör', async () => {
      const { service } = await setup();
      expect(await service.checkConnection('T1')).toBeNull();
      expect((await service.status('T1'))?.ledger).toBeUndefined();
    });

    it('visar leverantörens förmågor i statusen', async () => {
      const provider = new FakeLedgerProvider('briox', { ...FULL_CAPABILITIES, idempotentWrites: false });
      const { service } = await setup(provider);
      const ledger = (await service.status('T1'))?.ledger;
      expect(ledger?.provider).toBe('briox');
      expect(ledger?.capabilities.idempotentWrites).toBe(false);
      expect(ledger?.notes).toHaveLength(1);
    });

    it('returnerar leverantörens svar, begränsat i längd och antal', async () => {
      const provider = new FakeLedgerProvider();
      const { service } = await setup(provider);
      provider.setResult({ ok: false, problems: Array.from({ length: 30 }, () => 'x'.repeat(500)) });
      const check = await service.checkConnection('T1');
      expect(check?.ok).toBe(false);
      expect(check?.problems).toHaveLength(10);
      expect(check?.problems[0]).toHaveLength(200);
    });

    it('läcker inte felet när testet kastar', async () => {
      const provider = new FakeLedgerProvider();
      const { service } = await setup(provider);
      provider.setResult(new Error('token=HEMLIG123 avvisades'));
      const check = await service.checkConnection('T1');
      expect(check).toEqual({ ok: false, problems: ['Anslutningstestet kunde inte genomföras'] });
    });
  });
});

describe('onboarding via API', () => {
  async function api() {
    const s = await setup(new FakeLedgerProvider());
    const server = buildServer({
      ...s.repos,
      uow: s.uow,
      onboarding: s.service,
      authenticateDetailed: async (k) =>
        k === 'key-1' ? { tenantId: 'T1', keyId: 'k1', role: 'approver' as const } : k === 'key-2' ? { tenantId: 'T2', keyId: 'k2', role: 'approver' as const } : null,
      authenticate: async (k) => (k === 'key-1' ? 'T1' : k === 'key-2' ? 'T2' : null),
      clock: s.clock,
      rateLimit: false,
    });
    return { ...s, server };
  }
  const h1 = { 'x-api-key': 'key-1' };

  it('kräver inloggning', async () => {
    const { server } = await api();
    expect((await server.inject({ method: 'GET', url: '/v1/onboarding' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', payload: { approvedProposalCount: 0 } })).statusCode).toBe(401);
  });

  it('visar bara den egna kundens status', async () => {
    const { server, prepare } = await api();
    await prepare('T1');
    const a = (await server.inject({ method: 'GET', url: '/v1/onboarding', headers: h1 })).json();
    const b = (await server.inject({ method: 'GET', url: '/v1/onboarding', headers: { 'x-api-key': 'key-2' } })).json();
    expect(a.blockers).toEqual(['dry_run']);
    expect(b.blockers).toContain('accounts');
    expect(a.ledger.provider).toBe('fortnox');
  });

  it('godkänner go-live och svarar 409 med förklaring annars', async () => {
    const { server, prepare, propose, tenants } = await api();
    const go = (count: unknown) =>
      server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: h1, payload: { approvedProposalCount: count } });

    const early = await go(0);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('not_ready');

    await prepare();
    await propose('P1');
    const stale = await go(0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_review');

    const ok = await go(1);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ mode: 'live' });
    expect((await tenants.get('T1'))?.mode).toBe('live');

    const again = await go(1);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_live');
  });

  it('avvisar ogiltig indata', async () => {
    const { server } = await api();
    for (const payload of [{}, { approvedProposalCount: -1 }, { approvedProposalCount: 1.5 }, { approvedProposalCount: '1' }, { approvedProposalCount: 1, extra: true }]) {
      const r = await server.inject({ method: 'POST', url: '/v1/onboarding/go-live', headers: h1, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('testar anslutningen utan att skriva något', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'POST', url: '/v1/onboarding/check-connection', headers: h1 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, problems: [] });
  });

  it('finns inte utan onboarding-tjänsten', async () => {
    const s = await setup();
    const server = buildServer({ ...s.repos, authenticate: async () => 'T1', clock: s.clock, rateLimit: false });
    expect((await server.inject({ method: 'GET', url: '/v1/onboarding', headers: h1 })).statusCode).toBe(404);
  });
});
