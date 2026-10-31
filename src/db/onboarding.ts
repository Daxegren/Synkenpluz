import type { Clock } from '../ports/index.js';
import type { ConnectionCheck, LedgerProvider } from '../ports/ledger.js';
import { describeCapabilities, evaluateOnboarding, type OnboardingFacts, type OnboardingStatus } from '../service/onboarding.js';
import type { Db } from './db.js';
import { createAuditLog } from './repositories.js';
import { accountMappingSchema } from './syncState.js';

const MAX_PROBLEMS = 10;
const MAX_PROBLEM_LENGTH = 200;
const CHECK_TIMEOUT_MS = 15_000;

export interface OnboardingView extends OnboardingStatus {
  /** Finns bara när en leverantör av affärssystem är kopplad till tjänsten. */
  ledger?: { provider: string; capabilities: LedgerProvider['capabilities']; notes: string[] };
}

export type GoLiveOutcome =
  | { result: 'ok' }
  | { result: 'not_found' }
  | { result: 'already_live' }
  | { result: 'not_ready'; blockers: OnboardingStatus['blockers'] }
  /** Antalet förslag är ett annat än det godkännaren såg. Granskningen måste göras om. */
  | { result: 'stale_review'; proposalCount: number };

export interface OnboardingService {
  /** Null om kunden inte finns. */
  status(tenantId: string): Promise<OnboardingView | null>;
  /**
   * Godkänner att kunden går från dry_run till live. Allt förslag som granskats bokförs då på riktigt, eftersom
   * cursorn inte flyttats i dry_run. `approvedProposalCount` är antalet förslag godkännaren såg: ändras det
   * i mellantiden (nya förslag kom in) vägras godkännandet. Mode och revisionspost skrivs atomiskt.
   */
  goLive(tenantId: string, input: { approvedProposalCount: number }, actor: string): Promise<GoLiveOutcome>;
  /** Null om ingen leverantör är kopplad. Skriver aldrig något i affärssystemet. */
  checkConnection(tenantId: string): Promise<ConnectionCheck | null>;
}

async function gatherFacts(db: Db, tenantId: string, now: Date, lock = false): Promise<OnboardingFacts | null> {
  const tenants = await db.query<{ status: 'active' | 'suspended'; mode: 'dry_run' | 'live'; accounts: unknown }>(
    `select status, mode, accounts from tenant where id = $1${lock ? ' for update' : ''}`,
    [tenantId],
  );
  const tenant = tenants[0];
  if (!tenant) return null;

  // Sekventiellt: en transaktion har en enda anslutning, och pg tillåter inte parallella frågor på den.
  const keys = await db.query<{ n: string }>(
    `select count(*) as n from api_key where tenant_id = $1 and revoked_at is null and (expires_at is null or expires_at > $2)`,
    [tenantId, now],
  );
  const connections = await db.query<{ provider: string }>(`select provider from connection where tenant_id = $1 and status = 'active'`, [tenantId]);
  const proposals = await db.query<{ n: string; with_exceptions: string }>(
    `select count(*) as n, count(*) filter (where jsonb_array_length(result->'exceptions') > 0) as with_exceptions
       from dry_run_proposal where tenant_id = $1`,
    [tenantId],
  );
  const payouts = await db.query<{ n: string }>('select count(*) as n from payout where tenant_id = $1', [tenantId]);
  const inDoubt = await db.query<{ n: string }>(`select count(*) as n from gateway_guard where tenant_id = $1 and state = 'started'`, [tenantId]);

  const num = (rows: Array<Record<string, string>>, key: string): number => Number(rows[0]?.[key] ?? 0);
  return {
    tenantStatus: tenant.status,
    mode: tenant.mode,
    accountsValid: tenant.accounts != null && accountMappingSchema.safeParse(tenant.accounts).success,
    activeKeys: num(keys, 'n'),
    activeProviders: connections.map((c) => c.provider),
    proposalCount: num(proposals, 'n'),
    proposalsWithExceptions: num(proposals, 'with_exceptions'),
    payoutCount: num(payouts, 'n'),
    inDoubtCount: num(inDoubt, 'n'),
  };
}

export function createOnboardingService(db: Db, clock: Clock, provider?: LedgerProvider): OnboardingService {
  return {
    async status(tenantId) {
      const facts = await gatherFacts(db, tenantId, clock.now());
      if (!facts) return null;
      const status: OnboardingView = evaluateOnboarding(facts);
      if (provider) {
        status.ledger = { provider: provider.provider, capabilities: provider.capabilities, notes: describeCapabilities(provider.capabilities) };
      }
      return status;
    },

    async goLive(tenantId, input, actor) {
      const now = clock.now();
      return db.transaction(async (tx): Promise<GoLiveOutcome> => {
        // Raden låses så att två godkännanden samtidigt inte båda går igenom.
        const facts = await gatherFacts(tx, tenantId, now, true);
        if (!facts) return { result: 'not_found' };
        if (facts.mode === 'live') return { result: 'already_live' };

        const status = evaluateOnboarding(facts);
        if (status.blockers.length > 0) return { result: 'not_ready', blockers: status.blockers };
        if (facts.proposalCount !== input.approvedProposalCount) return { result: 'stale_review', proposalCount: facts.proposalCount };

        await tx.query(`update tenant set mode = 'live' where id = $1`, [tenantId]);
        await createAuditLog(tx).append(
          {
            tenantId,
            actor,
            action: 'tenant.go_live',
            details: { approvedProposalCount: input.approvedProposalCount, proposalsWithExceptions: facts.proposalsWithExceptions },
          },
          now,
        );
        return { result: 'ok' };
      });
    },

    async checkConnection(tenantId) {
      if (!provider) return null;
      let timer: NodeJS.Timeout | undefined;
      try {
        const check = await Promise.race([
          provider.checkConnection(tenantId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        return {
          ok: check.ok === true,
          problems: check.problems.slice(0, MAX_PROBLEMS).map((p) => String(p).slice(0, MAX_PROBLEM_LENGTH)),
        };
      } catch {
        // Orsaken lämnas inte ut: den kan innehålla svar eller uppgifter från leverantören.
        return { ok: false, problems: ['Anslutningstestet kunde inte genomföras'] };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
