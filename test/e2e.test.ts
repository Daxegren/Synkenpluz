import { describe, expect, it } from 'vitest';
import type { PayoutLine } from '../src/domain/types.js';
import { backoffDelayMs, drain, recoverStale, runDueCommands } from '../src/executor/executor.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { LedgerError, type CommandRepository } from '../src/ports/index.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

async function setup(invoiceIds: string[]) {
  const stack = await createTestStack();
  const ledger = new FakeLedgerGateway({ invoices: invoiceIds.map((id) => makeInvoice(id)) });
  const execDeps = { commands: stack.repos.commands, gateway: ledger, clock: stack.clock };
  const svcDeps = { uow: stack.uow, clock: stack.clock };

  /** `visible` begränsar vilka fakturor adaptern hittar, för att simulera att en faktura ännu saknas. */
  const run = (
    lines: PayoutLine[],
    opts: Parameters<typeof processPayout>[2] & { visible?: string[]; payoutId?: string } = {},
  ) => {
    const { visible = invoiceIds, payoutId = 'P1', ...options } = opts;
    return processPayout(
      svcDeps,
      {
        tenantId: 'T1',
        payout: makePayout(payoutId, lines),
        // Adaptern hämtar färsk fakturastatus vid varje körning.
        invoices: visible.map((id) => ({ ...ledger.invoice(id)! })),
        accounts,
      },
      options,
    );
  };
  return { ...stack, ledger, execDeps, run };
}

describe('hela kedjan', () => {
  it('bokför betalningar och verifikat och är säker att köra om', async () => {
    const { run, execDeps, ledger, repos } = await setup(['A', 'B']);
    const lines = [payment('L1', 'REF-A', 12500, { net: 200, vat: 50 }), payment('L2', 'REF-B', 12500)];

    const first = await run(lines);
    expect(first.result.status).toBe('complete');
    expect(first.enqueued).toBe(3);

    expect(await drain(execDeps)).toMatchObject({ succeeded: 3, dead: 0, retrying: 0 });
    expect(ledger.invoice('A')?.status).toBe('paid');
    expect(ledger.invoice('B')?.status).toBe('paid');
    expect(ledger.vouchers).toHaveLength(1);
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');

    // Omkörning med färsk status: inget nytt köas, inget bokförs igen, inga falska avvikelser.
    const callsBefore = ledger.calls;
    const again = await run(lines);
    expect(again.enqueued).toBe(0);
    expect(again.result.exceptions).toEqual([]);
    await drain(execDeps);
    expect(ledger.calls).toBe(callsBefore);
    expect(await repos.exceptions.list('T1')).toEqual([]);
  });

  it('delvis: bokför det säkra, lyfter resten och slutför när avvikelsen är löst', async () => {
    const { run, execDeps, ledger, repos } = await setup(['A', 'B']);
    const lines = [payment('L1', 'REF-A', 12500), payment('L2', 'REF-B', 12500)];

    const first = await run(lines, { visible: ['A'] }); // fakturan för B finns inte ännu
    expect(first.result.status).toBe('partial');
    expect(first.enqueued).toBe(1);
    await drain(execDeps);
    expect(ledger.invoice('A')?.status).toBe('paid');
    expect(ledger.vouchers).toHaveLength(0); // clearing nollställs inte på halva underlaget
    expect((await repos.exceptions.list('T1', { status: 'open' })).map((e) => e.code)).toEqual(['NO_MATCH']);
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('partial');

    // Fakturan för B finns nu. Omkörning slutför utan att röra A igen.
    const callsBefore = ledger.calls;
    const second = await run(lines);
    expect(second.result.status).toBe('complete');
    expect(second.autoResolved).toBe(1);
    expect(second.result.exceptions).toEqual([]);
    await drain(execDeps);
    expect(ledger.calls - callsBefore).toBe(2); // betalning för B + verifikat
    expect(ledger.vouchers).toHaveLength(1);
    expect(ledger.vouchers[0]?.find((l) => l.account === 1930)?.debit).toBe(25000);
    expect(await repos.exceptions.list('T1', { status: 'open' })).toEqual([]);
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('complete');
  });

  it('dry_run beräknar förslag utan att spara något utom en revisionspost', async () => {
    const { run, repos, ledger, execDeps } = await setup(['A']);
    const outcome = await run([payment('L1', 'REF-A', 12500)], { mode: 'dry_run' });

    expect(outcome.result.status).toBe('complete');
    expect(outcome.result.commands).toHaveLength(2);
    expect(outcome.enqueued).toBe(0);
    expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
    expect(await repos.payouts.get('T1', 'P1')).toBeNull();
    expect((await repos.audit.list('T1')).map((a) => a.action)).toEqual(['payout.dry_run']);

    await drain(execDeps);
    expect(ledger.calls).toBe(0);

    // Godkännande = kör live.
    expect((await run([payment('L1', 'REF-A', 12500)])).enqueued).toBe(2);
  });

  it('avvisad utbetalning köar ingenting men sparar avvikelsen och statusen', async () => {
    const { uow, clock, repos } = await createTestStack();
    const outcome = await processPayout(
      { uow, clock },
      {
        tenantId: 'T1',
        payout: { ...makePayout('P1', [payment('L1', 'REF-A', 100)]), netAmount: 1 },
        invoices: [makeInvoice('A')],
        accounts,
      },
    );
    expect(outcome.result.status).toBe('rejected');
    expect(outcome.enqueued).toBe(0);
    expect(await repos.commands.listByPayout('T1', 'P1')).toEqual([]);
    expect((await repos.exceptions.list('T1')).map((e) => e.code)).toEqual(['PAYOUT_SUM_MISMATCH']);
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('rejected');
  });
});

