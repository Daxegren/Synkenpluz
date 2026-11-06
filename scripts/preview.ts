/**
 * Provkörning av en utbetalningsfil mot en fakturafil, direkt från terminalen. Ingen server, ingen databas och inget sparas:
 *   npm run preview -- utbetalningar.csv fakturor.csv [--partial] [--payout-mapping fil.json] [--invoice-mapping fil.json]
 * Skriver hur stor del som kan stämmas av automatiskt, vilka avvikelser som är vanligast och vad som är fel i filerna.
 * Format och exempel: docs/PROVKORNING.md.
 */
import { readFileSync } from 'node:fs';
import { parseInvoiceCsv, type InvoiceCsvMapping } from '../src/import/invoices.js';
import { parsePayoutCsv, type PayoutCsvMapping } from '../src/import/payouts.js';
import { previewReconciliation } from '../src/service/preview.js';

const USAGE = 'Användning: npm run preview -- <utbetalningar.csv> <fakturor.csv> [--partial] [--payout-mapping fil.json] [--invoice-mapping fil.json]';

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Kunde inte läsa filen ${path}`);
  }
}

function readMapping<T>(path: string | undefined): T | undefined {
  if (!path) return undefined;
  try {
    const value: unknown = JSON.parse(readText(path));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new Error(`Mappningen i ${path} är inte ett giltigt JSON-objekt`);
  }
}

const percent = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)} %`);

function main(argv: string[]): void {
  const files: string[] = [];
  let partial = false;
  let payoutMapping: string | undefined;
  let invoiceMapping: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--partial') partial = true;
    else if (arg === '--payout-mapping') payoutMapping = argv[++i];
    else if (arg === '--invoice-mapping') invoiceMapping = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Okänd flagga ${arg}\n${USAGE}`);
    else files.push(arg);
  }
  const [payoutFile, invoiceFile] = files;
  if (!payoutFile || !invoiceFile || files.length > 2) throw new Error(USAGE);

  const payouts = parsePayoutCsv(readText(payoutFile), readMapping<PayoutCsvMapping>(payoutMapping));
  const invoices = parseInvoiceCsv(readText(invoiceFile), readMapping<InvoiceCsvMapping>(invoiceMapping));
  const preview = previewReconciliation({ payouts: payouts.payouts, invoices: invoices.invoices, ...(partial ? { allowPartialPayments: true } : {}) });
  const { summary } = preview;

  console.log(`\nUtbetalningsfilen: ${payouts.rows} rader, ${payouts.payouts.length} utbetalningar lästes`);
  console.log(`Fakturafilen:      ${invoices.rows} rader, ${invoices.invoices.length} fakturor lästes`);

  const problems = [...payouts.problems.map((p) => ['utbetalningsfilen', p] as const), ...invoices.problems.map((p) => ['fakturafilen', p] as const)];
  if (problems.length > 0) {
    console.log(`\n${problems.filter(([, p]) => p.code !== 'PAYOUT_OMITTED').length} problem i filerna (det som har ett problem lästes inte in):`);
    for (const [file, p] of problems) console.log(`  - ${file}${p.row ? `, rad ${p.row}` : ''}: ${p.message}`);
  }

  if (summary.payouts.total === 0) {
    console.log('\nInga utbetalningar att räkna på.\n');
    return;
  }
  console.log(`\nTräffsäkerhet`);
  console.log(`  Rader som matchats säkert:           ${percent(summary.lineMatchRate)} (${summary.lines.matched} av ${summary.lines.matched + summary.lines.unmatched})`);
  console.log(`  Utbetalningar helt klara utan hjälp: ${percent(summary.fullyAutomaticRate)} (${summary.payouts.complete} av ${summary.payouts.total})`);
  if (summary.exceptionsByCode.length > 0) {
    console.log('\nAvvikelser (kodernas betydelse: docs/RUNBOOK.md)');
    for (const e of summary.exceptionsByCode) console.log(`  ${String(e.count).padStart(4)}  ${e.code}`);
  }
  console.log('\nPer utbetalning');
  for (const p of preview.payouts) {
    console.log(`  ${p.payoutId.padEnd(20)} ${p.date}  ${p.status.padEnd(8)} matchade ${p.matchedLines}, avvikelser ${p.exceptions.length}`);
    for (const e of p.exceptions) console.log(`      ${e.code}${e.lineId ? ` (rad ${e.lineId})` : ''}: ${e.message}`);
  }
  console.log('\nIngenting har sparats eller bokförts.\n');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
