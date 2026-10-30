import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/http/rateLimiter.js';

function fake() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: { now: () => new Date(t) },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => void (t += ms),
    at: () => t,
  };
}

describe('createRateLimiter', () => {
  it('släpper igenom en skur direkt och sedan i jämn takt', async () => {
    const f = fake();
    const start = f.at();
    const rl = createRateLimiter({ perSecond: 2, burst: 3, clock: f.clock, sleep: f.sleep });
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      await rl.acquire();
      times.push(f.at() - start);
    }
    expect(times).toEqual([0, 0, 0, 500, 1000, 1500, 2000]);
  });

  it('är rättvis (FIFO) för många samtidiga anrop', async () => {
    const f = fake();
    const rl = createRateLimiter({ perSecond: 10, burst: 1, clock: f.clock, sleep: f.sleep });
    const order: number[] = [];
    const start = f.at();
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        rl.acquire().then(() => {
          order.push(i);
          stamps.push(f.at() - start);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 200 }, (_, i) => i));
    // 199 anrop efter det första, 100 ms emellan
    expect(stamps[199]).toBe(19_900);
  });

  it('fyller på hinken när klockan går men aldrig över burst', async () => {
    const f = fake();
    const rl = createRateLimiter({ perSecond: 1, burst: 2, clock: f.clock, sleep: f.sleep });
    await rl.acquire();
    await rl.acquire();
    f.advance(60_000);
    await rl.acquire();
    await rl.acquire();
    expect(f.sleeps).toEqual([]);
    await rl.acquire();
    expect(f.sleeps).toEqual([1000]);
  });

  it('väntar tills sleep löser sig (ingen förtida frigivning)', async () => {
    const f = fake();
    let release!: () => void;
    const rl = createRateLimiter({
      perSecond: 1,
      burst: 1,
      clock: f.clock,
      sleep: () => new Promise<void>((r) => (release = () => { f.advance(1000); r(); })),
    });
    await rl.acquire();
    let second = false;
    void rl.acquire().then(() => (second = true));
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(second).toBe(false);
    release();
    await new Promise((r) => setImmediate(r));
    expect(second).toBe(true);
  });

  it('avvisar ogiltiga inställningar', () => {
    expect(() => createRateLimiter({ perSecond: 0 })).toThrow();
    expect(() => createRateLimiter({ perSecond: NaN })).toThrow();
    expect(() => createRateLimiter({ perSecond: 1, burst: 0 })).toThrow();
  });
});
