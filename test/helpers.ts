import { PGlite } from '@electric-sql/pglite';
import { createPgliteDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrations.js';
import { createRepositories, createUnitOfWork } from '../src/db/repositories.js';
import type { AccountMapping, Invoice, Payout, PayoutLine } from '../src/domain/types.js';
import type { Clock } from '../src/ports/index.js';

export class TestClock implements Clock {
  constructor(private current = new Date('2026-10-28T08:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  const db = createPgliteDb(pg);
  await migrate(db);
  return { db, pg };
}

export async function createTestStack() {
  const { db, pg } = await createTestDb();
  const clock = new TestClock();
  return { db, pg, clock, repos: createRepositories(db), uow: createUnitOfWork(db) };
}

// Kontonummer är påhittade testvärden.
export const accounts: AccountMapping = { bank: 1930, clearing: 1580, feeExpense: 6570, feeVat: 2641 };

export function makeInvoice(id: string, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id,
    reference: `REF-${id}`,
    currency: 'SEK',
    total: 12500,
    vatTotal: 2500,
    balance: 12500,
    creditedTotal: 0,
    creditedVatTotal: 0,
    status: 'open',
    ...overrides,
  };
}

export function payment(id: string, reference: string, amount: number, fee?: { net: number; vat: number }): PayoutLine {
  return { type: 'payment', id, reference, amount, currency: 'SEK', ...(fee ? { fee } : {}) };
}

export function makePayout(id: string, lines: PayoutLine[]): Payout {
  const netAmount = lines.reduce((sum, l) => {
    if (l.type === 'payment') return sum + l.amount - (l.fee ? l.fee.net + l.fee.vat : 0);
    if (l.type === 'refund') return sum - l.amount;
    return sum - (l.fee.net + l.fee.vat);
  }, 0);
  return { id, date: '2026-10-28', currency: 'SEK', netAmount, lines };
}
