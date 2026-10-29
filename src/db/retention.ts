import { createHash } from 'node:crypto';
import type { StoredProposal } from '../ports/index.js';
import type { Db } from './db.js';

/**
 * Gallring (dataminimering). Tar bort data som inte längre behövs, och bara sådant som är helt klart.
 *
 * Vad som gallras (allt jämförs strikt "äldre än gränsen", dvs. tidpunkt < now - N dagar; en rad som är
 * exakt N dagar gammal sparas):
 *
 *  1. ledger_command: ett kommando tas bara bort tillsammans med HELA sin utbetalning, och bara om
 *     - ALLA kommandon i utbetalningen (tenant_id, payout_id) har status 'succeeded'. Finns ett enda
 *       pending/in_progress/failed/dead kommando bevaras hela utbetalningens kommandon.
 *     - det SENASTE kommandots updated_at i utbetalningen är äldre än gränsen (hela utbetalningen är
 *       alltså gammal, inte bara det äldsta kommandot).
 *     - utbetalningen har en payout-rad med status 'complete' och processed_at äldre än gränsen.
 *       Partial/rejected hämtas om av syncTenant, och då skulle borttagna kommandon räknas som "ej
 *       köade" och bokföras en gång till. Saknas payout-raden gallras inget.
 *     - utbetalningen saknar öppna avvikelser (reconcile_exception med status 'open').
 *  2. reconcile_exception: bara status 'resolved' eller 'dismissed' och coalesce(resolved_at, created_at)
 *     äldre än gränsen. Öppna avvikelser tas aldrig bort.
 *  3. dry_run_proposal: updated_at äldre än gränsen.
 *  4. gateway_guard: bara state 'done' med coalesce(completed_at, started_at) äldre än gränsen, och bara
 *     om det inte finns ett kommando med samma nyckel som inte är 'succeeded' (annars kunde en
 *     krasch mellan 'done' och markSucceeded ge ett nytt anrop utan skydd). 'started' (osäkert utfall)
 *     tas ALDRIG bort.
 *
 * Rörs aldrig: audit_log (append-only, triggers blockerar) och payout-raderna (statusrader).
 * Revisionsposten (retention.applied) innehåller bara antal och policy, inga personuppgifter.
 *
 * Kvarstående: efter gallring finns inget kommando kvar som visar att en utbetalning bokförts, bara
 * payout-raden och revisionsloggen. Bokföringslagen (normalt sju år) måste vägas mot gränsvärdena
 * innan policyn sänks; därför är minimum 30 dagar och default 400.
 */
export interface RetentionPolicy {
  succeededCommandsDays: number;
  resolvedExceptionsDays: number;
  proposalsDays: number;
  guardDoneDays: number;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = Object.freeze({
  succeededCommandsDays: 400,
  resolvedExceptionsDays: 400,
  proposalsDays: 90,
  guardDoneDays: 400,
});

const MIN_BOOKKEEPING_DAYS = 30;
const MIN_PROPOSAL_DAYS = 1;
const MAX_DAYS = 36_500;

export class RetentionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionPolicyError';
  }
}

const POLICY_FIELDS: ReadonlyArray<{ key: keyof RetentionPolicy; label: string; min: number }> = [
  { key: 'succeededCommandsDays', label: 'lyckade kommandon', min: MIN_BOOKKEEPING_DAYS },
  { key: 'resolvedExceptionsDays', label: 'avslutade avvikelser', min: MIN_BOOKKEEPING_DAYS },
  { key: 'proposalsDays', label: 'dry_run-förslag', min: MIN_PROPOSAL_DAYS },
  { key: 'guardDoneDays', label: 'klara gateway-poster', min: MIN_BOOKKEEPING_DAYS },
];

/** Slår ihop med defaults och validerar. Kastar RetentionPolicyError (svenskt meddelande) vid ogiltigt värde. */
export function resolveRetentionPolicy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY, ...stripUndefined(overrides) };
  for (const field of POLICY_FIELDS) {
    const value: unknown = policy[field.key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new RetentionPolicyError(`Gallringstid för ${field.label} måste vara ett heltal antal dagar`);
    }
    if (value < field.min) {
      throw new RetentionPolicyError(`Gallringstid för ${field.label} måste vara minst ${field.min} dagar`);
    }
    if (value > MAX_DAYS) {
      throw new RetentionPolicyError(`Gallringstid för ${field.label} får vara högst ${MAX_DAYS} dagar`);
    }
  }
  return policy;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface RetentionCounts {
  commands: number;
  exceptions: number;
  proposals: number;
  guards: number;
}

