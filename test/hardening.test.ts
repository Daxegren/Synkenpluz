import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createApp } from '../src/app/compose.js';
import { createConnectionRepository } from '../src/db/connections.js';
import { createUnitOfWork } from '../src/db/repositories.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import { createTenantRepository } from '../src/db/tenants.js';
import { drain, runDueCommands } from '../src/executor/executor.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { LedgerError, type LedgerGateway } from '../src/ports/index.js';
import { StaticKeyProvider } from '../src/security/crypto.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

const pepper = Buffer.alloc(32, 9);
const pay = (key: string, invoiceId = 'A0') => ({
  kind: 'register_invoice_payment' as const,
  key,
  lineId: key,
  invoiceId,
  amount: 12500,
  currency: 'SEK',
  date: '2026-10-28',
});

describe('avstängda kunder får inget utfört', () => {
  it('suspended och dry_run stoppar exekvering av redan köade kommandon', async () => {
    const { db, repos, clock } = await createTestStack();
    const tenants = createTenantRepository(db);
    await tenants.create({ id: 'T1', name: 'Kund' }, clock.now());
    await tenants.setMode('T1', 'live');
    await repos.commands.enqueue('T1', 'P1', [pay('a1')], clock.now());
    const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A0')] });
    const deps = { commands: repos.commands, gateway: ledger, clock };

    await tenants.setStatus('T1', 'suspended');
    expect((await drain(deps)).claimed).toBe(0);

    await tenants.setStatus('T1', 'active');
    await tenants.setMode('T1', 'dry_run');
    expect((await drain(deps)).claimed).toBe(0);
    expect(ledger.calls).toBe(0);

    await tenants.setMode('T1', 'live');
    expect((await drain(deps)).succeeded).toBe(1);
  });
});

describe('dött kommando efter klar utbetalning', () => {
  it('gör utbetalningen partial, loggar, och larmar i varje cykel tills en människa agerat', async () => {
    const { db, clock } = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A')] });
    const source = new FakePayoutSource();
    const app = createApp({ db, clock, apiKeyPepper: pepper, adapters: { source, invoices: ledger, gateway: ledger } });
    await app.tenants.create({ id: 'T1', name: 'Kund' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await app.tenants.setMode('T1', 'live');
    source.add(makePayout('P1', [payment('L1', 'REF-A', 12500)]));
    ledger.failNext(new LedgerError('faktura spärrad', false, undefined, true));

    const first = await app.runCycle();
    expect(first.alerts.some((a) => a.severity === 'critical')).toBe(true);
    expect((await app.repos.payouts.get('T1', 'P1'))?.status).toBe('partial');
    expect((await app.repos.audit.list('T1')).map((a) => a.action)).toContain('command.dead');

    // Larmet försvinner inte i nästa cykel bara för att inget nytt hänt.
    clock.advance(60_000);
    const second = await app.runCycle();
    expect(second.alerts.some((a) => a.severity === 'critical')).toBe(true);
    expect((await app.repos.payouts.get('T1', 'P1'))?.status).toBe('partial');
  });
});

describe('utförarens robusthet', () => {
  async function queued(count = 1) {
    const stack = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: Array.from({ length: count }, (_, i) => makeInvoice(`A${i}`)) });
    for (let i = 0; i < count; i++) {
      await stack.repos.commands.enqueue('T1', `P${i}`, [pay(`k${i}`, `A${i}`)], stack.clock.now());
    }
    return { ...stack, ledger, deps: { commands: stack.repos.commands, gateway: ledger, clock: stack.clock } };
  }

  it.each([
    ['NaN', Number.NaN],
    ['negativt', -5000],
    ['noll', 0],
    ['enormt', 1e15],
  ])('ogiltig eller extrem Retry-After (%s) bränner inga försök och låser inte resten', async (_name, retryAfter) => {
    const { deps, ledger, repos, clock } = await queued(2);
    ledger.failNext(new LedgerError('rate limit', true, retryAfter));
    ledger.failNext(new LedgerError('rate limit', true, retryAfter));

    const summary = await runDueCommands(deps);
    expect(summary).toMatchObject({ claimed: 2, retrying: 2, dead: 0 });

    for (const p of ['P0', 'P1']) {
      const [cmd] = await repos.commands.listByPayout('T1', p);
      expect(cmd?.status).toBe('failed');
      const wait = cmd!.nextAttemptAt.getTime() - clock.now().getTime();
      expect(wait).toBeGreaterThanOrEqual(30_000); // aldrig under vanlig backoff
      expect(wait).toBeLessThanOrEqual(3_600_000); // aldrig över taket
    }
  });

  it('Retry-After: 0 bränner inte alla försök på en enda drain', async () => {
    const { deps, ledger, repos } = await queued();
    for (let i = 0; i < 10; i++) ledger.failNext(new LedgerError('429', true, 0));
    await drain(deps);
    const [cmd] = await repos.commands.listByPayout('T1', 'P0');
    expect(cmd?.status).toBe('failed');
    expect(cmd?.attempts).toBe(1);
  });

  it('ett fel när utfallet ska sparas lämnar inte resten av omgången låst', async () => {
    const { deps, repos } = await queued(2);
    let first = true;
    const flaky = {
      ...deps,
      commands: {
        ...repos.commands,
        markSucceeded: async (id: string, ext: string, now: Date, attempt?: number) => {
          if (first) {
            first = false;
            throw new Error('databasen hickade');
          }
          return repos.commands.markSucceeded(id, ext, now, attempt);
        },
      },
    };
    const summary = await runDueCommands(flaky);
    expect(summary).toMatchObject({ claimed: 2, succeeded: 1, unconfirmed: 1 });
  });

  it('timeout per anrop ger nytt försök och blockerar inte omgången', async () => {
    const { deps, repos } = await queued(2);
    const slow: LedgerGateway = {
      execute: (tenantId, command) =>
        command.key === 'k0'
          ? new Promise(() => {}) // hänger för alltid
          : deps.gateway.execute(tenantId, command),
    };
    const summary = await runDueCommands({ ...deps, gateway: slow }, { executeTimeoutMs: 50 });
    expect(summary).toMatchObject({ claimed: 2, succeeded: 1, retrying: 1 });
    const [hung] = await repos.commands.listByPayout('T1', 'P0');
    expect(hung?.status).toBe('failed');
    expect(hung?.lastError).toContain('svarade inte');
  });

  it('ett kommando som låsts för många gånger utan avslut körs inte igen', async () => {
    const { deps, repos, ledger, clock } = await queued();
    // Simulera upprepade krascher: claim → ingen avslutning → släpp.
    for (let i = 0; i < 8; i++) {
      await repos.commands.claimDue(clock.now(), 1);
      clock.advance(31 * 60_000);
      await repos.commands.releaseStale(new Date(clock.now().getTime() - 30 * 60_000), clock.now());
    }
    const summary = await runDueCommands(deps);
    expect(summary).toMatchObject({ claimed: 1, dead: 1, succeeded: 0 });
    expect(ledger.calls).toBe(0);
  });
});

