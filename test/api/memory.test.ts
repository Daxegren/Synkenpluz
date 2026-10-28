import { describe, expect, it } from 'vitest';
import type { LedgerCommand } from '../../src/domain/types.js';
import { createMemoryStore } from '../../src/testing/memory.js';

const t0 = new Date('2026-10-28T10:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

function cmd(key: string): LedgerCommand {
  return { kind: 'register_invoice_payment', key, lineId: 'L-' + key, invoiceId: 'INV', amount: 100, currency: 'SEK', date: '2026-10-28' };
}

describe('memory commands', () => {
  it('enqueue är idempotent på nyckel (per tenant)', async () => {
    const { commands } = createMemoryStore();
    expect(await commands.enqueue('A', 'P1', [cmd('k1'), cmd('k2'), cmd('k1')], t0)).toBe(2);
    expect(await commands.enqueue('A', 'P1', [cmd('k1'), cmd('k3')], t0)).toBe(1);
    expect(await commands.enqueue('B', 'P1', [cmd('k1')], t0)).toBe(1);
    expect(await commands.listByPayout('A', 'P1')).toHaveLength(3);
    expect(await commands.listByPayout('B', 'P1')).toHaveLength(1);
  });

  it('claimDue låser, respekterar nextAttemptAt, limit och status', async () => {
    const { commands } = createMemoryStore();
    await commands.enqueue('A', 'P', [cmd('a'), cmd('b'), cmd('c')], t0);
    expect(await commands.claimDue(new Date(t0.getTime() - 1), 10)).toEqual([]);
    const first = await commands.claimDue(t0, 2);
    expect(first).toHaveLength(2);
    expect(first.every((c) => c.status === 'in_progress' && c.attempts === 1)).toBe(true);
    const second = await commands.claimDue(t0, 10);
    expect(second).toHaveLength(1); // redan låsta returneras inte igen
    expect(await commands.claimDue(t0, 10)).toEqual([]);
  });

  it('markFailed med retryAt ger failed och nytt försök först då; null ger dead', async () => {
    const { commands } = createMemoryStore();
    await commands.enqueue('A', 'P', [cmd('a'), cmd('b')], t0);
    const [a, b] = await commands.claimDue(t0, 10);
    await commands.markFailed(a!.id, 'tillfälligt', later(1000), t0);
    await commands.markFailed(b!.id, 'permanent', null, t0);
    expect(await commands.claimDue(later(999), 10)).toEqual([]);
    const retry = await commands.claimDue(later(1000), 10);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.id).toBe(a!.id);
    expect(retry[0]!.attempts).toBe(2);
    const all = await commands.listByPayout('A', 'P');
    expect(all.find((c) => c.id === b!.id)).toMatchObject({ status: 'dead', lastError: 'permanent' });
  });

  it('markSucceeded sparar externalId och claimas inte igen', async () => {
    const { commands } = createMemoryStore();
    await commands.enqueue('A', 'P', [cmd('a')], t0);
    const [a] = await commands.claimDue(t0, 1);
    await commands.markSucceeded(a!.id, 'FX-1', t0);
    expect(await commands.claimDue(later(10_000), 10)).toEqual([]);
    expect((await commands.listByPayout('A', 'P'))[0]).toMatchObject({ status: 'succeeded', externalId: 'FX-1' });
  });

  it('releaseStale återställer bara gamla in_progress', async () => {
    const { commands } = createMemoryStore();
    await commands.enqueue('A', 'P', [cmd('old'), cmd('new')], t0);
    const [old] = await commands.claimDue(t0, 1);
    await commands.claimDue(later(5000), 1);
    expect(await commands.releaseStale(later(1000), later(6000))).toBe(1);
    const again = await commands.claimDue(later(6000), 10);
    expect(again.map((c) => c.id)).toEqual([old!.id]);
  });

  it('returnerar kopior som inte kan mutera lagret', async () => {
    const { commands } = createMemoryStore();
    await commands.enqueue('A', 'P', [cmd('a')], t0);
    const [x] = await commands.listByPayout('A', 'P');
    x!.status = 'dead';
    expect((await commands.listByPayout('A', 'P'))[0]!.status).toBe('pending');
  });
});