describe('felhantering i utföraren', () => {
  it('tillfälligt fel ger nytt försök efter backoff och sedan lyckad bokföring', async () => {
    const { run, execDeps, ledger, clock, repos } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);
    ledger.failNext(new LedgerError('tillfälligt avbrott', true));

    expect(await runDueCommands(execDeps)).toMatchObject({ claimed: 1, retrying: 1, succeeded: 0 });
    expect(await runDueCommands(execDeps)).toMatchObject({ claimed: 0 }); // väntar på backoff

    clock.advance(31_000);
    expect(await drain(execDeps)).toMatchObject({ succeeded: 2, dead: 0 });
    const [payCmd] = await repos.commands.listByPayout('T1', 'P1');
    expect(payCmd?.attempts).toBe(2);
    expect(ledger.invoice('A')?.status).toBe('paid');
  });

  it('respekterar Retry-After från affärssystemet', async () => {
    const { run, execDeps, ledger, clock } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);
    ledger.failNext(new LedgerError('rate limit', true, 120_000));
    await runDueCommands(execDeps);

    clock.advance(60_000);
    expect((await runDueCommands(execDeps)).claimed).toBe(0);
    clock.advance(61_000);
    expect((await runDueCommands(execDeps)).claimed).toBe(1);
  });

  it('permanent fel ger dött kommando som blockerar resten, och utbetalningen blir partial', async () => {
    const { run, execDeps, ledger, repos } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);
    ledger.failNext(new LedgerError('faktura spärrad', false));

    expect(await drain(execDeps)).toMatchObject({ dead: 1, succeeded: 0 });
    const commands = await repos.commands.listByPayout('T1', 'P1');
    expect(commands.map((c) => c.status)).toEqual(['dead', 'pending']);
    expect(commands[0]?.lastError).toBe('faktura spärrad');
    expect(ledger.vouchers).toHaveLength(0); // verifikatet går aldrig före sin betalning

    const rerun = await run([payment('L1', 'REF-A', 12500)]);
    expect(rerun.result.status).toBe('complete'); // motorn är nöjd...
    expect((await repos.payouts.get('T1', 'P1'))?.status).toBe('partial'); // ...men utbetalningen är inte klar
  });

  it('ger upp efter maxAttempts', async () => {
    const { run, execDeps, ledger, clock, repos } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);
    for (let i = 0; i < 3; i++) ledger.failNext(new LedgerError('nere', true));

    for (let i = 0; i < 3; i++) {
      await runDueCommands(execDeps, { maxAttempts: 3 });
      clock.advance(3_600_000);
    }
    expect((await repos.commands.listByPayout('T1', 'P1'))[0]?.status).toBe('dead');
  });

  it('okänt fel behandlas som tillfälligt', async () => {
    const { run, execDeps, ledger } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);
    ledger.failNext(new Error('ECONNRESET'));
    expect(await runDueCommands(execDeps)).toMatchObject({ retrying: 1, dead: 0 });
  });

  it('krasch efter att affärssystemet svarat ger ingen dubbelbokning', async () => {
    const { run, ledger, clock, repos } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);

    // Simulera att resultatet inte kan sparas efter lyckad bokföring i affärssystemet.
    let failSave = true;
    const flaky: CommandRepository = {
      ...repos.commands,
      markSucceeded: async (id, externalId, now) => {
        if (failSave) {
          failSave = false;
          throw new Error('databasen försvann');
        }
        return repos.commands.markSucceeded(id, externalId, now);
      },
    };
    const deps = { commands: flaky, gateway: ledger, clock };

    expect(await runDueCommands(deps)).toMatchObject({ unconfirmed: 1, succeeded: 0 });
    expect(ledger.executed).toHaveLength(1);

    clock.advance(11 * 60_000);
    expect(await recoverStale(deps)).toBe(1);
    expect(await drain(deps)).toMatchObject({ succeeded: 2 });

    // Betalningen gjordes bara en gång i affärssystemet trots två försök.
    const payments = ledger.executed.filter((e) => e.command.kind === 'register_invoice_payment');
    expect(payments).toHaveLength(1);
    expect(ledger.calls).toBe(3); // 2 försök på betalningen (andra var uppslag) + verifikat
  });

  it('backoff växer exponentiellt upp till taket', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, 30_000, 3_600_000))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffDelayMs(50, 30_000, 3_600_000)).toBe(3_600_000);
  });
});

