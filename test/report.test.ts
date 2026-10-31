import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createTenantRepository } from '../src/db/tenants.js';
import { formatKronor, proposalToCsv, summarizeProposals } from '../src/service/report.js';
import { processPayout } from '../src/service/processPayout.js';
import { accounts, createTestStack, makeInvoice, makePayout, payment } from './helpers.js';

async function setup() {
  const stack = await createTestStack();
  await createTenantRepository(stack.db).create({ id: 'T1', name: 'Kund' }, stack.clock.now());
  const invoices = [makeInvoice('A'), makeInvoice('B')];
  const run = (tenantId: string, payout: ReturnType<typeof makePayout>) =>
    processPayout({ uow: stack.uow, clock: stack.clock }, { tenantId, payout, invoices, accounts }, { mode: 'dry_run' });
  return { ...stack, run };
}

describe('formatKronor', () => {
  it('skriver öre som kronor med decimalkomma', () => {
    expect(formatKronor(0)).toBe('0,00');
    expect(formatKronor(5)).toBe('0,05');
    expect(formatKronor(12500)).toBe('125,00');
    expect(formatKronor(123456789)).toBe('1234567,89');
    expect(formatKronor(-5)).toBe('-0,05');
    expect(formatKronor(-12500)).toBe('-125,00');
  });
});

describe('summarizeProposals', () => {
  it('ger null i stället för 0 procent när det inte finns något att räkna på', () => {
    expect(summarizeProposals([])).toEqual({
      payouts: { total: 0, complete: 0, partial: 0, rejected: 0 },
      lines: { matched: 0, unmatched: 0 },
      lineMatchRate: null,
      fullyAutomaticRate: null,
      exceptionsByCode: [],
    });
  });

  it('räknar utbetalningar, rader och avvikelser över flera förslag', async () => {
    const { run, repos } = await setup();
    await run('T1', makePayout('P1', [payment('L1', 'REF-A', 12500), payment('L2', 'REF-B', 12500)])); // klar
    await run('T1', makePayout('P2', [payment('L1', 'REF-A', 12500), payment('L2', 'REF-SAKNAS', 5000), payment('L3', 'REF-OCKSA-SAKNAS', 100)])); // delvis
    await run('T1', { ...makePayout('P3', [payment('L1', 'REF-A', 12500)]), netAmount: 1 }); // avvisad: summan stämmer inte

    const s = summarizeProposals(await repos.proposals.list('T1'));
    expect(s.payouts).toEqual({ total: 3, complete: 1, partial: 1, rejected: 1 });
    // P1: 2 matchade. P2: 1 matchad, 2 omatchade. P3 avvisad: inget bokförs, men raden har ingen egen avvikelse.
    expect(s.lines.matched).toBe(3);
    expect(s.lines.unmatched).toBe(2);
    expect(s.lineMatchRate).toBeCloseTo(3 / 5);
    expect(s.fullyAutomaticRate).toBeCloseTo(1 / 3);
    expect(s.exceptionsByCode.find((e) => e.code === 'NO_MATCH')?.count).toBe(2);
    expect(s.exceptionsByCode.find((e) => e.code === 'PAYOUT_SUM_MISMATCH')?.count).toBe(1);
    // Vanligast först.
    expect(s.exceptionsByCode[0]?.code).toBe('NO_MATCH');
  });

  it('innehåller inga belopp, referenser eller fakturanummer', async () => {
    const { run, repos } = await setup();
    await run('T1', makePayout('P1', [payment('L1', 'REF-A', 12500), payment('L2', 'REF-HEMLIG-KUND', 5000)]));
    const json = JSON.stringify(summarizeProposals(await repos.proposals.list('T1')));
    expect(json).not.toContain('HEMLIG');
    expect(json).not.toContain('REF-A');
    expect(json).not.toContain('12500');
  });
});

