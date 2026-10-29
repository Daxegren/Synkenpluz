import { describe, expect, it } from 'vitest';
import { createGatewayGuardStore } from '../src/db/gatewayGuard.js';
import type { LedgerCommand } from '../src/domain/types.js';
import { drain } from '../src/executor/executor.js';
import { MemoryGatewayGuardStore } from '../src/gateways/fakeGuard.js';
import { GuardedLedgerGateway } from '../src/gateways/guarded.js';
import { LedgerError, type GatewayGuardStore, type LedgerGateway } from '../src/ports/index.js';
import { TestClock, createTestStack } from './helpers.js';

const cmd = (key = 'k1'): LedgerCommand => ({
  kind: 'register_invoice_payment',
  key,
  lineId: key,
  invoiceId: 'A',
  amount: 12500,
  currency: 'SEK',
  date: '2026-10-28',
});

/**
 * Ett affärssystem utan egen idempotens: varje anrop bokför igen. Så antar vi att Fortnox kan vara
 * tills motsatsen är bevisad. Utan skydd ger omförsök dubbelbokning.
 */
class NaiveLedger implements LedgerGateway {
  applied: string[] = [];
  private script: Array<'ok' | 'lost-response' | LedgerError | Error> = [];
  calls = 0;
  script_(...steps: Array<'ok' | 'lost-response' | LedgerError | Error>) {
    this.script.push(...steps);
  }
  async execute(_tenantId: string, command: LedgerCommand) {
    this.calls++;
    const step = this.script.shift() ?? 'ok';
    if (step instanceof Error) throw step; // avvisat före bokföring
    this.applied.push(command.key); // bokfört
    if (step === 'lost-response') throw new LedgerError('anslutningen bröts', true, undefined, false);
    return { externalId: `EXT-${this.applied.length}` };
  }
}

const unknown = () => new LedgerError('timeout', true, undefined, false);
const rejected = () => new LedgerError('429', true, 1000, true);

type StoreFactory = () => Promise<{ store: GatewayGuardStore; clock: TestClock; failComplete?: () => void }>;

const factories: Array<[string, StoreFactory]> = [
  [
    'minne',
    async () => {
      const store = new MemoryGatewayGuardStore();
      return { store, clock: new TestClock(), failComplete: () => (store.failCompleteTimes = 1) };
    },
  ],
  [
    'Postgres-schema (PGlite)',
    async () => {
      const { db, clock } = await createTestStack();
      return { store: createGatewayGuardStore(db), clock };
    },
  ],
];

