import { describe, expect, it } from 'vitest';
import { allocate } from '../src/domain/money.js';

describe('allocate', () => {
  it('summerar alltid exakt till total', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
    expect(allocate(0, [3, 7])).toEqual([0, 0]);
  });

  it('fördelar proportionellt', () => {
    expect(allocate(1000, [250, 750])).toEqual([250, 750]);
  });

  it('är deterministisk vid lika återstod', () => {
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
  });

  it('hanterar vikt noll', () => {
    expect(allocate(5, [0, 4])).toEqual([0, 5]);
  });

  it('klarar stora belopp utan precisionsförlust', () => {
    const total = 9_000_000_000_000;
    const parts = allocate(total, [3_000_000_000_001, 5_999_999_999_999]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('summerar exakt för många slumpade fall', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rand() * 1_000_000);
      const weights = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => 1 + Math.floor(rand() * 10_000));
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
  });

  it('avvisar ogiltig indata', () => {
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(1.5, [1])).toThrow();
    expect(() => allocate(1, [])).toThrow();
    expect(() => allocate(1, [0, 0])).toThrow();
    expect(() => allocate(1, [-1, 2])).toThrow();
  });
});
