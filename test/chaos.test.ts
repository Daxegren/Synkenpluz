import { describe, expect, it } from 'vitest';
import { createGatewayGuardStore } from '../src/db/gatewayGuard.js';
import type { LedgerCommand } from '../src/domain/types.js';
import { recoverStale, runDueCommands } from '../src/executor/executor.js';
import { GuardedLedgerGateway } from '../src/gateways/guarded.js';
import { LedgerError, type LedgerGateway, type StoredCommand } from '../src/ports/index.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

/**
 * Slumpmässigt systemprov av kärnlöftet: aldrig dubbelbokföring, och allt blir till slut klart. Ett affärssystem UTAN egen
 * idempotens (det värsta fallet) får svara slumpmässigt: avvisa, utföra och tappa svaret, utföra och kasta ett okänt fel,
 * eller kasta ett okänt fel utan att utföra. Arbetare kraschar mitt i en omgång, utbetalningar bearbetas om i slumpad ordning
 * och klockan hoppar. En människa kontrollerar då och då de osäkra anropen mot sanningen (vad affärssystemet faktiskt tog emot)
 * och köar om döda kommandon, precis som i RUNBOOK. Samma frö ger alltid samma förlopp, så ett fel går att återskapa.
 */

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ett affärssystem som inte skyddar mot dubbletter alls. Räknar hur många gånger varje nyckel verkligen utförts. */
class NaiveLedger implements LedgerGateway {
  applications = new Map<string, number>();
  violations: string[] = [];
  chaos = true;
  constructor(private readonly random: () => number) {}

  private apply(command: LedgerCommand): string {
    const n = (this.applications.get(command.key) ?? 0) + 1;
    this.applications.set(command.key, n);
    if (n > 1) this.violations.push(`${command.key} utfördes ${n} gånger`);
    return `EXT-${command.key}`;
  }

  async execute(_tenantId: string, command: LedgerCommand): Promise<{ externalId: string }> {
    const r = this.chaos ? this.random() : 1;
    if (r < 0.15) throw new LedgerError('429 för många anrop', true, undefined, true); // säkert inte utfört
    if (r < 0.25) {
      this.apply(command);
      throw new LedgerError('timeout, svaret försvann', true, undefined, false); // utfört, svaret borta
    }
    if (r < 0.3) {
      this.apply(command);
      throw new Error('socket hang up'); // utfört, okänt fel
    }
    if (r < 0.35) throw new Error('ECONNRESET'); // INTE utfört, men det vet inte vi
    return { externalId: this.apply(command) };
  }
}

async function run(seed: number): Promise<void> {
  const random = rng(seed);
  const stack = await createTestStack();
  const { repos, clock } = stack;
  const ledger = new NaiveLedger(random);
  const guardStore = createGatewayGuardStore(stack.db);
  const gateway = new GuardedLedgerGateway(ledger, guardStore, { clock });
  const deps = { commands: repos.commands, gateway, clock };
  const options = { baseDelayMs: 1000, maxDelayMs: 5000, maxAttempts: 40 };

  const invoices = Array.from({ length: 12 }, (_, i) => makeInvoice(`I${i}`, { total: 10000 + i * 100, vatTotal: 2000, balance: 10000 + i * 100 }));
  const payouts = Array.from({ length: 4 }, (_, p) =>
    makePayout(
      `P${p}`,
      [0, 1, 2].map((l) => payment(`L${l}`, `REF-I${p * 3 + l}`, 10000 + (p * 3 + l) * 100, { net: 100, vat: 25 })),
    ),
  );
  const process = (payout: (typeof payouts)[number]) =>
    processPayout({ uow: stack.uow, clock }, { tenantId: 'T1', payout, invoices, accounts }, { mode: 'live' });

  const allCommands = async (): Promise<StoredCommand[]> => (await Promise.all(payouts.map((p) => repos.commands.listByPayout('T1', p.id)))).flat();

  /** Det en människa gör enligt RUNBOOK: kontrollera mot affärssystemet, avgör, och köa om det som dött. */
  const humanSweep = async () => {
    for (const entry of await guardStore.listInDoubt('T1')) {
      const truth = (ledger.applications.get(entry.key) ?? 0) > 0;
      await guardStore.resolve('T1', entry.key, truth ? { applied: true, externalId: `MANUELLT-${entry.key}` } : { applied: false }, clock.now());
    }
    for (const c of await allCommands()) if (c.status === 'dead') await repos.commands.requeue('T1', c.id, clock.now());
  };

  // Kaosfasen.
  for (let step = 0; step < 90; step++) {
    const action = random();
    if (action < 0.3) await process(payouts[Math.floor(random() * payouts.length)]!); // även omkörning av samma
    else if (action < 0.7) await runDueCommands(deps, options);
    else if (action < 0.8) await repos.commands.claimDue(clock.now(), 1 + Math.floor(random() * 4)); // arbetaren kraschar efter att ha låst
    else if (action < 0.9) await recoverStale({ commands: repos.commands, clock }, 20 * 60_000);
    else await humanSweep();
    clock.advance(Math.floor(random() * 12 * 60_000));
  }

  // Lugn fas: inga fler fel. Allt ska nu gå att få klart med de åtgärder en människa har.
  ledger.chaos = false;
  for (const payout of payouts) await process(payout);
  for (let round = 0; round < 12; round++) {
    await recoverStale({ commands: repos.commands, clock }, 20 * 60_000);
    await humanSweep();
    await runDueCommands(deps, options);
    clock.advance(31 * 60_000);
  }

  // Löftet 1: aldrig dubbelbokfört, oavsett vad som hände på vägen.
  expect(ledger.violations, `frö ${seed}`).toEqual([]);

  // Löftet 2: allt blev till slut klart, exakt en gång.
  const commands = await allCommands();
  expect(commands.length).toBeGreaterThanOrEqual(payouts.length * 4); // tre betalningar och ett verifikat per utbetalning
  for (const c of commands) {
    expect(c.status, `frö ${seed}, ${c.key}`).toBe('succeeded');
    expect(ledger.applications.get(c.key), `frö ${seed}, ${c.key}`).toBe(1);
  }
  expect(commands.filter((c) => c.command.kind === 'post_voucher')).toHaveLength(payouts.length);
  for (const payout of payouts) expect((await repos.payouts.get('T1', payout.id))?.status, `frö ${seed}`).toBe('complete');
  expect(await guardStore.listInDoubt('T1'), `frö ${seed}`).toEqual([]);
}

describe('slumpmässigt systemprov: aldrig dubbelbokföring, och allt blir klart', () => {
  for (const seed of [1, 2, 3, 7, 11, 42]) {
    it(`frö ${seed}`, async () => {
      await run(seed);
    }, 120_000);
  }
});
