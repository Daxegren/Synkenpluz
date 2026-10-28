import type { LedgerCommand, ReconcileException, ExceptionCode } from '../domain/types.js';

/**
 * Gränssnitt (ports) mellan kärnan och omvärlden. Implementationer lever i
 * src/db (Postgres), src/gateways (Fortnox m.fl.) och src/api (HTTP).
 * Kärnan och tjänstelagret beror bara på dessa typer.
 */

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------- kommandokö

export type CommandStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'dead';

export interface StoredCommand {
  id: string;
  tenantId: string;
  payoutId: string;
  /** Idempotensnyckel, unik per kommando. */
  key: string;
  command: LedgerCommand;
  status: CommandStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  /** Id i affärssystemet när kommandot lyckats. */
  externalId: string | null;
}

export interface CommandRepository {
  /**
   * Lägger kommandon i kön. Idempotent: ett kommando vars nyckel redan finns
   * läggs inte till igen. Returnerar hur många som faktiskt lades till.
   */
  enqueue(tenantId: string, payoutId: string, commands: readonly LedgerCommand[], now: Date): Promise<number>;

  /** Hämtar och låser upp till `limit` kommandon som är redo att köras. */
  claimDue(now: Date, limit: number): Promise<StoredCommand[]>;

  markSucceeded(id: string, externalId: string, now: Date): Promise<void>;

  /** Misslyckad körning. `retryAt` null betyder permanent fel (status 'dead'). */
  markFailed(id: string, error: string, retryAt: Date | null, now: Date): Promise<void>;

  /** Återställer kommandon som fastnat i 'in_progress' (t.ex. efter krasch). */
  releaseStale(olderThan: Date, now: Date): Promise<number>;

  listByPayout(tenantId: string, payoutId: string): Promise<StoredCommand[]>;
}

// ---------------------------------------------------------------- avvikelser

export type ExceptionStatus = 'open' | 'resolved' | 'dismissed';

export interface StoredException {
  id: string;
  tenantId: string;
  payoutId: string;
  code: ExceptionCode;
  lineId: string | null;
  message: string;
  status: ExceptionStatus;
  /** Fritext från den som hanterade avvikelsen. */
  resolutionNote: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ExceptionRepository {
  /** Idempotent per (tenant, payout, code, lineId): samma avvikelse läggs inte in två gånger. */
  add(tenantId: string, payoutId: string, exceptions: readonly ReconcileException[], now: Date): Promise<number>;

  list(tenantId: string, filter?: { status?: ExceptionStatus; payoutId?: string }): Promise<StoredException[]>;

  get(tenantId: string, id: string): Promise<StoredException | null>;

  /** Returnerar false om avvikelsen inte fanns eller inte var öppen. */
  resolve(
    tenantId: string,
    id: string,
    outcome: { status: 'resolved' | 'dismissed'; note: string },
    now: Date,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------- utbetalningar

export type PayoutStatus = 'rejected' | 'partial' | 'complete';

export interface PayoutRecord {
  tenantId: string;
  payoutId: string;
  status: PayoutStatus;
  processedAt: Date;
}

export interface PayoutRepository {
  /** Sparar senaste avstämningsresultat för utbetalningen (skriver över tidigare körning). */
  record(entry: PayoutRecord): Promise<void>;
  get(tenantId: string, payoutId: string): Promise<PayoutRecord | null>;
  list(tenantId: string, filter?: { status?: PayoutStatus }): Promise<PayoutRecord[]>;
}

// ---------------------------------------------------------------- affärssystem

/** Fel från affärssystemet. `retryable` styr om kommandot försöks igen. */
export class LedgerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Tidigast när ett nytt försök är lämpligt (t.ex. från Retry-After). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Utför ett bokföringskommando i kundens affärssystem. Implementationen ansvarar
 * för autentisering, rate limiting och översättning till leverantörens API.
 * Måste kasta LedgerError vid fel så att utföraren vet om det går att försöka igen.
 */
export interface LedgerGateway {
  execute(tenantId: string, command: LedgerCommand): Promise<{ externalId: string }>;
}
