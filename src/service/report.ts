import type { ExceptionCode, ReconcileResult } from '../domain/types.js';
import type { StoredProposal } from '../ports/index.js';

/**
 * Sammanställningar av sparade dry_run-förslag: hur stor del av en kunds utbetalningar som kan bokföras
 * automatiskt, och ett underlag en redovisningskonsult kan granska. Rena funktioner utan I/O.
 */

export interface ProposalSummary {
  payouts: { total: number; complete: number; partial: number; rejected: number };
  lines: {
    /** Rader som matchats säkert mot en faktura och fått ett kommando. */
    matched: number;
    /** Rader som blev avvikelser. En rad räknas en gång även om den har flera avvikelser. */
    unmatched: number;
  };
  /** Andel av raderna som matchats, 0 till 1, eller null om det inte finns några rader. */
  lineMatchRate: number | null;
  /** Andel av utbetalningarna som blir helt klara utan mänsklig hjälp, 0 till 1, eller null om det inte finns några. */
  fullyAutomaticRate: number | null;
  /** Antal avvikelser per kod, vanligast först. Kodernas betydelse står i docs/RUNBOOK.md. */
  exceptionsByCode: Array<{ code: ExceptionCode; count: number }>;
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Räknar bara antal. Inga belopp, referenser eller fakturanummer lämnas ut. */
export function summarizeProposals(proposals: readonly StoredProposal[]): ProposalSummary {
  const payouts = { total: proposals.length, complete: 0, partial: 0, rejected: 0 };
  let matched = 0;
  let unmatched = 0;
  const byCode = new Map<ExceptionCode, number>();

  for (const proposal of proposals) {
    payouts[proposal.status]++;
    matched += proposal.result.commands.filter((c) => c.kind !== 'post_voucher').length;
    const lineIds = new Set<string>();
    for (const e of proposal.result.exceptions) {
      byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
      if (e.lineId !== undefined) lineIds.add(e.lineId);
    }
    unmatched += lineIds.size;
  }

  return {
    payouts,
    lines: { matched, unmatched },
    lineMatchRate: ratio(matched, matched + unmatched),
    fullyAutomaticRate: ratio(payouts.complete, payouts.total),
    exceptionsByCode: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
  };
}

// ---------------------------------------------------------------- underlag som CSV

const CSV_COLUMNS = ['Typ', 'Rad', 'Faktura', 'Datum', 'Valuta', 'Belopp', 'Moms', 'Konto', 'Debet', 'Kredit', 'Beskrivning'] as const;

/** Öre till kronor med decimalkomma (svenskt kalkylblad), t.ex. 12500 till "125,00" och -5 till "-0,05". */
export function formatKronor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Text som börjar med = + - @ eller en styrtecken tolkas som formel av kalkylprogram (CSV-injektion). Referenser och
 * meddelanden kommer från externa källor, så de får en inledande apostrof. Belopp skickas inte hit.
 */
function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const row = (values: Record<string, string>): string => CSV_COLUMNS.map((c) => cell(values[c] ?? '')).join(';');

/**
 * Underlag för ett förslag: varje betalning, kreditering och verifikatrad, samt avvikelserna. Semikolon som
 * separator och decimalkomma, så att det öppnas rätt i svenska kalkylprogram. Utan hemliga eller interna uppgifter
 * (idempotensnycklar ingår inte). Börjar med BOM och använder CRLF.
 */
export function proposalToCsv(proposal: StoredProposal): string {
  const lines: string[] = [CSV_COLUMNS.join(';')];
  const result: ReconcileResult = proposal.result;

  for (const c of result.commands) {
    if (c.kind === 'register_invoice_payment') {
      lines.push(
        row({
          Typ: 'Betalning',
          Rad: safeText(c.lineId),
          Faktura: safeText(c.invoiceId),
          Datum: c.date,
          Valuta: c.currency,
          Belopp: formatKronor(c.amount),
        }),
      );
    } else if (c.kind === 'credit_invoice') {
      lines.push(
        row({
          Typ: c.mode === 'full' ? 'Kreditering' : 'Delkreditering',
          Rad: safeText(c.lineId),
          Faktura: safeText(c.invoiceId),
          Datum: c.date,
          Valuta: c.currency,
          Belopp: formatKronor(c.amount),
          Moms: formatKronor(c.vat),
        }),
      );
    } else {
      for (const l of c.lines) {
        lines.push(
          row({
            Typ: 'Verifikatrad',
            Datum: c.date,
            Konto: String(l.account),
            Debet: formatKronor(l.debit),
            Kredit: formatKronor(l.credit),
            Beskrivning: safeText(c.description),
          }),
        );
      }
    }
  }
  for (const e of result.exceptions) {
    lines.push(row({ Typ: 'Avvikelse', Rad: safeText(e.lineId ?? ''), Beskrivning: safeText(`${e.code}: ${e.message}`) }));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
