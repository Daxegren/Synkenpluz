import type { Clock } from '../ports/index.js';

export interface RateLimiter {
  /** Löser sig när ett anrop får göras. Anropare släpps igenom i FIFO-ordning. */
  acquire(): Promise<void>;
}

export interface RateLimiterOptions {
  /** Genomsnittligt antal anrop per sekund. */
  perSecond: number;
  /** Största antalet anrop i en skur. Standard: perSecond avrundat uppåt, minst 1. */
  burst?: number | undefined;
  clock?: Clock | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultClock: Clock = { now: () => new Date() };
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Token bucket med rättvis kö. Hinken startar full. En enda pump-loop släpper igenom väntande i
 * ankomstordning, så många samtidiga acquire() kan inte köra om varandra.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { perSecond } = options;
  if (!Number.isFinite(perSecond) || perSecond <= 0) throw new RangeError('perSecond måste vara > 0');
  const burst = options.burst ?? Math.max(1, Math.ceil(perSecond));
  if (!Number.isFinite(burst) || burst < 1) throw new RangeError('burst måste vara >= 1');
  const clock = options.clock ?? defaultClock;
  const sleep = options.sleep ?? defaultSleep;

  let tokens = burst;
  let last = clock.now().getTime();
  const queue: Array<() => void> = [];
  let pumping = false;

  const refill = () => {
    const now = clock.now().getTime();
    if (now > last) tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now; // går klockan bakåt väntar vi bara in den
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        refill();
        if (tokens >= 1 - 1e-9) {
          tokens -= 1;
          queue.shift()!();
        } else {
          await sleep(Math.max(1, Math.ceil(((1 - tokens) / perSecond) * 1000)));
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    acquire() {
      return new Promise<void>((resolve) => {
        queue.push(resolve);
        void pump();
      });
    },
  };
}
