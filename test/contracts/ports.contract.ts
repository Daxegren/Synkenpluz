import { describe, expect, it } from 'vitest';
import type { Invoice, LedgerCommand, Payout } from '../../src/domain/types.js';
import { LedgerError, type LedgerGateway } from '../../src/ports/index.js';
import type { LedgerProvider } from '../../src/ports/ledger.js';
import type { InvoiceReader, PayoutSource } from '../../src/ports/sources.js';
import { LEDGER_PROVIDERS } from '../../src/service/onboarding.js';

/**
 * Kontraktssviter som VARJE adapter mot omvärlden ska klara. Kör dem mot nya adaptrar (Mondido,
 * Fortnox, Spiris) genom att skicka in en fabrik. De bevisar de egenskaper resten av systemet
 * förlitar sig på, särskilt de som annars bara går att upptäcka i drift: ingen förlorad
 * utbetalning, inga dubbletter, ingen läcka mellan kunder, och idempotent bokföring.
 */

// ----------------------------------------------------------------------------- PayoutSource

export interface PayoutSourceHarness {
  source: PayoutSource;
  /** Gör utbetalningar tillgängliga hos leverantören för en kund, i den ordning de kommer. */
  seed(tenantId: string, payouts: Payout[]): Promise<void>;
}

export function payoutShapeProblems(payout: Payout): string[] {
  const problems: string[] = [];
  if (!payout.id.trim()) problems.push('tomt id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payout.date)) problems.push('ogiltigt datum');
  const ids = new Set<string>();
  let net = 0;
  for (const line of payout.lines) {
    if (ids.has(line.id)) problems.push(`dubbelt rad-id ${line.id}`);
    ids.add(line.id);
    if (line.currency !== payout.currency) problems.push(`rad ${line.id} har annan valuta`);
    if (line.type === 'payment') net += line.amount - (line.fee ? line.fee.net + line.fee.vat : 0);
    else if (line.type === 'refund') net -= line.amount;
    else net -= line.fee.net + line.fee.vat;
  }
  if (net !== payout.netAmount) problems.push(`raderna summerar till ${net}, inte ${payout.netAmount}`);
  return problems;
}

export function payoutSourceContract(name: string, factory: () => Promise<PayoutSourceHarness>, samples: () => Payout[]): void {
  describe(`${name}: PayoutSource-kontrakt`, () => {
    it('listar allt från början och ger en cursor', async () => {
      const { source, seed } = await factory();
      const all = samples();
      await seed('T1', all);
      const result = await source.listPayoutsSince('T1', null);
      expect(result.payouts.map((p) => p.id).sort()).toEqual(all.map((p) => p.id).sort());
      expect(typeof result.nextCursor).toBe('string');
    });

    it('förlorar inget och dubblerar inget: cursorn tar bara det nya', async () => {
      const { source, seed } = await factory();
      const [a, b, c] = samples();
      await seed('T1', [a!, b!]);
      const first = await source.listPayoutsSince('T1', null);

      const idle = await source.listPayoutsSince('T1', first.nextCursor);
      expect(idle.payouts).toEqual([]);

      await seed('T1', [c!]);
      const next = await source.listPayoutsSince('T1', first.nextCursor);
      expect(next.payouts.map((p) => p.id)).toEqual([c!.id]);
    });

    it('är säker att anropa om med samma cursor (samma svar)', async () => {
      const { source, seed } = await factory();
      await seed('T1', samples());
      const one = await source.listPayoutsSince('T1', null);
      const two = await source.listPayoutsSince('T1', null);
      expect(two.payouts).toEqual(one.payouts);
      expect(two.nextCursor).toBe(one.nextCursor);
    });

    it('getPayout hittar en utbetalning på id och ger null för okänd', async () => {
      const { source, seed } = await factory();
      const [a] = samples();
      await seed('T1', [a!]);
      expect(await source.getPayout('T1', a!.id)).toEqual(a);
      expect(await source.getPayout('T1', 'FINNS-INTE')).toBeNull();
    });

    it('läcker aldrig mellan kunder', async () => {
      const { source, seed } = await factory();
      const [a, b] = samples();
      await seed('T1', [a!]);
      await seed('T2', [b!]);
      expect((await source.listPayoutsSince('T1', null)).payouts.map((p) => p.id)).toEqual([a!.id]);
      expect(await source.getPayout('T1', b!.id)).toBeNull();
      expect(await source.getPayout('T2', a!.id)).toBeNull();
    });

    it('returnerar utbetalningar som hänger ihop (summor, id, valuta, datum)', async () => {
      const { source, seed } = await factory();
      await seed('T1', samples());
      for (const payout of (await source.listPayoutsSince('T1', null)).payouts) {
        expect(payoutShapeProblems(payout), payout.id).toEqual([]);
      }
    });

    it('ger kopior: att ändra svaret påverkar inte nästa anrop', async () => {
      const { source, seed } = await factory();
      await seed('T1', samples());
      const one = await source.listPayoutsSince('T1', null);
      one.payouts[0]!.netAmount = -1;
      one.payouts.length = 0;
      expect((await source.listPayoutsSince('T1', null)).payouts.length).toBeGreaterThan(0);
    });
  });
}

// ----------------------------------------------------------------------------- InvoiceReader

export interface InvoiceReaderHarness {
  reader: InvoiceReader;
  seed(tenantId: string, invoices: Invoice[]): Promise<void>;
  /** Ändra en fakturas tillstånd hos affärssystemet (för att bevisa att läsningen är färsk). */
  update(tenantId: string, id: string, patch: Partial<Invoice>): Promise<void>;
}

export function invoiceReaderContract(name: string, factory: () => Promise<InvoiceReaderHarness>, samples: () => Invoice[]): void {
  describe(`${name}: InvoiceReader-kontrakt`, () => {
    it('hittar fakturor på referens (blanksteg runt referensen spelar ingen roll)', async () => {
      const { reader, seed } = await factory();
      const [a, b] = samples();
      await seed('T1', [a!, b!]);
      const found = await reader.findByReferences('T1', [` ${a!.reference} `]);
      expect(found.map((i) => i.id)).toEqual([a!.id]);
    });

    it('ger tom lista för okända referenser och för tom indata', async () => {
      const { reader, seed } = await factory();
      await seed('T1', samples());
      expect(await reader.findByReferences('T1', ['FINNS-INTE'])).toEqual([]);
      expect(await reader.findByReferences('T1', [])).toEqual([]);
    });

    it('ger bara efterfrågade fakturor, aldrig fler', async () => {
      const { reader, seed } = await factory();
      const [a, b, c] = samples();
      await seed('T1', [a!, b!, c!]);
      const found = await reader.findByReferences('T1', [a!.reference, c!.reference]);
      expect(found.map((i) => i.id).sort()).toEqual([a!.id, c!.id].sort());
    });

    it('läcker aldrig mellan kunder', async () => {
      const { reader, seed } = await factory();
      const [a, b] = samples();
      await seed('T1', [a!]);
      await seed('T2', [b!]);
      expect(await reader.findByReferences('T2', [a!.reference])).toEqual([]);
    });

    it('ger FÄRSK status vid varje anrop', async () => {
      const { reader, seed, update } = await factory();
      const [a] = samples();
      await seed('T1', [a!]);
      expect((await reader.findByReferences('T1', [a!.reference]))[0]?.status).toBe('open');
      await update('T1', a!.id, { status: 'paid', balance: 0 });
      expect((await reader.findByReferences('T1', [a!.reference]))[0]).toMatchObject({ status: 'paid', balance: 0 });
    });

    it('ger kopior som kan ändras utan att påverka nästa anrop', async () => {
      const { reader, seed } = await factory();
      const [a] = samples();
      await seed('T1', [a!]);
      const one = await reader.findByReferences('T1', [a!.reference]);
      one[0]!.balance = 1;
      expect((await reader.findByReferences('T1', [a!.reference]))[0]?.balance).toBe(a!.balance);
    });

    it('returnerar fakturor med giltiga belopp (heltal, icke-negativa, moms <= total)', async () => {
      const { reader, seed } = await factory();
      const all = samples();
      await seed('T1', all);
      for (const i of await reader.findByReferences('T1', all.map((x) => x.reference))) {
        for (const n of [i.total, i.vatTotal, i.balance, i.creditedTotal, i.creditedVatTotal]) {
          expect(Number.isSafeInteger(n) && n >= 0, i.id).toBe(true);
        }
        expect(i.vatTotal).toBeLessThanOrEqual(i.total);
        expect(i.balance).toBeLessThanOrEqual(i.total);
      }
    });
  });
}

// ----------------------------------------------------------------------------- LedgerGateway

export interface LedgerGatewayHarness {
  gateway: LedgerGateway;
  /** Förbered affärssystemet så att kommandot kan utföras (t.ex. skapa en öppen faktura). */
  prepare(tenantId: string, command: LedgerCommand): Promise<void>;
  /** Hur många gånger kommandot med nyckeln faktiskt bokförts i affärssystemet. */
  appliedCount(tenantId: string, key: string): number;
  /** Ett kommando som affärssystemet säkert avvisar (för att prova felklassning). Utelämna om det inte går att provocera. */
  invalidCommand?: () => LedgerCommand;
}

export function ledgerGatewayContract(name: string, factory: () => Promise<LedgerGatewayHarness>): void {
  const payment = (key: string): LedgerCommand => ({
    kind: 'register_invoice_payment',
    key,
    lineId: key,
    invoiceId: `INV-${key}`,
    amount: 12500,
    currency: 'SEK',
    date: '2026-10-28',
  });

  describe(`${name}: LedgerGateway-kontrakt`, () => {
    it('utför ett kommando och ger ett icke-tomt externt id', async () => {
      const { gateway, prepare, appliedCount } = await factory();
      await prepare('T1', payment('a'));
      const { externalId } = await gateway.execute('T1', payment('a'));
      expect(externalId).toBeTruthy();
      expect(appliedCount('T1', 'a')).toBe(1);
    });

    it('är idempotent på nyckeln: omförsök ger samma svar och bokför inte igen', async () => {
      const { gateway, prepare, appliedCount } = await factory();
      await prepare('T1', payment('a'));
      const first = await gateway.execute('T1', payment('a'));
      const again = await gateway.execute('T1', payment('a'));
      expect(again).toEqual(first);
      expect(appliedCount('T1', 'a')).toBe(1);
    });

    it('olika nycklar är olika kommandon', async () => {
      const { gateway, prepare, appliedCount } = await factory();
      await prepare('T1', payment('a'));
      await prepare('T1', payment('b'));
      const a = await gateway.execute('T1', payment('a'));
      const b = await gateway.execute('T1', payment('b'));
      expect(a.externalId).not.toBe(b.externalId);
      expect(appliedCount('T1', 'a')).toBe(1);
      expect(appliedCount('T1', 'b')).toBe(1);
    });

    it('samma nyckel hos två kunder är två kommandon', async () => {
      const { gateway, prepare, appliedCount } = await factory();
      await prepare('T1', payment('a'));
      await prepare('T2', payment('a'));
      await gateway.execute('T1', payment('a'));
      await gateway.execute('T2', payment('a'));
      expect(appliedCount('T1', 'a')).toBe(1);
      expect(appliedCount('T2', 'a')).toBe(1);
    });

    it('kastar LedgerError (aldrig något annat) när affärssystemet avvisar, och bokför inget', async () => {
      const h = await factory();
      if (!h.invalidCommand) return; // adaptern kan inte provoceras fram: hoppa över
      const bad = h.invalidCommand();
      const error = await h.gateway.execute('T1', bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LedgerError);
      expect(h.appliedCount('T1', bad.key)).toBe(0);
    });
  });
}

// ----------------------------------------------------------------------------- LedgerProvider

export interface LedgerProviderHarness {
  provider: LedgerProvider;
  /** Får kundens anslutning att inte fungera (t.ex. ogiltig token). */
  breakConnection(tenantId: string): Promise<void>;
  /** En hemlighet som ingår i kundens uppgifter och aldrig får synas i svaren. */
  secret: string;
}

/**
 * Kontrakt för beskrivningen av ett affärssystem. Onboardingen förlitar sig på att namnet är ett som den känner
 * igen, att förmågorna är ärliga, och att anslutningstestet varken skriver något eller läcker uppgifter.
 */
export function ledgerProviderContract(name: string, factory: () => Promise<LedgerProviderHarness>): void {
  describe(`LedgerProvider-kontrakt: ${name}`, () => {
    it('har ett namn som onboardingen känner igen och förmågor som är sanna eller falska', async () => {
      const { provider } = await factory();
      expect(LEDGER_PROVIDERS).toContain(provider.provider);
      for (const [capability, value] of Object.entries(provider.capabilities)) {
        expect(typeof value, capability).toBe('boolean');
      }
      expect(Object.keys(provider.capabilities).sort()).toEqual(['creditInvoice', 'idempotentWrites', 'postVoucher', 'searchByReference', 'verifyByReference']);
    });

    it('svarar ok utan problem när anslutningen fungerar', async () => {
      const { provider } = await factory();
      expect(await provider.checkConnection('T1')).toEqual({ ok: true, problems: [] });
    });

    it('förklarar vad som är fel när anslutningen inte fungerar, utan att läcka uppgifter', async () => {
      const { provider, breakConnection, secret } = await factory();
      await breakConnection('T1');
      const check = await provider.checkConnection('T1');
      expect(check.ok).toBe(false);
      expect(check.problems.length).toBeGreaterThan(0);
      expect(JSON.stringify(check)).not.toContain(secret);
    });

    it('påverkar inte andra kunder', async () => {
      const { provider, breakConnection } = await factory();
      await breakConnection('T1');
      expect((await provider.checkConnection('T2')).ok).toBe(true);
    });
  });
}