describe('förändrade rader och isolering', () => {
  it('lyfter en ändrad rad som redan köats i stället för att tyst ignorera den', async () => {
    const { run, execDeps, ledger, repos } = await setup(['A']);
    await run([payment('L1', 'REF-A', 12500)]);

    // Leverantören rapporterar nu ett annat belopp för samma rad.
    const outcome = await run([payment('L1', 'REF-A', 9999)]);
    expect(outcome.result.status).toBe('partial');
    expect(outcome.result.exceptions.map((e) => e.code)).toContain('COMMAND_CONFLICT');
    expect((await repos.exceptions.list('T1', { status: 'open' })).map((e) => e.code)).toContain('COMMAND_CONFLICT');

    // Det ursprungliga kommandot behålls oförändrat.
    await drain(execDeps);
    expect(ledger.invoice('A')?.status).toBe('paid');
  });

  it('två kunder påverkar inte varandra', async () => {
    const { repos, clock } = await createTestStack();
    const cmd = {
      kind: 'register_invoice_payment' as const,
      key: 'T1:k',
      lineId: 'L1',
      invoiceId: 'A',
      amount: 1,
      currency: 'SEK',
      date: '2026-10-28',
    };
    await repos.commands.enqueue('T1', 'P1', [cmd], clock.now());
    await repos.commands.enqueue('T2', 'P1', [{ ...cmd, key: 'T2:k' }], clock.now());
    expect(await repos.commands.listByPayout('T1', 'P1')).toHaveLength(1);
    expect(await repos.commands.listByPayout('T2', 'P1')).toHaveLength(1);
    expect(await repos.commands.listByPayout('T3', 'P1')).toEqual([]);
  });
});
