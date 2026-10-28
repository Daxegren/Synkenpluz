import { describe, expect, it } from 'vitest';
import { createTenantRepository } from '../../src/db/tenants.js';
import {
  createSyncStateStore,
  createTenantConfigProvider,
  listSyncableTenants,
  setTenantAccounts,
} from '../../src/db/syncState.js';
import { accounts, createTestStack } from '../helpers.js';

async function setup() {
  const stack = await createTestStack();
  const tenants = createTenantRepository(stack.db);
  await tenants.create({ id: 'T1', name: 'Kund 1' }, stack.clock.now());
  await tenants.create({ id: 'T2', name: 'Kund 2' }, stack.clock.now());
  return { ...stack, tenants };
}

describe('synktillstånd', () => {
  it('sparar och läser cursor per kund', async () => {
    const { db, clock } = await setup();
    const state = createSyncStateStore(db, clock);
    expect(await state.getCursor('T1')).toBeNull();
    await state.setCursor('T1', '42');
    await state.setCursor('T1', '43');
    await state.setCursor('T2', 'x');
    expect(await state.getCursor('T1')).toBe('43');
    expect(await state.getCursor('T2')).toBe('x');
  });
});

describe('kundkonfiguration', () => {
  it('saknar konfiguration tills kontoplan satts, och nya kunder startar i dry_run', async () => {
    const { db } = await setup();
    const provider = createTenantConfigProvider(db);
    expect(await provider.get('T1')).toBeNull();
    expect(await listSyncableTenants(db)).toEqual([]);

    expect(await setTenantAccounts(db, 'T1', accounts)).toBe(true);
    expect(await provider.get('T1')).toEqual({ accounts, mode: 'dry_run' });
    expect(await listSyncableTenants(db)).toEqual(['T1']);
  });

  it('följer läge och status, och avstängda kunder synkas inte', async () => {
    const { db, tenants } = await setup();
    const provider = createTenantConfigProvider(db);
    await setTenantAccounts(db, 'T1', accounts);

    await tenants.setMode('T1', 'live');
    expect((await provider.get('T1'))?.mode).toBe('live');

    await tenants.setStatus('T1', 'suspended');
    expect(await provider.get('T1')).toBeNull();
    expect(await listSyncableTenants(db)).toEqual([]);
  });

  it('avvisar ogiltiga kontonummer och okända kunder', async () => {
    const { db } = await setup();
    await expect(setTenantAccounts(db, 'T1', { ...accounts, bank: 12 })).rejects.toThrow();
    await expect(setTenantAccounts(db, 'T1', { ...accounts, bank: 1930.5 })).rejects.toThrow();
    expect(await setTenantAccounts(db, 'FINNS-INTE', accounts)).toBe(false);
  });

  it('ignorerar trasig kontoplan i databasen i stället för att bokföra på gissade konton', async () => {
    const { db } = await setup();
    await db.query(`update tenant set accounts = '{"bank": 1930}'::jsonb where id = 'T1'`);
    expect(await createTenantConfigProvider(db).get('T1')).toBeNull();
  });
});