describe('avvisade utbetalningar rättas av leverantören', () => {
  it('tas upp igen och bokförs när underlaget blivit rätt', async () => {
    const { db, clock, repos } = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A')] });
    const source = new FakePayoutSource();
    const app = createApp({ db, clock, apiKeyPepper: pepper, adapters: { source, invoices: ledger, gateway: ledger } });
    await app.tenants.create({ id: 'T1', name: 'Kund' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await app.tenants.setMode('T1', 'live');

    // Leverantören rapporterar först en felaktig summa. Den hämtas bara en gång (cursorn går förbi).
    const bad = { ...makePayout('P1', [payment('L1', 'REF-A', 12500)]), netAmount: 1 };
    const entries = (source as unknown as { entries: Array<{ payout: typeof bad }> }).entries;
    source.add(bad);
    expect((await app.runCycle()).tenants[0]?.summary?.rejected).toBe(1);

    // Leverantören rättar utbetalningen.
    entries[0]!.payout = makePayout('P1', [payment('L1', 'REF-A', 12500)]);
    clock.advance(60_000);
    const report = await app.runCycle();
    expect(report.tenants[0]?.summary).toMatchObject({ resumed: 1, complete: 1 });
    expect(ledger.invoice('A')?.status).toBe('paid');
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
  });
});

describe('API: åtgärd och revisionspost är atomiska', () => {
  it('misslyckas loggningen rullas åtgärden tillbaka', async () => {
    const { db, repos, clock } = await createTestStack();
    await repos.exceptions.add('T1', 'P1', [{ code: 'NO_MATCH', lineId: 'L1', message: 'saknas' }], clock.now());
    const [exception] = await repos.exceptions.list('T1');

    const base = createUnitOfWork(db);
    const failingAudit = {
      run: <T>(fn: Parameters<typeof base.run<T>>[0]) =>
        base.run((r) => fn({ ...r, audit: { ...r.audit, append: async () => { throw new Error('loggen är nere'); } } })),
    };
    const server = buildServer({
      exceptions: repos.exceptions,
      payouts: repos.payouts,
      commands: repos.commands,
      authenticate: async (k) => (k === 'nyckel' ? 'T1' : null),
      clock,
      uow: failingAudit,
    });
    const res = await server.inject({
      method: 'POST',
      url: `/v1/exceptions/${exception!.id}/resolve`,
      headers: { 'x-api-key': 'nyckel' },
      payload: { status: 'dismissed', note: 'test' },
    });
    expect(res.statusCode).toBe(500);
    expect((await repos.exceptions.get('T1', exception!.id))?.status).toBe('open'); // inte stängd utan revisionspost
  });
});

describe('kopplingar', () => {
  it('lämnar bara ut uppgifter för aktiva kopplingar och återaktiveras av nya uppgifter', async () => {
    const { db, clock } = await createTestStack();
    await createTenantRepository(db).create({ id: 'T1', name: 'Kund' }, clock.now());
    const keys = new StaticKeyProvider({ k1: Buffer.alloc(32, 3) }, 'k1');
    const repo = createConnectionRepository(db, keys);

    await repo.upsert('T1', 'fortnox', { token: 'a' }, clock.now());
    expect(await repo.getCredentialsForExecution('T1', 'fortnox')).toEqual({ token: 'a' });

    await repo.setStatus('T1', 'fortnox', 'needs_reauth', clock.now());
    expect(await repo.getCredentialsForExecution('T1', 'fortnox')).toBeNull();

    await repo.upsert('T1', 'fortnox', { token: 'b' }, clock.now());
    expect(await repo.getCredentialsForExecution('T1', 'fortnox')).toEqual({ token: 'b' });
    expect((await repo.getInfo('T1', 'fortnox'))?.status).toBe('active');
  });
});