export interface RetentionResult extends RetentionCounts {
  byTenant: Record<string, RetentionCounts>;
}

const emptyCounts = (): RetentionCounts => ({ commands: 0, exceptions: 0, proposals: 0, guards: 0 });

const cutoffOf = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000);

// Utbetalningar vars kommandon får gallras (regel 1). $1 = gräns.
const ELIGIBLE_PAYOUTS = `
  eligible as (
    select c.tenant_id, c.payout_id
      from ledger_command c
     group by c.tenant_id, c.payout_id
    having bool_and(c.status = 'succeeded') and max(c.updated_at) < $1::timestamptz
       and exists (select 1 from payout p
                    where p.tenant_id = c.tenant_id and p.payout_id = c.payout_id
                      and p.status = 'complete' and p.processed_at < $1::timestamptz)
       and not exists (select 1 from reconcile_exception x
                        where x.tenant_id = c.tenant_id and x.payout_id = c.payout_id and x.status = 'open')
  )`;

const COMMAND_SELECT = `with ${ELIGIBLE_PAYOUTS}
  select c.tenant_id from ledger_command c
    join eligible e on e.tenant_id = c.tenant_id and e.payout_id = c.payout_id`;
const COMMAND_DELETE = `with ${ELIGIBLE_PAYOUTS}
  delete from ledger_command c using eligible e
   where e.tenant_id = c.tenant_id and e.payout_id = c.payout_id
  returning c.tenant_id`;

const EXCEPTION_WHERE = `status in ('resolved','dismissed') and coalesce(resolved_at, created_at) < $1::timestamptz`;
const PROPOSAL_WHERE = `updated_at < $1::timestamptz`;
const GUARD_WHERE = `state = 'done' and coalesce(completed_at, started_at) < $1::timestamptz
  and not exists (select 1 from ledger_command lc
                   where lc.tenant_id = gateway_guard.tenant_id and lc.key = gateway_guard.key
                     and lc.status <> 'succeeded')`;

interface Step {
  field: keyof RetentionCounts;
  days: keyof RetentionPolicy;
  select: string;
  delete: string;
}

const STEPS: readonly Step[] = [
  { field: 'commands', days: 'succeededCommandsDays', select: COMMAND_SELECT, delete: COMMAND_DELETE },
  {
    field: 'exceptions',
    days: 'resolvedExceptionsDays',
    select: `select tenant_id from reconcile_exception where ${EXCEPTION_WHERE}`,
    delete: `delete from reconcile_exception where ${EXCEPTION_WHERE} returning tenant_id`,
  },
  {
    field: 'proposals',
    days: 'proposalsDays',
    select: `select tenant_id from dry_run_proposal where ${PROPOSAL_WHERE}`,
    delete: `delete from dry_run_proposal where ${PROPOSAL_WHERE} returning tenant_id`,
  },
  {
    field: 'guards',
    days: 'guardDoneDays',
    select: `select tenant_id from gateway_guard where ${GUARD_WHERE}`,
    delete: `delete from gateway_guard where ${GUARD_WHERE} returning tenant_id`,
  },
];

async function run(db: Db, policy: RetentionPolicy, now: Date, mode: 'select' | 'delete'): Promise<RetentionResult> {
  const result: RetentionResult = { ...emptyCounts(), byTenant: {} };
  for (const step of STEPS) {
    const rows = await db.query<{ tenant_id: string }>(step[mode], [cutoffOf(now, policy[step.days])]);
    result[step.field] += rows.length;
    for (const row of rows) {
      (result.byTenant[row.tenant_id] ??= emptyCounts())[step.field]++;
    }
  }
  return result;
}

