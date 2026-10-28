import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/compose.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

const pepper = Buffer.alloc(32, 7);

async function setup() {
  const { db, clock } = await createTestStack();
  const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A'), makeInvoice('B')] });
  const source = new FakePayoutSource();
  const app = createApp({ db, clock, apiKeyPepper: pepper, adapters: { source, invoices: ledger, gateway: ledger } });

  const keys: Record<string, string> = {};
  for (const id of ['T1', 'T2']) {
    await app.tenants.create({ id, name: `Kund ${id}` }, clock.now());
    await setTenantAccounts(db, id, accounts);
    await app.tenants.setMode(id, 'live');
    keys[id] = (await app.apiKeys.issue(id, {}, clock.now(), pepper)).rawKey;
  }
  const get = (tenant: string, url: string) =>
    app.server.inject({ method: 'GET', url, headers: { 'x-api-key': keys[tenant]! } });
  return { app, ledger, source, keys, get, clock };
}

describe('hela produkten', () => {
  it('synkar, bokför och exponerar resultatet i API:t med tenant-isolering', async () => {
    const { app, source, ledger, get, keys } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]), 'T1');
    source.add(makePayout('P2', [payment('L1', 'REF-OKÄND', 5000)]), 'T1');

    const report = await app.runCycle();
    // T1 och T2 synkas båda från samma källa i testet, så rapportera per kund.
    expect(report.tenants.map((t) => t.tenantId)).toEqual(['T1', 'T2']);
    expect(report.execution.dead).toBe(0);
    expect(ledger.invoice('A')?.status).toBe('paid');

    const payouts = await get('T1', '/v1/payouts');
    expect(payouts.statusCode).toBe(200);
    const body = payouts.json() as { items: Array<{ payoutId: string; status: string }> };
    expect(body.items.map((p) => [p.payoutId, p.status])).toEqual([
      ['P1', 'complete'],
      ['P2', 'partial'],
    ]);

    const exceptions = (await get('T1', '/v1/exceptions?status=open')).json() as {
      items: Array<{ id: string; code: string }>;
    };
    expect(exceptions.items.map((e) => e.code)).toEqual(['NO_MATCH']);

    // T2 har sina egna utbetalningar och ser aldrig T1:s avvikelse.
    const t2 = (await get('T2', `/v1/exceptions/${exceptions.items[0]!.id}`)).statusCode;
    expect(t2).toBe(404);

    // Utan eller med fel nyckel kommer man inte åt något.
    expect((await app.server.inject({ method: 'GET', url: '/v1/payouts' })).statusCode).toBe(401);
    const wrong = await app.server.inject({ method: 'GET', url: '/v1/payouts', headers: { 'x-api-key': keys['T1']! + 'x' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('en människa kan stänga en avvikelse via API:t', async () => {
    const { app, source, keys } = await setup();
    source.add(makePayout('P2', [payment('L1', 'REF-OKÄND', 5000)]), 'T1');
    await app.runCycle();

    const list = (await app.server.inject({ method: 'GET', url: '/v1/exceptions', headers: { 'x-api-key': keys['T1']! } })).json() as {
      items: Array<{ id: string }>;
    };
    const id = list.items[0]!.id;
    const resolved = await app.server.inject({
      method: 'POST',
      url: `/v1/exceptions/${id}/resolve`,
      headers: { 'x-api-key': keys['T1']! },
      payload: { status: 'dismissed', note: 'Bokförd manuellt i Fortnox' },
    });
    expect(resolved.statusCode).toBe(200);
    const again = await app.server.inject({
      method: 'POST',
      url: `/v1/exceptions/${id}/resolve`,
      headers: { 'x-api-key': keys['T1']! },
      payload: { status: 'resolved', note: 'igen' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('avstängd kund synkas inte och dess nyckel slutar fungera', async () => {
    const { app, source, get } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]), 'T1');
    await app.tenants.setStatus('T2', 'suspended');

    const report = await app.runCycle();
    expect(report.tenants.map((t) => t.tenantId)).toEqual(['T1']);
    expect((await get('T2', '/v1/payouts')).statusCode).toBe(401);
  });
});

describe('mänskliga åtgärder', () => {
  it('dött kommando kan köas om via API:t och allt revisionsloggas utan fritext', async () => {
    const { app, source, ledger, keys, clock } = await setup();
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]), 'T1');
    const { LedgerError } = await import('../src/ports/index.js');
    ledger.failNext(new LedgerError('faktura spärrad', false));

    const report = await app.runCycle();
    expect(report.execution.dead).toBe(1);

    const detail = (await app.server.inject({ method: 'GET', url: '/v1/payouts/P1', headers: { 'x-api-key': keys['T1']! } })).json() as {
      commands: Array<{ id: string; status: string }>;
    };
    const dead = detail.commands.find((c) => c.status === 'dead')!;

    // Annan kund kan inte köa om kommandot.
    const foreign = await app.server.inject({ method: 'POST', url: `/v1/commands/${dead.id}/retry`, headers: { 'x-api-key': keys['T2']! } });
    expect(foreign.statusCode).toBe(409);

    const retried = await app.server.inject({ method: 'POST', url: `/v1/commands/${dead.id}/retry`, headers: { 'x-api-key': keys['T1']! } });
    expect(retried.statusCode).toBe(200);
    // Ett levande kommando kan inte köas om igen.
    expect((await app.server.inject({ method: 'POST', url: `/v1/commands/${dead.id}/retry`, headers: { 'x-api-key': keys['T1']! } })).statusCode).toBe(409);

    clock.advance(1000);
    const second = await app.runCycle();
    expect(second.execution).toMatchObject({ succeeded: 2, dead: 0 });
    expect(ledger.invoice('A')?.status).toBe('paid');

    const audit = await app.repos.audit.list('T1');
    expect(audit.map((a) => a.action)).toContain('command.requeued');
  });

  it('stängd avvikelse revisionsloggas utan den fria anteckningen', async () => {
    const { app, source, keys } = await setup();
    source.add(makePayout('P2', [payment('L1', 'REF-OKÄND', 5000)]), 'T1');
    await app.runCycle();
    const list = (await app.server.inject({ method: 'GET', url: '/v1/exceptions', headers: { 'x-api-key': keys['T1']! } })).json() as {
      items: Array<{ id: string }>;
    };
    await app.server.inject({
      method: 'POST',
      url: `/v1/exceptions/${list.items[0]!.id}/resolve`,
      headers: { 'x-api-key': keys['T1']! },
      payload: { status: 'resolved', note: 'Kundens personnummer 19121212-1212 hemligt' },
    });
    const entry = (await app.repos.audit.list('T1')).find((a) => a.action === 'exception.resolved')!;
    expect(entry.details).toMatchObject({ status: 'resolved', code: 'NO_MATCH' });
    expect(JSON.stringify(entry)).not.toContain('personnummer');
  });
});
