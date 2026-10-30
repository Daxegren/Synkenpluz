/** Belopp lagras alltid som heltal i minsta enhet (t.ex. öre). Aldrig flyttal. */
export type Minor = number;

export function assertMinor(value: number, label = 'belopp'): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} måste vara ett heltal i minsta enhet, fick ${value}`);
  }
}

/** Addition som kastar om resultatet inte längre är ett säkert heltal (ingen tyst avrundning). */
export function checkedAdd(a: Minor, b: Minor): Minor {
  const sum = a + b;
  assertMinor(sum, 'summa');
  return sum;
}

/**
 * Fördelar `total` proportionellt mot `weights` så att summan av delarna alltid
 * blir exakt `total` (största-återstoden-metoden). Används t.ex. för att dela upp
 * en delåterbetalning på moms och netto utan avrundningsdrift.
 */
export function allocate(total: Minor, weights: readonly Minor[]): Minor[] {
  assertMinor(total, 'total');
  if (total < 0) throw new RangeError('total får inte vara negativ');
  if (weights.length === 0) throw new RangeError('minst en vikt krävs');
  weights.forEach((w) => {
    assertMinor(w, 'vikt');
    if (w < 0) throw new RangeError('vikter får inte vara negativa');
  });

  // BigInt internt: total * vikt kan överstiga 2^53 för stora belopp.
  const sumWeights = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sumWeights === 0n) throw new RangeError('summan av vikter måste vara större än noll');

  const bigTotal = BigInt(total);
  const shares = weights.map((w, index) => {
    const product = bigTotal * BigInt(w);
    return { index, base: product / sumWeights, remainder: product % sumWeights };
  });

  let leftover = bigTotal - shares.reduce((a, s) => a + s.base, 0n);
  // Störst återstod först. Vid lika återstod vinner lägst index, så resultatet är deterministiskt.
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  const result = shares.map((s) => s.base);
  for (const s of byRemainder) {
    if (leftover === 0n) break;
    result[s.index] = (result[s.index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return result.map((r) => Number(r));
}