/** Torrkörning: räknar bara (select), ändrar ingenting. Räknar exakt det applyRetention skulle ta bort. */
export async function planRetention(db: Db, policy: RetentionPolicy, now: Date): Promise<RetentionResult> {
  const valid = resolveRetentionPolicy(policy);
  return db.transaction((tx) => run(tx, valid, now, 'select'));
}

/** Gallrar i en transaktion och skriver en revisionspost per berörd kund. Idempotent. */
export async function applyRetention(db: Db, policy: RetentionPolicy, now: Date, actor = 'retention'): Promise<RetentionResult> {
  const valid = resolveRetentionPolicy(policy);
  return db.transaction(async (tx) => {
    const result = await run(tx, valid, now, 'delete');
    for (const [tenantId, counts] of Object.entries(result.byTenant)) {
      await tx.query(
        'insert into audit_log (tenant_id, at, actor, action, details) values ($1, $2, $3, $4, $5::jsonb)',
        [tenantId, now, actor, 'retention.applied', JSON.stringify({ removed: counts, policy: valid })],
      );
    }
    return result;
  });
}

// ---- Hjälpfunktioner för adminverktyget (rena, testbara utan databas) ----

const FLAGS: Record<string, keyof RetentionPolicy> = {
  '--succeeded-days': 'succeededCommandsDays',
  '--exceptions-days': 'resolvedExceptionsDays',
  '--proposals-days': 'proposalsDays',
  '--guard-days': 'guardDoneDays',
};

/** Tolkar flaggor till policy. Okänd flagga, saknat eller icke-numeriskt värde ger RetentionPolicyError. */
export function parseRetentionArgs(args: readonly string[]): { policy: RetentionPolicy; yes: boolean } {
  const overrides: Partial<RetentionPolicy> = {};
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    const field = FLAGS[arg];
    if (!field) throw new RetentionPolicyError('Okänd flagga. Giltiga: --succeeded-days, --exceptions-days, --proposals-days, --guard-days, --yes');
    const raw = args[++i];
    if (raw === undefined || !/^\d+$/.test(raw)) throw new RetentionPolicyError(`Flaggan ${arg} kräver ett heltal antal dagar`);
    overrides[field] = Number(raw);
  }
  return { policy: resolveRetentionPolicy(overrides), yes };
}

export function formatRetentionResult(result: RetentionResult, heading: string): string {
  const lines = [
    heading,
    `  kommandon (lyckade, hela utbetalningar): ${result.commands}`,
    `  avvikelser (avslutade): ${result.exceptions}`,
    `  dry_run-förslag: ${result.proposals}`,
    `  klara gateway-poster: ${result.guards}`,
  ];
  return lines.join('\n');
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} dygn`;
}

/** Kort, icke-reversibel markör för en idempotensnyckel (nyckeln kan innehålla utbetalnings- och rad-id). */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export type InDoubtDecision = { applied: true; externalId: string } | { applied: false };

/** Tolkar `<applied|not-applied> [externalId]`. applied kräver externalId; not-applied får inte ha något. */
export function parseInDoubtDecision(outcome: string | undefined, externalId: string | undefined): InDoubtDecision {
  if (outcome === 'applied') {
    if (!externalId || externalId.trim() === '') {
      throw new Error('applied kräver externalId (verifikat-/fakturaid i affärssystemet)');
    }
    return { applied: true, externalId };
  }
  if (outcome === 'not-applied') {
    if (externalId !== undefined) throw new Error('not-applied tar inget externalId');
    return { applied: false };
  }
  throw new Error('Utfall måste vara applied eller not-applied');
}

export interface ProposalSummary {
  payoutId: string;
  status: string;
  commands: number;
  exceptionCodes: string[];
  updatedAt: Date;
}

/** Sammanfattning av ett dry_run-förslag utan belopp, referenser eller meddelandetexter. */
export function summarizeProposal(p: StoredProposal): ProposalSummary {
  const counts = new Map<string, number>();
  for (const e of p.result.exceptions) counts.set(e.code, (counts.get(e.code) ?? 0) + 1);
  return {
    payoutId: p.payoutId,
    status: p.status,
    commands: p.result.commands.length,
    exceptionCodes: [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, n]) => (n > 1 ? `${code}x${n}` : code)),
    updatedAt: p.updatedAt,
  };
}