describe('proposalToCsv', () => {
  it('ger ett underlag med betalning, verifikatrader och avvikelser, för svenska kalkylprogram', async () => {
    const { run, repos } = await setup();
    await run('T1', makePayout('P1', [payment('L1', 'REF-A', 12500, { net: 200, vat: 50 })]));
    const csv = proposalToCsv((await repos.proposals.get('T1', 'P1'))!);

    expect(csv.startsWith('﻿Typ;Rad;Faktura;Datum;Valuta;Belopp;Moms;Konto;Debet;Kredit;Beskrivning\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const rows = csv.slice(1).trim().split('\r\n').map((r) => r.split(';'));
    expect(rows[1]).toEqual(['Betalning', 'L1', 'A', '2026-10-28', 'SEK', '125,00', '', '', '', '', '']);
    const voucher = rows.filter((r) => r[0] === 'Verifikatrad');
    expect(voucher.length).toBeGreaterThanOrEqual(3);
    // Verifikatet balanserar i underlaget också.
    const sum = (i: number) => voucher.reduce((t, r) => t + Number((r[i] as string).replace(',', '.')), 0);
    expect(sum(8)).toBeCloseTo(sum(9));
    expect(csv).not.toContain('T1:P1:');
  });

  it('tar med avvikelser och citerar fält med semikolon, citattecken och radbrytning', async () => {
    const { repos, run } = await setup();
    await run('T1', makePayout('P1', [payment('L1', 'REF-SAKNAS', 5000)]));
    const stored = (await repos.proposals.get('T1', 'P1'))!;
    stored.result.exceptions = [{ code: 'NO_MATCH', lineId: 'L1', message: 'a;b "c"\nd' }];
    const csv = proposalToCsv(stored);
    expect(csv).toContain('"NO_MATCH: a;b ""c""\nd"');
  });

  it('neutraliserar formler: referenser från externa källor kan inte köra något i kalkylprogrammet', async () => {
    const { repos, run } = await setup();
    await run('T1', makePayout('P1', [payment('=HYPERLINK("http://ond")', 'REF-A', 12500)]));
    const stored = (await repos.proposals.get('T1', 'P1'))!;
    for (const c of stored.result.commands) if (c.kind === 'register_invoice_payment') c.invoiceId = '+cmd|calc';
    stored.result.exceptions = [{ code: 'NO_MATCH', lineId: '@SUM(1)', message: 'x' }];
    const csv = proposalToCsv(stored);
    const cells = csv.split(/[;\r\n]/);
    expect(cells.filter((c) => /^["]?[=+\-@]/.test(c))).toEqual([]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd|calc");
    expect(csv).toContain("'@SUM(1)");
  });
});

describe('rutter för sammanställning och underlag', () => {
  async function api() {
    const s = await setup();
    await createTenantRepository(s.db).create({ id: 'T2', name: 'Annan' }, s.clock.now());
    await s.run('T1', makePayout('P/1 ö', [payment('L1', 'REF-A', 12500)]));
    await s.run('T2', makePayout('P9', [payment('L1', 'REF-B', 12500)]));
    const server = buildServer({
      ...s.repos,
      proposals: s.repos.proposals,
      authenticate: async (k) => ({ k1: 'T1', k2: 'T2' })[k] ?? null,
      clock: s.clock,
      rateLimit: false,
    });
    return { ...s, server };
  }

  it('sammanställningen kräver nyckel och visar bara den egna kundens förslag', async () => {
    const { server } = await api();
    expect((await server.inject({ method: 'GET', url: '/v1/proposals/summary' })).statusCode).toBe(401);
    const a = (await server.inject({ method: 'GET', url: '/v1/proposals/summary', headers: { 'x-api-key': 'k1' } })).json();
    expect(a.payouts.total).toBe(1);
    expect(a.lineMatchRate).toBe(1);
  });

  it('en förslags-id som heter "summary" krockar inte med sammanställningen', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'GET', url: '/v1/proposals/summary/export.csv', headers: { 'x-api-key': 'k1' } });
    expect(r.statusCode).toBe(404);
  });

  it('exporterar CSV med rätt headers och ett säkert filnamn', async () => {
    const { server } = await api();
    const r = await server.inject({ method: 'GET', url: `/v1/proposals/${encodeURIComponent('P/1 ö')}/export.csv`, headers: { 'x-api-key': 'k1' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe('attachment; filename="forslag-P_1__.csv"');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('Betalning');
  });

  it('exporterar aldrig en annan kunds förslag', async () => {
    const { server } = await api();
    expect((await server.inject({ method: 'GET', url: '/v1/proposals/P9/export.csv', headers: { 'x-api-key': 'k1' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/v1/proposals/P9/export.csv', headers: { 'x-api-key': 'k2' } })).statusCode).toBe(200);
  });
});
