/**
 * Demo av hela flödet med simulerade system (ingen riktig Mondido, Fortnox eller databas):
 *   npm run demo
 * Visar: utbetalning in, avstämning, bokföring, en avvikelse som löser sig själv, ett fel som
 * försöks om, och att allt är säkert att köra om.
 */
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app/compose.js';
import { createPgliteDb } from '../src/db/db.js';
import { migrate } from '../src/db/migrations.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import type { Invoice, PayoutLine } from '../src/domain/types.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { LedgerError } from '../src/ports/index.js';

const kr = (öre: number) => `${(öre / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} kr`;
const rubrik = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

const faktura = (id: string, total: number): Invoice => ({
  id,
  reference: `ORDER-${id}`,
  currency: 'SEK',
  total,
  vatTotal: Math.round(total * 0.2),
  balance: total,
  creditedTotal: 0,
  creditedVatTotal: 0,
  status: 'open',
});
const betalning = (id: string, order: string, belopp: number, avgift: number): PayoutLine => ({
  type: 'payment',
  id,
  reference: `ORDER-${order}`,
  amount: belopp,
  currency: 'SEK',
  fee: { net: Math.round(avgift * 0.8), vat: avgift - Math.round(avgift * 0.8) },
});

async function main() {
  const db = createPgliteDb(new PGlite());
  await migrate(db);
  let nu = new Date('2026-10-28T08:00:00Z');
  const clock = { now: () => new Date(nu) };

  const affärssystem = new FakeLedgerGateway({ invoices: [faktura('1001', 149_000), faktura('1002', 59_900)] });
  const leverantör = new FakePayoutSource();
  const app = createApp({
    db,
    clock,
    apiKeyPepper: Buffer.alloc(32, 1),
    adapters: { source: leverantör, invoices: affärssystem, gateway: affärssystem },
  });

  await app.tenants.create({ id: 'demo', name: 'Demokund AB' }, clock.now());
  await setTenantAccounts(db, 'demo', { bank: 1930, clearing: 1580, feeExpense: 6570, feeVat: 2641 });
  await app.tenants.setMode('demo', 'live');
  const { rawKey } = await app.apiKeys.issue('demo', {}, clock.now(), Buffer.alloc(32, 1));
  const api = async (url: string) =>
    (await app.server.inject({ method: 'GET', url, headers: { 'x-api-key': rawKey } })).json();

  rubrik('1. Betalleverantören rapporterar en utbetalning med två ordrar och en order vi inte känner till');
  const rader = [betalning('r1', '1001', 149_000, 3_900), betalning('r2', '1002', 59_900, 1_700), betalning('r3', '1003', 25_000, 800)];
  const netto = rader.reduce((s, r) => s + (r.type === 'payment' ? r.amount - r.fee!.net - r.fee!.vat : 0), 0);
  leverantör.add({ id: 'UTB-1', date: '2026-10-28', currency: 'SEK', netAmount: netto, lines: rader });
  console.log(`   Utbetalning UTB-1: ${rader.length} rader, ${kr(netto)} till banken efter avgifter`);

  rubrik('2. Körcykel: synka, avstäm, bokför');
  affärssystem.failNext(new LedgerError('Affärssystemet var överbelastat (429), inget utfördes', true, 1000, true));
  let rapport = await app.runCycle();
  const s = rapport.tenants[0]!.summary!;
  console.log(`   Hämtade ${s.fetched}, helt avstämda ${s.complete}, delvis ${s.partial}, avvisade ${s.rejected}`);
  console.log(`   Bokfört: ${rapport.execution.succeeded}, nytt försök senare: ${rapport.execution.retrying} (tillfälligt fel)`);

  rubrik('3. API:t visar läget');
  console.log('   Utbetalningar:', JSON.stringify(((await api('/v1/payouts')) as { items: unknown[] }).items));
  const avvikelser = ((await api('/v1/exceptions?status=open')) as { items: Array<{ code: string; lineId: string; message: string }> }).items;
  for (const a of avvikelser) console.log(`   Avvikelse ${a.code} på rad ${a.lineId}: ${a.message}`);

  rubrik('4. Tiden går, felet var tillfälligt. Nästa cykel försöker igen');
  nu = new Date(nu.getTime() + 60_000);
  rapport = await app.runCycle();
  console.log(`   Bokfört: ${rapport.execution.succeeded}`);
  console.log(`   Faktura 1001: ${affärssystem.invoice('1001')!.status}, faktura 1002: ${affärssystem.invoice('1002')!.status}`);
  console.log('   Verifikat skapat ännu?', affärssystem.vouchers.length > 0 ? 'ja' : 'nej (väntar tills alla rader är lösta)');

  rubrik('5. Fakturan för order 1003 skapas i affärssystemet. Utbetalningen återupptas automatiskt');
  affärssystem.addInvoice(faktura('1003', 25_000));
  nu = new Date(nu.getTime() + 60_000);
  rapport = await app.runCycle();
  const återupptagna = rapport.tenants[0]!.summary!;
  console.log(`   Återupptagna: ${återupptagna.resumed}, helt avstämda: ${återupptagna.complete}`);
  const verifikat = affärssystem.vouchers[0]!;
  console.log('   Verifikat:');
  for (const l of verifikat) console.log(`     konto ${l.account}  debet ${kr(l.debit).padStart(12)}  kredit ${kr(l.credit).padStart(12)}`);
  const debet = verifikat.reduce((a, l) => a + l.debit, 0);
  const kredit = verifikat.reduce((a, l) => a + l.credit, 0);
  console.log(`   Balanserar: ${debet === kredit ? 'ja' : 'NEJ'}`);

  rubrik('6. Säkert att köra om: inget bokförs två gånger');
  const före = affärssystem.calls;
  nu = new Date(nu.getTime() + 60_000);
  await app.runCycle();
  await app.runCycle();
  console.log(`   Anrop mot affärssystemet vid omkörning: ${affärssystem.calls - före}`);
  console.log('   Öppna avvikelser:', ((await api('/v1/exceptions?status=open')) as { items: unknown[] }).items.length);
  console.log('   Utbetalning:', JSON.stringify(((await api('/v1/payouts/UTB-1')) as { status: string }).status));

  rubrik('7. Revisionslogg (utan belopp eller referenser)');
  for (const e of (await app.repos.audit.list('demo', 5)).reverse()) console.log(`   ${e.action} ${JSON.stringify(e.details)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
