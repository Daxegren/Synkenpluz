import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/compose.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import type { LedgerCommand } from '../src/domain/types.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { LedgerError, type LedgerGateway } from '../src/ports/index.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

const pepper = Buffer.alloc(32, 5);

/** Affärssystem utan egen idempotens. Varje anrop bokför. Ett av dem kan "tappa svaret". */
class NaiveLedger implements LedgerGateway {
  applied: string[] = [];
  loseNext = false;
  constructor(private readonly reader: FakeLedgerGateway) {}
  async execute(_tenantId: string, command: LedgerCommand) {
    this.applied.push(command.key);
    if (this.loseNext) {
      this.loseNext = false;
      throw new LedgerError('anslutningen bröts efter bokföring', true, undefined, false);
    }
    return { externalId: `EXT-${this.applied.length}` };
  }
}

describe('skyddsgatewayen i hela produkten', () => {
  it('förlorat svar ger aldrig dubbelbokning: människa avgör via API, köar om, klart', async () => {
    const { db, clock } = await createTestStack();
    const reader = new FakeLedgerGateway({ invoices: [makeInvoice('A')] });
    const naive = new NaiveLedger(reader);
    const source = new FakePayoutSource();
    const app = createApp({ db, clock, apiKeyPepper: pepper, adapters: { source, invoices: reader, gateway: naive } });

    await app.tenants.create({ id: 'T1', name: 'Kund' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await app.tenants.setMode('T1', 'live');
    const { rawKey } = await app.apiKeys.issue('T1', {}, clock.now(), pepper);
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.server.inject({ method, url, headers: { 'x-api-key': rawKey }, ...(payload ? { payload } : {}) });

    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    naive.loseNext = true;

    // 1. Betalningen bokförs men svaret försvinner. Nytt försök planeras.
    const first = await app.runCycle();
    expect(first.execution).toMatchObject({ retrying: 1 });
    expect(naive.applied).toHaveLength(1);

    // 2. Senare: utfallet är okänt. Kommandot skickas INTE igen utan går till en människa.
    clock.advance(10 * 60_000);
    const second = await app.runCycle();
    expect(second.execution.dead).toBe(1);
    expect(second.alerts.some((a) => a.severity === 'critical')).toBe(true);
    expect(naive.applied).toHaveLength(1);

    // 3. Människan ser det i API:t, kontrollerar i affärssystemet och avgör: det utfördes.
    const inDoubt = (await call('GET', '/v1/guard/in-doubt')).json() as { items: Array<{ key: string }> };
    expect(inDoubt.items).toHaveLength(1);
    const resolved = await call('POST', '/v1/guard/resolve', { key: inDoubt.items[0]!.key, applied: true, externalId: 'EXT-VERIFIERAT' });
    expect(resolved.statusCode).toBe(200);
    expect(((await call('GET', '/v1/guard/in-doubt')).json() as { items: unknown[] }).items).toEqual([]);

    // 4. Köa om det döda kommandot. Det får det verifierade svaret utan att bokföras igen.
    const detail = (await call('GET', '/v1/payouts/P1')).json() as { commands: Array<{ id: string; status: string }> };
    const dead = detail.commands.find((c) => c.status === 'dead')!;
    expect((await call('POST', `/v1/commands/${dead.id}/retry`)).statusCode).toBe(200);
    clock.advance(1000);
    const third = await app.runCycle();
    expect(third.execution.dead).toBe(0);

    expect(naive.applied.filter((k) => k === inDoubt.items[0]!.key)).toHaveLength(1); // bokfört exakt en gång
    expect((await app.repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
    const audit = (await app.repos.audit.list('T1')).map((a) => a.action);
    expect(audit).toContain('guard.resolved');
    expect(audit).toContain('command.requeued');
  });

  it('kan stängas av för tester men är på som standard', async () => {
    const { db, clock } = await createTestStack();
    const reader = new FakeLedgerGateway();
    const on = createApp({ db, clock, apiKeyPepper: pepper, adapters: { source: new FakePayoutSource(), invoices: reader, gateway: reader } });
    const off = createApp({ db, clock, apiKeyPepper: pepper, guard: false, adapters: { source: new FakePayoutSource(), invoices: reader, gateway: reader } });
    expect(on.gateway).not.toBe(reader);
    expect(off.gateway).toBe(reader);
  });
});
