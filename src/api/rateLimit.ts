/**
 * Enkel token bucket utan beroenden. Varje nyckel (API-nyckel-id, IP-adress) har en hink som fylls på
 * med `refillPerSec` tokens per sekund upp till `capacity`. Ett anrop kostar en token.
 *
 * Minnet är begränsat på två sätt: hinkar som hunnit fyllas helt är identiska med nya hinkar och
 * kasseras vid periodisk städning, och antalet hinkar har ett tak (`maxBuckets`) där de som använts
 * längst tillbaka tas bort först. Klockan injiceras så att tester blir deterministiska.
 */

export interface BucketConfig {
  /** Största antal tokens (= största skur). */
  capacity: number;
  /** Påfyllning per sekund. */
  refillPerSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Hela sekunder tills nästa token finns (minst 1 när allowed är false, annars 0). */
  retryAfterSec: number;
}

export interface RateLimiterOptions extends BucketConfig {
  /** Millisekunder. Standard Date.now. */
  now?: () => number;
  /** Tak för antalet samtidiga hinkar. Standard 10 000. */
  maxBuckets?: number;
  /** Hur ofta (ms) fulla hinkar städas bort. Standard 60 000. */
  sweepIntervalMs?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>(); // insättningsordning = senast använd sist
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly maxBuckets: number;
  private readonly sweepIntervalMs: number;
  private lastSweep: number;

  constructor(options: RateLimiterOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerSec > 0)) {
      throw new Error('RateLimiter: capacity måste vara minst 1 och refillPerSec större än 0');
    }
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
    this.now = options.now ?? Date.now;
    this.maxBuckets = Math.max(1, options.maxBuckets ?? 10_000);
    this.sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? 60_000);
    this.lastSweep = this.now();
  }

  /** Antal hinkar just nu (för tester och mätning). */
  get size(): number {
    return this.buckets.size;
  }

  /** Förbrukar en token om det finns någon. */
  take(key: string): RateLimitDecision {
    const t = this.now();
    this.sweep(t);
    const bucket = this.refilled(key, t);
    // Flytta sist (senast använd).
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.evict();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    return { allowed: false, retryAfterSec: this.retryAfter(bucket) };
  }

  /** Som take men förbrukar ingenting och skapar ingen hink: svarar om ett anrop skulle släppas igenom nu. */
  peek(key: string): RateLimitDecision {
    const existing = this.buckets.get(key);
    if (!existing) return { allowed: true, retryAfterSec: 0 };
    const bucket = this.refilled(key, this.now());
    return bucket.tokens >= 1 ? { allowed: true, retryAfterSec: 0 } : { allowed: false, retryAfterSec: this.retryAfter(bucket) };
  }

  private refilled(key: string, t: number): Bucket {
    const existing = this.buckets.get(key);
    if (!existing) return { tokens: this.capacity, updatedAt: t };
    const elapsedSec = Math.max(0, t - existing.updatedAt) / 1000;
    return { tokens: Math.min(this.capacity, existing.tokens + elapsedSec * this.refillPerSec), updatedAt: t };
  }

  private retryAfter(bucket: Bucket): number {
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSec));
  }

  private evict(): void {
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = t;
    for (const [key, bucket] of this.buckets) {
      const tokens = Math.min(this.capacity, bucket.tokens + (Math.max(0, t - bucket.updatedAt) / 1000) * this.refillPerSec);
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

export interface RateLimitConfig {
  /** Per API-nyckel (autentiserade anrop). */
  perKey: BucketConfig;
  /** Per IP för misslyckade autentiseringar. När den är tom nekas även giltiga nycklar från IP:n inte, men ogiltiga försök stoppas. */
  perIpAuthFailure: BucketConfig;
  /** Per IP för öppna rutter (/ready, /metrics, okända sökvägar). */
  perIpAnonymous: BucketConfig;
  maxBuckets: number;
}

export const defaultRateLimitConfig: RateLimitConfig = {
  perKey: { capacity: 60, refillPerSec: 10 },
  perIpAuthFailure: { capacity: 10, refillPerSec: 0.2 },
  perIpAnonymous: { capacity: 60, refillPerSec: 5 },
  maxBuckets: 10_000,
};

/** Slår ihop delvis angiven konfiguration med standardvärdena. */
export function resolveRateLimitConfig(partial?: {
  perKey?: BucketConfig;
  perIpAuthFailure?: BucketConfig;
  perIpAnonymous?: BucketConfig;
  maxBuckets?: number;
}): RateLimitConfig {
  return {
    perKey: partial?.perKey ?? defaultRateLimitConfig.perKey,
    perIpAuthFailure: partial?.perIpAuthFailure ?? defaultRateLimitConfig.perIpAuthFailure,
    perIpAnonymous: partial?.perIpAnonymous ?? defaultRateLimitConfig.perIpAnonymous,
    maxBuckets: partial?.maxBuckets ?? defaultRateLimitConfig.maxBuckets,
  };
}
