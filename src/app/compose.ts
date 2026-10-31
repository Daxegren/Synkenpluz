import { buildServer } from '../api/server.js';
import type { Db } from '../db/db.js';
import { collectMetrics, renderPrometheus } from '../db/metrics.js';
import { createOnboardingService } from '../db/onboarding.js';
import { createRepositories, createUnitOfWork } from '../db/repositories.js';
import type { LedgerProvider } from '../ports/ledger.js';
import { createSyncStateStore, createTenantConfigProvider, listSyncableTenants } from '../db/syncState.js';
import { createApiKeyRepository, createTenantRepository } from '../db/tenants.js';
import { GuardedLedgerGateway, type GuardedOptions } from '../gateways/guarded.js';
import type { LedgerGateway, Clock } from '../ports/index.js';
import type { InvoiceReader, PayoutSource } from '../ports/sources.js';
import type { RateLimitConfig } from '../api/rateLimit.js';
import { resolveWebRoot } from '../web/serve.js';
import { createDetailedAuthenticator } from '../security/apiKeys.js';
import { runCycle, silentLogger, type CycleDeps, type CycleReport, type Logger } from './cycle.js';
import { createAlertDispatcher, type AlertDispatcherOptions } from './notify.js';

export interface AppConfig {
  db: Db;
  clock: Clock;
  /** Server-pepper för API-nycklar, minst 32 byte, från secret manager. */
  apiKeyPepper: Buffer;
  /** Adaptrar mot betalleverantör och affärssystem. Se src/ports. */
  adapters: {
    source: PayoutSource;
    invoices: InvoiceReader;
    gateway: LedgerGateway;
    /** Beskriver affärssystemet (förmågor, anslutningstest) för onboarding. Utan den visas inga förmågor. */
    provider?: LedgerProvider;
  };
  logger?: Logger;
  /**
   * Skyddsgatewayen (GuardedLedgerGateway) är PÅ som standard: den förhindrar dubbelbokning även när
   * affärssystemet saknar egen idempotens. `false` stänger av den (bara för tester). `verify` låter
   * affärssystemet själv avgöra osäkra utfall.
   */
  guard?: false | { verify?: GuardedOptions['verify']; inFlightGraceMs?: number };
  /** Skickar larm från körcykeln (med dämpning). Utan den loggas larm bara. */
  alerts?: Pick<AlertDispatcherOptions, 'notifier' | 'repeatAfterMs'>;
  /** Bearer-token för GET /metrics. Utan den finns inte /metrics. */
  metricsToken?: string;
  rateLimit?: false | Partial<RateLimitConfig>;
  /** Sätt true bakom en proxy så att klientens IP läses ur X-Forwarded-For. */
  trustProxy?: boolean;
  /** Webbgränssnittet för granskning på `/app`. På som standard om `web/` hittas, `false` stänger av. */
  webUi?: false;
}

/**
 * Sätter ihop alla delar. Ingen I/O sker här: anroparen äger databasanslutningen, och
 * startar HTTP-servern (`app.server.listen`) och schemaläggaren (`app.runCycle`) själv.
 */
export function createApp(config: AppConfig) {
  const { db, clock } = config;
  const repos = createRepositories(db);
  const uow = createUnitOfWork(db);
  const tenants = createTenantRepository(db);
  const apiKeys = createApiKeyRepository(db);
  const authenticateDetailed = createDetailedAuthenticator({ store: apiKeys, pepper: config.apiKeyPepper, clock });

  const webRoot = config.webUi === false ? null : resolveWebRoot();
  const guardOptions = config.guard === false ? null : (config.guard ?? {});
  const gateway: LedgerGateway = guardOptions
    ? new GuardedLedgerGateway(config.adapters.gateway, repos.guard, {
        clock,
        verify: guardOptions.verify,
        inFlightGraceMs: guardOptions.inFlightGraceMs,
      })
    : config.adapters.gateway;

  const server = buildServer({
    exceptions: repos.exceptions,
    payouts: repos.payouts,
    commands: repos.commands,
    authenticate: async (key) => (await authenticateDetailed(key))?.tenantId ?? null,
    authenticateDetailed,
    clock,
    audit: repos.audit,
    uow,
    proposals: repos.proposals,
    guard: repos.guard,
    guardForUow: (r) => r.guard,
    onboarding: createOnboardingService(db, clock, config.adapters.provider),
    ping: async () => {
      await db.query('select 1');
    },
    metrics: async () => renderPrometheus(await collectMetrics(db, clock.now())),
    ...(config.metricsToken ? { metricsToken: config.metricsToken } : {}),
    ...(config.rateLimit !== undefined ? { rateLimit: config.rateLimit } : {}),
    ...(config.trustProxy !== undefined ? { trustProxy: config.trustProxy } : {}),
    ...(webRoot ? { webRoot } : {}),
  });

  const cycleDeps: CycleDeps = {
    executor: {
      commands: repos.commands,
      gateway,
      clock,
      // Ett dött kommando gör utbetalningen ofullständig, även om den tidigare var klar.
      onDead: async (command, reason) => {
        const now = clock.now();
        await uow.run(async (r) => {
          await r.payouts.record({ tenantId: command.tenantId, payoutId: command.payoutId, status: 'partial', processedAt: now });
          await r.audit.append(
            {
              tenantId: command.tenantId,
              actor: 'system',
              action: 'command.dead',
              details: { commandId: command.id, payoutId: command.payoutId, kind: command.command.kind, reason: reason.slice(0, 200) },
            },
            now,
          );
        });
      },
    },
    sync: {
      uow,
      clock,
      source: config.adapters.source,
      invoices: config.adapters.invoices,
      config: createTenantConfigProvider(db),
      state: createSyncStateStore(db, clock),
    },
    listTenants: () => listSyncableTenants(db),
    logger: config.logger ?? silentLogger,
  };

  const dispatcher = config.alerts
    ? createAlertDispatcher({ ...config.alerts, clock, logger: config.logger ?? silentLogger })
    : null;

  return {
    server,
    repos,
    tenants,
    apiKeys,
    /** Skyddsgatewayen som utföraren använder (eller adaptern själv om skyddet är avstängt). */
    gateway,
    /** En körcykel: synka alla kunder och kör kön. Skickar larm om en larmmottagare är konfigurerad. */
    runCycle: async (): Promise<CycleReport> => {
      const report = await runCycle(cycleDeps);
      if (dispatcher) await dispatcher.dispatch(report.alerts);
      return report;
    },
  };
}

export type App = ReturnType<typeof createApp>;
