import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app/compose.js';
import { createUnitOfWork } from '../src/db/repositories.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

/**
 * Webbgränssnittet i en riktig webbläsare mot en riktig server med riktiga data. Körs bara om Playwright
 * och en webbläsare finns (lokalt, inte i CI där det inte installeras). Skärmbilder sparas om
 * WEB_SHOTS_DIR är satt.
 */
// Playwright är globalt installerat och saknar typer här, därför löst typat.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type PW = Any;
function loadPlaywright(): PW | null {
  const candidates = [import.meta.url, '/opt/node22/lib/node_modules/x.js', '/usr/lib/node_modules/x.js', '/usr/local/lib/node_modules/x.js'];
  for (const base of candidates) {
    try {
      return createRequire(base)('playwright') as PW;
    } catch {
      /* prova nästa */
    }
  }
  return null;
}

const WAIT = { timeout: 10_000 } as const;
const visible = (l: Any) => l.waitFor({ state: 'visible', ...WAIT });
const hidden = (l: Any) => l.waitFor({ state: 'hidden', ...WAIT });
const text = (l: Any) => l.first().textContent() as Promise<string>;
const pw = loadPlaywright();
const shots = process.env.WEB_SHOTS_DIR;

const EVIL = '<img src=x onerror="window.__pwned=1">';
const pepper = Buffer.alloc(32, 3);