describe('memory exceptions', () => {
  const ex = (code: 'NO_MATCH' | 'AMOUNT_MISMATCH', lineId?: string) => ({
    code,
    message: 'm',
    ...(lineId !== undefined ? { lineId } : {}),
  });

  it('add är idempotent per (tenant, payout, code, lineId)', async () => {
    const { exceptions } = createMemoryStore();
    expect(await exceptions.add('A', 'P', [ex('NO_MATCH', 'l1'), ex('NO_MATCH', 'l1'), ex('NO_MATCH'), ex('AMOUNT_MISMATCH', 'l1')], t0)).toBe(3);
    expect(await exceptions.add('A', 'P', [ex('NO_MATCH', 'l1')], t0)).toBe(0);
    expect(await exceptions.add('A', 'P2', [ex('NO_MATCH', 'l1')], t0)).toBe(1);
    expect(await exceptions.add('B', 'P', [ex('NO_MATCH', 'l1')], t0)).toBe(1);
  });

  it('list filtrerar och är tenant-isolerad; get kräver rätt tenant', async () => {
    const { exceptions } = createMemoryStore();
    await exceptions.add('A', 'P1', [ex('NO_MATCH', 'x')], t0);
    await exceptions.add('A', 'P2', [ex('NO_MATCH', 'x')], t0);
    await exceptions.add('B', 'P1', [ex('NO_MATCH', 'x')], t0);
    expect(await exceptions.list('A')).toHaveLength(2);
    expect(await exceptions.list('A', { payoutId: 'P1' })).toHaveLength(1);
    expect(await exceptions.list('A', { status: 'resolved' })).toHaveLength(0);
    const [b] = await exceptions.list('B');
    expect(await exceptions.get('A', b!.id)).toBeNull();
    expect(await exceptions.get('B', b!.id)).not.toBeNull();
  });

  it('resolve: true första gången, false om redan hanterad, okänd eller annan tenant', async () => {
    const { exceptions } = createMemoryStore();
    await exceptions.add('A', 'P', [ex('NO_MATCH', 'x')], t0);
    const [e] = await exceptions.list('A');
    expect(await exceptions.resolve('B', e!.id, { status: 'resolved', note: 'n' }, t0)).toBe(false);
    expect((await exceptions.get('A', e!.id))!.status).toBe('open');
    expect(await exceptions.resolve('A', 'nope', { status: 'resolved', note: 'n' }, t0)).toBe(false);
    expect(await exceptions.resolve('A', e!.id, { status: 'dismissed', note: 'ok' }, later(5))).toBe(true);
    expect(await exceptions.resolve('A', e!.id, { status: 'resolved', note: 'igen' }, t0)).toBe(false);
    expect(await exceptions.get('A', e!.id)).toMatchObject({ status: 'dismissed', resolutionNote: 'ok', resolvedAt: later(5) });
  });
});

describe('memory payouts', () => {
  it('record skriver över, get/list är tenant-isolerade och filtrerar', async () => {
    const { payouts } = createMemoryStore();
    await payouts.record({ tenantId: 'A', payoutId: 'P1', status: 'partial', processedAt: t0 });
    await payouts.record({ tenantId: 'A', payoutId: 'P1', status: 'complete', processedAt: later(1) });
    await payouts.record({ tenantId: 'A', payoutId: 'P2', status: 'rejected', processedAt: t0 });
    await payouts.record({ tenantId: 'B', payoutId: 'P1', status: 'rejected', processedAt: t0 });
    expect((await payouts.get('A', 'P1'))!.status).toBe('complete');
    expect((await payouts.get('B', 'P1'))!.status).toBe('rejected');
    expect(await payouts.get('B', 'P2')).toBeNull();
    expect(await payouts.list('A')).toHaveLength(2);
    expect(await payouts.list('A', { status: 'rejected' })).toHaveLength(1);
  });
});
