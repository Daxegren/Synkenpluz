/**
 * Belopp och datum ur filer. Hellre ett avslag än en gissning: "1.234" kan vara ett tusen tvåhundra trettiofyra eller
 * ett komma tolv, och en bokföring ska aldrig bero på vilket vi råkade välja.
 */

const NBSP = /[  \s]/g;

/**
 * Belopp i kronor till öre, med punkt eller komma som decimaltecken och 0 till 2 decimaler. Tusentalsavgränsare
 * godtas inte (utom mellanslag), eftersom de inte går att skilja från decimaltecken. Med `minorUnits` är värdet redan i öre.
 */
export function parseAmount(raw: string, options: { minorUnits?: boolean } = {}): number {
  const value = raw.replace(NBSP, '');
  if (value === '') throw new RangeError('tomt belopp');
  if (options.minorUnits) {
    if (!/^-?\d+$/.test(value)) throw new RangeError(`"${raw}" är inget heltal i öre`);
    return finish(Number(value), raw);
  }
  const m = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!m) {
    throw new RangeError(
      `"${raw}" är inget giltigt belopp. Ange högst två decimaler med punkt eller komma, utan tusentalsavgränsare (annars går det inte att skilja från decimaltecken)`,
    );
  }
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return finish(m[1] === '-' ? -minor : minor, raw);
}

function finish(minor: number, raw: string): number {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`"${raw}" är för stort`);
  return minor === 0 ? 0 : minor; // aldrig -0
}

export type DateFormat = 'iso' | 'dmy';

/** Ett riktigt kalenderdatum till YYYY-MM-DD. Klockslag efter datumet (ISO) ignoreras. `dmy` är dag, månad, år med punkt, snedstreck eller bindestreck. */
export function parseDate(raw: string, format: DateFormat = 'iso'): string {
  const value = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  if (format === 'iso') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
    if (!m) throw new RangeError(`"${raw}" är inget datum (förväntade ÅÅÅÅ-MM-DD)`);
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value);
    if (!m) throw new RangeError(`"${raw}" är inget datum (förväntade DD.MM.ÅÅÅÅ)`);
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new RangeError(`"${raw}" är inget riktigt datum`);
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