describe.each(factories)('GuardedLedgerGateway mot journal i %s', (_name, factory) => {
  async function setup(opts: { verify?: ConstructorParameters<typeof GuardedLedgerGateway>[2]['verify'] } = {}) {
    const { store, clock, failComplete } = await factory();
    const inner = new NaiveLedger();
    const guarded = new GuardedLedgerGateway(inner, store, { clock, ...opts });
    return { store, clock, inner, guarded, failComplete };
  }

  it('utan skydd dubbelbokar ett naivt affärssystem vid omförsök (utgångspunkten)', async () => {
    const inner = new NaiveLedger();
    inner.script_('lost-response');
    await inner.execute('T1', cmd()).catch(() => undefined);
    await inner.execute('T1', cmd()); // executorn försöker igen
    expect(inner.applied).toEqual(['k1', 'k1']); // dubbelbokat
  });

  it('lyckat anrop sparas och samma nyckel ger samma svar utan nytt anrop', async () => {
    const { guarded, inner } = await setup();
    const first = await guarded.execute('T1', cmd());
    const second = await guarded.execute('T1', cmd());
    expect(second).toEqual(first);
    expect(inner.calls).toBe(1);
  });

  it('säkert avvisat anrop (notApplied) släpper nyckeln så att ett nytt försök är tillåtet', async () => {
    const { guarded, inner } = await setup();
    inner.script_(rejected());
    await expect(guarded.execute('T1', cmd())).rejects.toThrow('429');
    await expect(guarded.execute('T1', cmd())).resolves.toEqual({ externalId: 'EXT-1' });
    expect(inner.applied).toEqual(['k1']);
  });

  it('förlorat svar efter bokföring: ingen dubbelbokning, utfallet blir okänt och kräver människa', async () => {
    const { guarded, inner, clock } = await setup();
    inner.script_('lost-response');
    await expect(guarded.execute('T1', cmd())).rejects.toThrow('anslutningen bröts');
    expect(inner.applied).toEqual(['k1']); // bokfört en gång

    // Kort därefter: kan fortfarande pågå hos en annan arbetare, försök igen senare (tillfälligt fel).
    const soon = await guarded.execute('T1', cmd()).catch((e: LedgerError) => e);
    expect(soon).toMatchObject({ retryable: true });

    // Efter ett tag: utfallet är okänt. Skickas INTE igen. Permanent fel till människa.
    clock.advance(10 * 60_000);
    const later = await guarded.execute('T1', cmd()).catch((e: LedgerError) => e);
    expect(later).toBeInstanceOf(LedgerError);
    expect(later).toMatchObject({ retryable: false });
    expect((later as LedgerError).message).toContain('okänt');
    expect(inner.calls).toBe(1); // aldrig skickat igen
  });

  it('timeout (okänt utfall) skickas aldrig om automatiskt', async () => {
    const { guarded, inner, clock } = await setup();
    inner.script_(unknown());
    await guarded.execute('T1', cmd()).catch(() => undefined);
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd())).rejects.toMatchObject({ retryable: false });
    expect(inner.calls).toBe(1);
  });

  it('icke-LedgerError från adaptern räknas som okänt utfall, inte som säkert misslyckande', async () => {
    const { guarded, inner, clock } = await setup();
    inner.script_(new TypeError('bugg i adaptern'));
    await guarded.execute('T1', cmd()).catch(() => undefined);
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd())).rejects.toMatchObject({ retryable: false });
    expect(inner.calls).toBe(1);
  });

  it('en människa kan avgöra ett osäkert utfall: utfört ger samma svar, ej utfört tillåter nytt försök', async () => {
    const { guarded, inner, clock, store } = await setup();
    inner.script_('lost-response', unknown());
    await guarded.execute('T1', cmd('a')).catch(() => undefined);
    await guarded.execute('T1', cmd('b')).catch(() => undefined);
    clock.advance(10 * 60_000);
    expect((await store.listInDoubt('T1')).map((r) => r.key).sort()).toEqual(['a', 'b']);

    // Operatören kontrollerar i affärssystemet: a utfördes (EXT-X), b utfördes inte.
    expect(await store.resolve('T1', 'a', { applied: true, externalId: 'EXT-X' }, clock.now())).toBe(true);
    expect(await store.resolve('T1', 'b', { applied: false }, clock.now())).toBe(true);
    expect(await store.listInDoubt('T1')).toEqual([]);

    await expect(guarded.execute('T1', cmd('a'))).resolves.toEqual({ externalId: 'EXT-X' });
    const before = inner.calls;
    await expect(guarded.execute('T1', cmd('b'))).resolves.toBeDefined();
    expect(inner.calls).toBe(before + 1);
    expect(inner.applied.filter((k) => k === 'a')).toHaveLength(1);
  });

  it('kan inte avgöra något som inte är osäkert, och kan aldrig göra om ett klart anrop', async () => {
    const { guarded, store, clock } = await setup();
    await guarded.execute('T1', cmd());
    expect(await store.resolve('T1', 'k1', { applied: false }, clock.now())).toBe(false);
    expect(await store.resolve('T1', 'finns-inte', { applied: false }, clock.now())).toBe(false);
    await store.abort('T1', 'k1'); // får inte radera ett klart anrop
    await expect(guarded.execute('T1', cmd())).resolves.toEqual({ externalId: 'EXT-1' });
  });

  it('verify löser osäkert utfall automatiskt: hittat ger klart, ej hittat ger nytt säkert försök', async () => {
    const found = new Set<string>();
    const { guarded, inner, clock } = await setup({
      verify: async (_t, c) => (found.has(c.key) ? { found: true, externalId: 'EXT-FUNNEN' } : { found: false }),
    });

    // Utfört men svaret försvann, och affärssystemet kan bekräfta det.
    inner.script_('lost-response');
    await guarded.execute('T1', cmd('a')).catch(() => undefined);
    found.add('a');
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd('a'))).resolves.toEqual({ externalId: 'EXT-FUNNEN' });
    expect(inner.applied).toEqual(['a']); // inte bokfört igen

    // Okänt utfall men affärssystemet säger att det INTE finns: säkert att försöka igen.
    inner.script_(unknown());
    await guarded.execute('T1', cmd('b')).catch(() => undefined);
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd('b'))).resolves.toBeDefined();
    expect(inner.applied).toEqual(['a', 'b']);
  });

  it('om verify själv misslyckas är utfallet fortfarande okänt, aldrig ett gissat "inte utfört"', async () => {
    const { guarded, inner, clock } = await setup({
      verify: async () => {
        throw new Error('affärssystemet nere');
      },
    });
    inner.script_('lost-response');
    await guarded.execute('T1', cmd()).catch(() => undefined);
    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd())).rejects.toMatchObject({ retryable: false });
    expect(inner.applied).toEqual(['k1']);
  });

  it('två samtidiga försök med samma nyckel bokför bara en gång', async () => {
    const { guarded, inner } = await setup();
    const results = await Promise.allSettled([guarded.execute('T1', cmd()), guarded.execute('T1', cmd())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(inner.applied).toEqual(['k1']);
  });

  it('samma nyckel hos två kunder är två olika anrop', async () => {
    const { guarded, inner } = await setup();
    await guarded.execute('T1', cmd());
    await guarded.execute('T2', cmd());
    expect(inner.applied).toHaveLength(2);
  });

  it('listInDoubt visar bara kundens egna osäkra anrop', async () => {
    const { guarded, inner, store } = await setup();
    inner.script_(unknown(), unknown());
    await guarded.execute('T1', cmd('a')).catch(() => undefined);
    await guarded.execute('T2', cmd('b')).catch(() => undefined);
    expect((await store.listInDoubt('T1')).map((r) => r.key)).toEqual(['a']);
    expect((await store.listInDoubt()).map((r) => r.key).sort()).toEqual(['a', 'b']);
  });
});

