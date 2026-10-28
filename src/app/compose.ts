import { buildServer } from '../api/server.js';
import type { Db } from '../db/db.js';
import { createRepositories, createUnitOfWork } from '../db/repositories.js';
import { createSyncStateStore, createTenantConfigProvider, listSyncableTenants } from '../db/syncState.js';
import { createApiKeyRepository, createTenantRepository } from '../db/tenants.js';
import type { LedgerGateway, Clock } from '../ports/index.js';
import type { InvoiceReader, PayoutSource } from '../ports/sources.js';
import { createAuthenticator } from '../security/apiKeys.js';
import { runCycle, silentLogger, type CycleDeps, type CycleReport, type Logger } from './cycle.js';

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
  };
  logger?: Logger;
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

  const server = buildServer({
    exceptions: repos.exceptions,
    payouts: repos.payouts,
    commands: repos.commands,
    authenticate: createAuthenticator({ store: apiKeys, pepper: config.apiKeyPepper, clock }),
    clock,
    audit: repos.audit,
    uow,
  });

  const cycleDeps: CycleDeps = {
    executor: {
      commands: repos.commands,
      gateway: config.adapters.gateway,
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

  return {
    server,
    repos,
    tenants,
    apiKeys,
    /** En körcykel: synka alla kunder och kör kön. Anropas av en schemaläggare. */
    runCycle: (): Promise<CycleReport> => runCycle(cycleDeps),
  };
}

export type App = ReturnType<typeof createApp>;
