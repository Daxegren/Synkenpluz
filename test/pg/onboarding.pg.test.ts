import { afterEach, describe, expect, it } from 'vitest';
import { createOnboardingService } from '../../src/db/onboarding.js';
import { migrate } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { setTenantAccounts } from '../../src/db/syncState.js';
import { createApiKeyRepository, createTenantRepository } from '../../src/db/tenants.js';
import { processPayout } from '../../src/service/processPayout.js';
import { createUnitOfWork } from '../../src/db/repositories.js';
import { TestClock, accounts, makeInvoice, makePayout, payment } from '../helpers.js';
import type { DbHandle } from './contract.js';
import { createSchemaDb, PG_URL } from './support.js';

/** Onboardingens SQL (count(*) filter, jsonb_array_length, for update) mot riktig Postgres. Kräver PG_TEST_URL. */
describe.skipIf(!PG_URL)('Postgres: onboarding', () => {
  const open: DbHandle[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  it('beräknar status och godkänner go-live exakt en gång vid två samtidiga godkännanden', async () => {
    const handle = await createSchemaDb();
    open.push(handle);
    const { db } = handle;
    await migrate(db);
    const clock = new TestClock();
    await createTenantRepository(db).create({ id: 'T1', name: 'Kund' }, clock.now());
    await setTenantAccounts(db, 'T1', accounts);
    await createApiKeyRepository(db).issue('T1', {}, clock.now(), Buffer.alloc(32, 1));
    for (const provider of ['mondido', 'fortnox']) {
      await db.query(
        `insert into connection (id, tenant_id, provider, encrypted_credentials, key_id, created_at, updated_at) values ($1, 'T1', $2, 'x', 'k1', $3, $3)`,
        [`c-${provider}`, provider, clock.now()],
      );
    }
    const service = createOnboardingService(db, clock);
    expect((await service.status('T1'))?.blockers).toEqual(['dry_run']);

    const uow = createUnitOfWork(db);
    const run = (id: string, ref: string) =>
      processPayout(
        { uow, clock },
        { tenantId: 'T1', payout: makePayout(id, [payment('L1', ref, 12500)]), invoices: [makeInvoice('A')], accounts },
        { mode: 'dry_run' },
      );
    await run('P1', 'REF-A');
    await run('P2', 'REF-SAKNAS');
    expect(await service.status('T1')).toMatchObject({ phase: 'review', proposals: { count: 2, withExceptions: 1 } });

    const results = await Promise.all([
      service.goLive('T1', { approvedProposalCount: 2 }, 'api:a'),
      service.goLive('T1', { approvedProposalCount: 2 }, 'api:b'),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(['already_live', 'ok']);
    expect(await createRepositories(db).audit.list('T1')).toHaveLength(1);
  });
});