describe.skipIf(!pw)('webbgränssnitt i webbläsare', () => {
  let browser: Any;
  let base = '';
  let rawKey = '';
  let app: ReturnType<typeof createApp>;
  const shot = async (page: Any, name: string) => {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  };

  beforeAll(async () => {
    if (shots) mkdirSync(shots, { recursive: true });
    const { db, clock } = await createTestStack();
    const ledger = new FakeLedgerGateway({ invoices: [makeInvoice('A'), makeInvoice('B')] });
    app = createApp({
      db,
      clock,
      apiKeyPepper: pepper,
      rateLimit: false,
      adapters: { source: new FakePayoutSource(), invoices: ledger, gateway: ledger },
    });
    await app.tenants.create({ id: 'T1', name: 'Testkund' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await app.tenants.setMode('T1', 'live');
    rawKey = (await app.apiKeys.issue('T1', {}, clock.now(), pepper)).rawKey;

    const uow = createUnitOfWork(db);
    const run = (id: string, lines: ReturnType<typeof payment>[], mode: 'live' | 'dry_run') =>
      processPayout(
        { uow, clock },
        { tenantId: 'T1', payout: makePayout(id, lines), invoices: [makeInvoice('A'), makeInvoice('B')], accounts },
        { mode },
      );

    // Två förslag (testläge): ett komplett med verifikat, ett med avvikelse.
    await run('UTB-FORSLAG-1', [payment('L1', 'REF-A', 12500, { net: 200, vat: 50 }), payment('L2', 'REF-B', 12500)], 'dry_run');
    await run('UTB-FORSLAG-2', [payment('L1', 'REF-SAKNAS', 5000)], 'dry_run');
    // Live: en utbetalning med en avvikelse vars referens är ett XSS-försök.
    await run('UTB-LIVE-1', [payment('L1', 'REF-A', 12500), payment('L2', EVIL, 3000)], 'live');
    // Ett dött kommando och ett osäkert anrop.
    await app.repos.commands.enqueue(
      'T1',
      'UTB-DOD',
      [{ kind: 'register_invoice_payment', key: 'T1:UTB-DOD:L1:payment', lineId: 'L1', invoiceId: 'A', amount: 12500, currency: 'SEK', date: '2026-10-28' }],
      clock.now(),
    );
    const claimed = await app.repos.commands.claimDue(clock.now(), 10);
    const dead = claimed.find((c) => c.payoutId === 'UTB-DOD')!;
    await app.repos.commands.markFailed(dead.id, 'permanent', null, clock.now(), dead.attempts);
    await app.repos.payouts.record({ tenantId: 'T1', payoutId: 'UTB-DOD', status: 'partial', processedAt: clock.now() });
    await app.repos.guard.begin('T1', 'T1:UTB-DOD:L1:payment', clock.now());

    await app.server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
    browser = await pw!.chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await app?.server.close();
  });

  it('hela flödet: inloggning, granskning, avvikelse, köa om, osäkra anrop, utloggning', async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'sv-SE' });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e: Any) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m: Any) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('dialog', async (d: Any) => {
      problems.push(`oväntad alert/prompt: ${d.message()}`);
      await d.dismiss();
    });

    // Ingen sida får innehålla skräptext från felaktig rendering.
    const noJunk = async () => expect(await page.locator('main').innerText()).not.toMatch(/\bnull\b|\[object |\bundefined\b|\bNaN\b/);

    // --- inloggning
    await page.goto(`${base}/app`);
    await visible(page.getByRole('heading', { name: 'Logga in' }));
    await shot(page, '1-inloggning');

    await page.getByLabel('API-nyckel').fill('synk_felfelfelfel_fel');
    await page.getByRole('button', { name: 'Logga in' }).click();
    await visible(page.getByRole('alert').filter({ hasText: 'ogiltig' }));
    await hidden(page.getByRole('navigation'));

    await page.getByLabel('API-nyckel').fill(rawKey);
    await page.getByRole('button', { name: 'Logga in' }).click();
    await visible(page.getByRole('navigation', { name: 'Huvudmeny' }));

    // Nyckeln ligger bara i sessionStorage, aldrig i localStorage eller cookies.
    expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => sessionStorage.length)).toBe(1);

    // --- översikt
    await visible(page.getByRole('heading', { name: 'Översikt' }));
    await visible(page.getByText('1 osäkra anrop väntar på dig'));
    await expect.poll(() => text(page.locator('.stat').filter({ hasText: 'Förslag att granska' }).locator('.n'))).toBe('2');
    await noJunk();
    await shot(page, '2-oversikt');

    // --- förslag
    await page.getByRole('link', { name: 'Förslag', exact: true }).first().click();
    await visible(page.getByRole('link', { name: 'UTB-FORSLAG-1' }));
    await page.getByRole('link', { name: 'UTB-FORSLAG-1' }).click();
    await visible(page.getByText('Det här är bara ett förslag.'));
    await visible(page.getByText('Verifikatet balanserar', { exact: true }));
    await visible(page.getByRole('cell', { name: '1930' }));
    await visible(page.getByText('Inbetalning på faktura').first());
    await noJunk();
    await shot(page, '3-forslag');
    await page.getByRole('link', { name: '← Alla förslag' }).click();
    await page.getByRole('link', { name: 'UTB-FORSLAG-2' }).click();
    await visible(page.getByText('Ingen faktura hittades').first());

    // --- avvikelser och XSS
    await page.getByRole('link', { name: 'Avvikelser' }).click();
    const item = page.locator('details.item').first();
    await visible(item);
    await item.locator('summary').click();
    await visible(item.getByText(EVIL, { exact: false }).first()); // visas som text
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('main img').count()).toBe(0);
    await noJunk();
    await shot(page, '4-avvikelse');

    // utan anteckning går det inte att stänga
    await item.getByRole('button', { name: 'Stäng avvikelse' }).click();
    await visible(item.getByRole('alert').filter({ hasText: 'anteckning' }));

    await item.getByLabel(/Anteckning/).fill('Bokfört manuellt i Fortnox, verifikat 4711');
    await item.getByRole('button', { name: 'Stäng avvikelse' }).click();
    const dialog = page.getByRole('dialog');
    await visible(dialog);
    await dialog.getByRole('button', { name: 'Stäng avvikelse' }).click();
    await visible(page.getByText('Avvikelsen är stängd.'));
    await visible(page.getByText('Inga öppna avvikelser. Bra!'));

    // åtgärden finns i API:t och i revisionsloggen, utan den fria anteckningen
    const audit = await app.repos.audit.list('T1');
    const resolved = audit.find((a) => a.action === 'exception.resolved')!;
    expect(resolved.actor).toMatch(/^api:[0-9a-f]{12}$/); // bara det publika nyckel-id:t
    expect(JSON.stringify(audit)).not.toContain(rawKey.split('_')[2]!); // aldrig själva hemligheten
    expect(JSON.stringify(resolved)).not.toContain('4711');

    // --- utbetalning med dött kommando: köa om
    await page.getByRole('link', { name: 'Utbetalningar' }).click();
    await page.getByRole('link', { name: 'UTB-DOD' }).click();
    await visible(page.getByText('Ett kommando har misslyckats permanent.'));
    await noJunk();
    await shot(page, '5-utbetalning-dod');
    await page.getByRole('button', { name: 'Köa om' }).click();
    await expect.poll(() => text(page.getByRole('dialog'))).toContain('Kontrollera i affärssystemet först');
    await page.getByRole('dialog').getByRole('button', { name: 'Köa om' }).click();
    await visible(page.getByText('Kommandot är köat'));
    await expect.poll(() => page.getByRole('button', { name: 'Köa om' }).count()).toBe(0);
    await visible(page.getByText('Väntar').first());

    // --- osäkra anrop
    await page.getByRole('link', { name: 'Osäkra anrop' }).click();
    await visible(page.getByText('Så här fungerar osäkra anrop.'));
    await noJunk();
    await shot(page, '6-osakra');
    await visible(page.getByText('T1:UTB-DOD:L1:payment'));
    // utfördes: kräver id
    await page.getByLabel('Det utfördes (bokföringen finns där)').check();
    await page.getByRole('button', { name: 'Avgör' }).click();
    await visible(page.getByRole('alert').filter({ hasText: 'Ange id' }));
    await page.getByLabel(/Id i affärssystemet/).fill('VERIFIKAT-4711');
    await page.getByRole('button', { name: 'Avgör' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ja, det utfördes' }).click();
    await visible(page.getByText('Avgjort.'));
    await visible(page.getByText('Inga osäkra anrop. Bra!'));
    expect(await app.repos.guard.listInDoubt('T1')).toEqual([]);

    // --- utloggning
    await page.getByRole('button', { name: 'Logga ut' }).click();
    await visible(page.getByRole('heading', { name: 'Logga in' }));
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await page.reload();
    await visible(page.getByRole('heading', { name: 'Logga in' }));

    // Inga skriptfel och inga CSP-överträdelser. Webbläsaren loggar det avsiktliga 401-svaret från inloggningen
    // med fel nyckel; allt annat är ett fel.
    expect(problems.filter((p) => !/Failed to load resource.*status of 401/.test(p))).toEqual([]);
    await context.close();
  }, 120_000);

  it('fungerar på mobil bredd utan horisontell scroll och går att använda med tangentbordet', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 }, locale: 'sv-SE' });
    const page = await context.newPage();
    await page.goto(`${base}/app`);
    await page.getByLabel('API-nyckel').fill(rawKey);
    await page.keyboard.press('Enter'); // skicka formuläret med tangentbordet
    await visible(page.getByRole('navigation', { name: 'Huvudmeny' }));
    await page.getByRole('link', { name: 'Utbetalningar' }).click();
    await shot(page, '7-mobil');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // hoppa-över-länken är första fokusmålet
    await page.goto(`${base}/app`);
    const firstFocusable = await page.evaluate(() => {
      const el = document.querySelector('a[href], button:not([disabled]), input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])');
      return el?.textContent ?? '';
    });
    expect(firstFocusable).toBe('Hoppa till innehållet');
    await context.close();
  }, 120_000);

  it('en annan kunds nyckel ser aldrig den här kundens data', async () => {
    const context = await browser.newContext({ locale: 'sv-SE' });
    const page = await context.newPage();
    await app.tenants.create({ id: 'T2', name: 'Annan kund' }, new Date());
    const other = (await app.apiKeys.issue('T2', {}, new Date(), pepper)).rawKey;
    await page.goto(`${base}/app`);
    await page.getByLabel('API-nyckel').fill(other);
    await page.getByRole('button', { name: 'Logga in' }).click();
    await visible(page.getByText('Inget kräver din uppmärksamhet just nu.'));
    await page.getByRole('link', { name: 'Förslag', exact: true }).first().click();
    await visible(page.getByText('Inga sparade förslag.'));
    await context.close();
  }, 120_000);
});