describe('GuardedLedgerGateway: journalen går inte att skriva efter lyckad bokföring', () => {
  it('bokför aldrig dubbelt: nästa försök ser ett osäkert utfall', async () => {
    const store = new MemoryGatewayGuardStore();
    const clock = new TestClock();
    const inner = new NaiveLedger();
    const guarded = new GuardedLedgerGateway(inner, store, { clock });

    store.failCompleteTimes = 1;
    await expect(guarded.execute('T1', cmd())).rejects.toThrow('journalen');
    expect(inner.applied).toEqual(['k1']);

    clock.advance(10 * 60_000);
    await expect(guarded.execute('T1', cmd())).rejects.toMatchObject({ retryable: false });
    expect(inner.applied).toEqual(['k1']);
  });
});

describe('tillsammans med utföraren: ett affärssystem utan idempotens', () => {
  it('förlorat svar leder till död-kommando för människa, och efter avgörande bokförs inget dubbelt', async () => {
    const { repos, clock } = await createTestStack();
    const guard = new MemoryGatewayGuardStore();
    const inner = new NaiveLedger();
    const gateway = new GuardedLedgerGateway(inner, guard, { clock });
    await repos.commands.enqueue('T1', 'P1', [cmd('k1')], clock.now());
    const deps = { commands: repos.commands, gateway, clock };

    // Anropet bokförs men svaret försvinner. Utföraren försöker igen efter backoff.
    inner.script_('lost-response');
    expect(await drain(deps)).toMatchObject({ retrying: 1, dead: 0 });
    clock.advance(10 * 60_000);
    // Försök 2: osäkert utfall -> permanent fel -> människa. Ingenting skickas om.
    expect(await drain(deps)).toMatchObject({ dead: 1, succeeded: 0 });
    expect(inner.applied).toEqual(['k1']);
    const [dead] = await repos.commands.listByPayout('T1', 'P1');
    expect(dead?.status).toBe('dead');

    // Operatören kontrollerar i affärssystemet: det utfördes. Avgör osäkerheten och köar om kommandot.
    await guard.resolve('T1', 'k1', { applied: true, externalId: 'EXT-VERIFIERAT' });
    expect(await repos.commands.requeue('T1', dead!.id, clock.now())).toBe(true);
    expect(await drain(deps)).toMatchObject({ succeeded: 1 });

    const [done] = await repos.commands.listByPayout('T1', 'P1');
    expect(done).toMatchObject({ status: 'succeeded', externalId: 'EXT-VERIFIERAT' });
    expect(inner.applied).toEqual(['k1']); // fortfarande bara en gång
  });
});
