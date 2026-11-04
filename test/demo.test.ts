import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/compose.js';
import { DEMO_TENANTS, seedDemo, type DemoKey } from '../src/demo/seed.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakeLedgerProvider } from '../src/gateways/fakeProvider.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { StaticKeyProvider } from '../src/security/crypto.js';
import { createTestStack } from './helpers.js';

const pepper = Buffer.alloc(32, 4);

async function demo() {
  const { db, clock } = await createTestStack();
  const ledger = new FakeLedgerGateway();
  const app = createApp({
    db,
    clock,
    apiKeyPepper: pepper,
    rateLimit: false,
    adapters: { source: new FakePayoutSource(), invoices: ledger, gateway: ledger, provider: new FakeLedgerProvider() },
  });
  const keys = await seedDemo({ app, db, clock, pepper, ledger, keyProvider: new StaticKeyProvider({ k: Buffer.alloc(32, 8) }, 'k') });
  const get = async (key: DemoKey, url: string) => (await app.server.inject({ method: 'GET', url, headers: { 'x-api-key': key.key } })).json();
  const post = (key: DemoKey, url: string, payload?: unknown) =>
    app.server.inject({ method: 'POST', url, headers: { 'x-api-key': key.key }, ...(payload ? { payload } : {}) });
  const keyFor = (tenantId: string, role: string) => keys.find((k) => k.tenantId === tenantId && k.role === role)!;
  return { app, db, ledger, keys, get, post, keyFor };
}

describe('demoläge', () => {
  it('ger nycklar för två kunder med rätt roller', async () => {
    const { keys } = await demo();
    expect(keys.map((k) => [k.tenantId, k.role])).toEqual([
      [DEMO_TENANTS.test, 'approver'],
      [DEMO_TENANTS.test, 'viewer'],
      [DEMO_TENANTS.live, 'approver'],
    ]);
    expect(new Set(keys.map((k) => k.key)).size).toBe(3);
  });

  it('testkunden är redo för granskning med varierade förslag', async () => {
    const { get, keyFor } = await demo();
    const key = keyFor(DEMO_TENANTS.test, 'approver');
    const onboarding = await get(key, '/v1/onboarding');
    expect(onboarding).toMatchObject({ phase: 'review', blockers: [], mode: 'dry_run', proposals: { count: 8 } });

    const summary = await get(key, '/v1/proposals/summary');
    expect(summary.payouts).toEqual({ total: 8, complete: 4, partial: 3, rejected: 1 });
    expect(summary.lineMatchRate).toBeGreaterThan(0.6);
    expect(summary.lineMatchRate).toBeLessThan(0.95);
    const codes = summary.exceptionsByCode.map((e: { code: string }) => e.code).sort();
    expect(codes).toEqual(['AMBIGUOUS_MATCH', 'AMOUNT_MISMATCH', 'NO_MATCH', 'PAYOUT_SUM_MISMATCH']);
  });

  it('visar en EUR-utbetalning bokförd på EUR-konton och en delkreditering', async () => {
    const { get, keyFor } = await demo();
    const key = keyFor(DEMO_TENANTS.test, 'approver');
    const eur = await get(key, '/v1/proposals/UTB-1106');
    expect(eur.status).toBe('complete');
    const voucher = eur.commands.find((c: { kind: string }) => c.kind === 'post_voucher');
    expect(voucher.currency).toBe('EUR');
    expect(voucher.lines.every((l: { account: number }) => [1932, 1582, 6571, 2642].includes(l.account))).toBe(true);

    const refund = await get(key, '/v1/proposals/UTB-1102');
    expect(refund.commands.some((c: { kind: string; mode?: string }) => c.kind === 'credit_invoice' && c.mode === 'partial')).toBe(true);
  });

  it('livekunden har bokförda utbetalningar, en öppen avvikelse, ett dött kommando och ett osäkert anrop', async () => {
    const { get, keyFor, ledger } = await demo();
    const key = keyFor(DEMO_TENANTS.live, 'approver');
    expect(await get(key, '/v1/onboarding')).toMatchObject({ phase: 'live' });

    const payouts = await get(key, '/v1/payouts');
    const status = Object.fromEntries(payouts.items.map((p: { payoutId: string; status: string }) => [p.payoutId, p.status]));
    expect(status).toEqual({ 'UTB-0901': 'complete', 'UTB-0902': 'partial', 'UTB-0903': 'partial' });

    const exceptions = await get(key, '/v1/exceptions?status=open');
    expect(exceptions.items.map((e: { code: string }) => e.code)).toEqual(['NO_MATCH']);

    const dead = await get(key, '/v1/payouts/UTB-0903');
    expect(dead.commands.map((c: { status: string }) => c.status)).toEqual(['dead']);

    expect((await get(key, '/v1/guard/in-doubt')).items).toHaveLength(1);
    // De bokförda utbetalningarna är faktiskt utförda i det simulerade affärssystemet.
    expect(ledger.invoice('3001')?.status).toBe('paid');
    expect(ledger.invoice('3004')?.status).toBe('open');
  });

  it('godkännaren kan gå live, läsaren kan inte, och kunderna är isolerade', async () => {
    const { get, post, keyFor } = await demo();
    const viewer = keyFor(DEMO_TENANTS.test, 'viewer');
    const approver = keyFor(DEMO_TENANTS.test, 'approver');
    expect((await post(viewer, '/v1/onboarding/go-live', { approvedProposalCount: 8 })).statusCode).toBe(403);
    expect((await post(approver, '/v1/onboarding/go-live', { approvedProposalCount: 7 })).json().error.code).toBe('stale_review');
    expect((await post(approver, '/v1/onboarding/go-live', { approvedProposalCount: 8 })).statusCode).toBe(200);

    // Testkundens nyckel ser inget av livekundens data.
    expect((await get(approver, '/v1/exceptions')).items).toEqual([]);
    expect((await get(approver, '/v1/payouts/UTB-0901')).error?.code).toBe('not_found');
  });

  it('är deterministisk och kan inte köras två gånger på samma databas', async () => {
    const a = await demo();
    const b = await demo();
    const summary = async (d: typeof a) => d.get(d.keyFor(DEMO_TENANTS.test, 'approver'), '/v1/proposals/summary');
    expect(await summary(a)).toEqual(await summary(b));
    await expect(
      seedDemo({ app: a.app, db: a.db, clock: { now: () => new Date() }, pepper, ledger: a.ledger, keyProvider: new StaticKeyProvider({ k: Buffer.alloc(32, 8) }, 'k') }),
    ).rejects.toThrow();
  });
});
