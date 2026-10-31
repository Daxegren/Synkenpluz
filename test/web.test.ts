import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createMemoryStore } from '../src/testing/memory.js';
import { WEB_CSP, resolveWebRoot } from '../src/web/serve.js';
import {
  EXCEPTION_INFO,
  PAGES,
  ageText,
  apiErrorMessage,
  describeCommand,
  formatAmount,
  parseHash,
  ONBOARDING_PHASE,
  ROLE_LABEL,
  formatPercent,
  validateGoLive,
  validateGuardResolve,
  validateResolve,
  voucherBalance,
} from '../web/lib.js';
import { TestClock } from './helpers.js';

const root = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

function server(webRoot?: string) {
  const store = createMemoryStore();
  return buildServer({
    ...store,
    authenticate: async () => null,
    clock: new TestClock(),
    rateLimit: false,
    ...(webRoot ? { webRoot } : {}),
  });
}

describe('webbgränssnittet levereras säkert', () => {
  const web = resolveWebRoot({})!;

  it('hittar web/-katalogen', () => {
    expect(web).toMatch(/web$/);
  });

  it('serverar sidan och resurserna med strikta säkerhetsheaders', async () => {
    const app = server(web);
    for (const [url, type] of [
      ['/app', 'text/html'],
      ['/app/', 'text/html'],
      ['/app/app.js', 'text/javascript'],
      ['/app/lib.js', 'text/javascript'],
      ['/app/style.css', 'text/css'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain(type);
      expect(res.headers['content-security-policy'], url).toBe(WEB_CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('CSP tillåter inga inline-skript, inga externa resurser och ingen inbäddning', () => {
    expect(WEB_CSP).toContain("default-src 'none'");
    expect(WEB_CSP).toContain("script-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it('stödjer ETag och svarar 304 när inget ändrats', async () => {
    const app = server(web);
    const first = await app.inject({ method: 'GET', url: '/app/app.js' });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    const again = await app.inject({ method: 'GET', url: '/app/app.js', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
  });

  it('levererar bara allowlistade filer: ingen path traversal och inga andra sökvägar', async () => {
    const app = server(web);
    for (const url of ['/app/index.html', '/app/lib.d.ts', '/app/../package.json', '/app/..%2fpackage.json', '/app/%2e%2e/package.json', '/app/app.js/x', '/app/.env', '/app//etc/passwd']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('synkenpluz');
    }
    expect((await app.inject({ method: 'POST', url: '/app' })).statusCode).toBe(404);
  });

  it('finns inte alls om webRoot inte anges', async () => {
    const res = await server().inject({ method: 'GET', url: '/app' });
    expect(res.statusCode).toBe(404);
  });

  it('själva sidan kräver ingen nyckel men innehåller inga uppgifter', async () => {
    const res = await server(web).inject({ method: 'GET', url: '/app' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/synk_|api[-_ ]?key=|password=/i);
  });
});

describe('webbkoden följer säkerhetsreglerna', () => {
  const html = read('web/index.html');
  const app = read('web/app.js');
  const lib = read('web/lib.js');
  const css = read('web/style.css');

  it('använder aldrig API:er som tolkar text som HTML eller kod', () => {
    for (const [name, code] of [['app.js', app], ['lib.js', lib]] as const) {
      expect(code, name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\(\s*['"`]|dangerouslySet/);
    }
  });

  it('HTML:en har inga inline-skript, händelseattribut eller stilattribut', () => {
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('laddar ingenting från andra adresser', () => {
    for (const [name, code] of [['index.html', html], ['app.js', app], ['lib.js', lib], ['style.css', css]] as const) {
      const urls = [...code.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('http://www.w3.org'));
      expect(urls, name).toEqual([]);
    }
  });

  it('skickar bara nyckeln till /v1 och sparar den bara i sessionStorage', () => {
    expect(app).not.toMatch(/localStorage|document\.cookie|indexedDB/);
    const fetches = [...app.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(fetches).toEqual(['path']);
    const paths = [...app.matchAll(/api\('(?:GET|POST)',\s*[`'](\/[^`'$?]*)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.every((p) => p!.startsWith('/v1/'))).toBe(true);
  });

  it('bara tre filer laddas och alla finns i allowlisten', () => {
    const referenced = [...html.matchAll(/(?:src|href)="(\/app\/[^"]+)"/g)].map((m) => m[1]);
    expect(referenced.sort()).toEqual(['/app/app.js', '/app/style.css']);
    expect([...app.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1])).toEqual(['./lib.js']);
  });

  it('har språk, titel, landmärken och hoppa-över-länk', () => {
    expect(html).toContain('<html lang="sv">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toContain('<main');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="skip"');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('focus-visible');
  });
});

describe('gränssnittets logik (web/lib.js)', () => {
  it('formaterar belopp exakt utan flyttal', () => {
    expect(formatAmount(149000)).toBe('1 490,00 kr');
    expect(formatAmount(5)).toBe('0,05 kr');
    expect(formatAmount(0)).toBe('0,00 kr');
    expect(formatAmount(-50000)).toBe('−5 000 kr'.replace('5 000', '500,00'));
    expect(formatAmount(123456789)).toBe('1 234 567,89 kr');
    expect(formatAmount(Number.MAX_SAFE_INTEGER)).toBe('90 071 992 547 409,91 kr');
    expect(formatAmount(1050, 'EUR')).toBe('10,50 EUR');
    expect(formatAmount(1.5)).toBe('–');
    expect(formatAmount(Number.NaN)).toBe('–');
  });

  it('visar ålder i begripliga enheter', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(ageText('2026-10-29T11:59:50Z', now)).toBe('just nu');
    expect(ageText('2026-10-29T11:55:00Z', now)).toBe('5 min');
    expect(ageText('2026-10-29T09:00:00Z', now)).toBe('3 h');
    expect(ageText('2026-10-27T12:00:00Z', now)).toBe('2 dygn');
    expect(ageText('2026-10-30T12:00:00Z', now)).toBe('just nu'); // framtid blir aldrig negativ
    expect(ageText('skräp', now)).toBe('–');
  });

  it('har en förklaring och åtgärd för varje avvikelsekod i koden', () => {
    const block = /export type ExceptionCode =([^;]+);/.exec(read('src/domain/types.ts'))?.[1] ?? '';
    const codes = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(15);
    for (const code of codes) {
      const info = EXCEPTION_INFO[code];
      expect(info, code).toBeDefined();
      expect(info!.title.length, code).toBeGreaterThan(3);
      expect(info!.meaning.length, code).toBeGreaterThan(20);
      expect(info!.action.length, code).toBeGreaterThan(20);
    }
    expect(Object.keys(EXCEPTION_INFO).sort()).toEqual([...codes].sort()); // inga överblivna koder heller
  });

  it('beskriver kommandon för granskning, och verifikat som balanserar', () => {
    const pay = describeCommand({ kind: 'register_invoice_payment', invoiceId: 'F1', amount: 149000, currency: 'SEK', date: '2026-10-28' });
    expect(pay.title).toBe('Inbetalning på faktura');
    expect(pay.rows).toContainEqual(['Belopp', '1 490,00 kr']);
    const credit = describeCommand({ kind: 'credit_invoice', invoiceId: 'F1', mode: 'partial', amount: 50000, net: 40000, vat: 10000, currency: 'SEK', date: '2026-10-28' });
    expect(credit.rows).toContainEqual(['Typ', 'Delkreditering']);
    const lines = [
      { account: 1930, debit: 203300, credit: 0 },
      { account: 6570, debit: 4480, credit: 0 },
      { account: 2641, debit: 1120, credit: 0 },
      { account: 1580, debit: 0, credit: 208900 },
    ];
    const voucher = describeCommand({ kind: 'post_voucher', description: 'Utbetalning U1', date: '2026-10-28', lines });
    expect(voucher.voucher).toHaveLength(4);
    expect(voucherBalance(lines)).toEqual({ debit: 208900, credit: 208900, balanced: true });
    expect(voucherBalance([{ debit: 100, credit: 0 }, { debit: 0, credit: 99 }]).balanced).toBe(false);
  });

  it('tolkar adresser och avvisar okända sidor', () => {
    expect(parseHash('')).toEqual({ page: 'oversikt', id: null });
    expect(parseHash('#/forslag/UTB-1')).toEqual({ page: 'forslag', id: 'UTB-1' });
    expect(parseHash('#/utbetalningar/a%2Fb')).toEqual({ page: 'utbetalningar', id: 'a/b' });
    expect(parseHash('#/finns-inte/x')).toEqual({ page: 'oversikt', id: null });
    expect(parseHash('#/forslag/%E0%A4%A')).toEqual({ page: 'forslag', id: null }); // trasig kodning kraschar inte
    expect(PAGES).toEqual(['oversikt', 'start', 'forslag', 'utbetalningar', 'avvikelser', 'osakra']);
  });

  it('ger begripliga felmeddelanden och läcker inget oväntat', () => {
    expect(apiErrorMessage(401, null)).toContain('API-nyckeln');
    expect(apiErrorMessage(429, null, 12)).toContain('12 sekunder');
    expect(apiErrorMessage(0, null)).toContain('servern');
    expect(apiErrorMessage(409, { error: { message: 'Avvikelsen är inte öppen' } })).toContain('inte öppen');
    expect(apiErrorMessage(500, { error: { message: 'intern stacktrace' } })).not.toContain('stacktrace');
    expect(apiErrorMessage(418, null)).toBe('Något gick fel.');
  });

  it('beskriver varje fas i onboardingen och kräver bekräftad granskning vid go-live', () => {
    expect(Object.keys(ONBOARDING_PHASE)).toEqual(['setup', 'review', 'live']);
    for (const phase of Object.values(ONBOARDING_PHASE)) expect(phase.help.length).toBeGreaterThan(0);
    expect(validateGoLive({ reviewed: true })).toBeNull();
    expect(validateGoLive({ reviewed: false })).toContain('granskat');
    expect(validateGoLive({})).toContain('granskat');
  });

  it('formaterar andelar och namnger rollerna', () => {
    expect(formatPercent(0.834)).toBe('83 %');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(0)).toBe('0 %');
    expect(formatPercent(null)).toBe('–');
    expect(formatPercent(Number.NaN)).toBe('–');
    expect(Object.keys(ROLE_LABEL)).toEqual(['viewer', 'operator', 'approver']);
  });

  it('validerar formulär med samma regler som API:t', () => {
    expect(validateResolve({ status: 'resolved', note: 'Bokfört manuellt' })).toBeNull();
    expect(validateResolve({ status: 'resolved', note: '   ' })).toContain('anteckning');
    expect(validateResolve({ status: undefined, note: 'x' })).toContain('Välj');
    expect(validateResolve({ status: 'dismissed', note: 'x'.repeat(2001) })).toContain('lång');
    expect(validateGuardResolve({ applied: true, externalId: 'V-123' })).toBeNull();
    expect(validateGuardResolve({ applied: true, externalId: '' })).toContain('Ange id');
    expect(validateGuardResolve({ applied: false, externalId: '' })).toBeNull();
    expect(validateGuardResolve({ applied: false, externalId: 'V-1' })).toContain('inget id');
    expect(validateGuardResolve({})).toContain('Välj');
  });
});
