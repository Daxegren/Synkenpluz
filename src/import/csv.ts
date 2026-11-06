/**
 * Läser CSV-filer från betalleverantörer och affärssystem. Ingen tolkning av innehållet här, bara formatet.
 * Strikt på det som är tvetydigt: en fil med fel antal kolumner eller en ostängd citering avvisas helt hellre
 * än att läsas på gissning, eftersom en förskjuten kolumn annars ger fel belopp på fel faktura.
 */

export const CSV_LIMITS = { maxBytes: 5_000_000, maxRows: 50_000, maxColumns: 60 } as const;

export class CsvError extends Error {
  constructor(
    message: string,
    /** Radnummer i filen (1 = rubrikraden), om felet hör till en rad. */
    readonly row?: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

export type Delimiter = ';' | ',' | '\t';

/** Väljer den avgränsare som förekommer flest gånger utanför citattecken på rubrikraden. Vid lika: semikolon (svensk standard). */
export function detectDelimiter(text: string): Delimiter {
  const first = text.replace(/^﻿/, '').split(/\r\n|\n|\r/, 1)[0] ?? '';
  const counts: Record<Delimiter, number> = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ';' || ch === ',' || ch === '\t')) counts[ch]++;
  }
  const best = (Object.keys(counts) as Delimiter[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ';' as Delimiter);
  return best;
}

export interface ParsedCsv {
  /** Rubrikerna, avklippta. */
  header: string[];
  /** Raderna, utan tomma rader. Varje rad har lika många celler som rubrikraden. `rowNumbers[i]` är radens nummer i filen. */
  rows: string[][];
  rowNumbers: number[];
  delimiter: Delimiter;
}

/**
 * RFC 4180: citerade fält med radbrytningar, avgränsare och dubbla citattecken. Tar bort BOM. CRLF, LF och CR godtas.
 * Alla celler trimmas. Tomma rader hoppas över.
 */
export function parseCsv(text: string, delimiter?: Delimiter): ParsedCsv {
  if (Buffer.byteLength(text, 'utf8') > CSV_LIMITS.maxBytes) throw new CsvError(`Filen är för stor (högst ${CSV_LIMITS.maxBytes / 1_000_000} MB)`);
  const body = text.replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(body);

  const records: Array<{ cells: string[]; row: number }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let row = 1;
  let recordRow = 1;

  const endCell = () => {
    cells.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0] === '')) {
      if (cells.length > CSV_LIMITS.maxColumns) throw new CsvError(`För många kolumner (högst ${CSV_LIMITS.maxColumns})`, recordRow);
      records.push({ cells, row: recordRow });
      if (records.length > CSV_LIMITS.maxRows + 1) throw new CsvError(`För många rader (högst ${CSV_LIMITS.maxRows})`, recordRow);
    }
    cells = [];
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') row++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      wasQuoted = true;
      cell = '';
    } else if (ch === sep) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      endRecord();
      row++;
      recordRow = row;
    } else {
      if (wasQuoted) {
        if (ch.trim() !== '') throw new CsvError('Text efter ett avslutande citattecken', row);
        continue; // mellanslag efter ett avslutande citattecken hör inte till fältet
      }
      cell += ch;
    }
  }
  if (quoted) throw new CsvError('Ett citerat fält är inte avslutat', recordRow);
  if (cell !== '' || cells.length > 0) endRecord();

  const [head, ...rest] = records;
  if (!head) throw new CsvError('Filen är tom');
  for (const r of rest) {
    if (r.cells.length !== head.cells.length) {
      throw new CsvError(`Raden har ${r.cells.length} kolumner men rubrikraden har ${head.cells.length}. Filen avvisas i stället för att läsas på gissning`, r.row);
    }
  }
  return { header: head.cells, rows: rest.map((r) => r.cells), rowNumbers: rest.map((r) => r.row), delimiter: sep };
}
