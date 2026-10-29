import type { GatewayGuardStore, GuardBegin } from '../ports/index.js';

interface Entry {
  state: 'started' | 'done';
  externalId: string | null;
  startedAt: Date;
}

/** Journal i minnet för tester och demo. Samma semantik som createGatewayGuardStore (Postgres). */
export class MemoryGatewayGuardStore implements GatewayGuardStore {
  private readonly entries = new Map<string, Entry>();
  /** Antal anrop till complete som ska misslyckas (för att simulera att journalen inte går att skriva). */
  failCompleteTimes = 0;

  private id(tenantId: string, key: string) {
    return JSON.stringify([tenantId, key]);
  }

  async begin(tenantId: string, key: string, now: Date): Promise<GuardBegin> {
    const existing = this.entries.get(this.id(tenantId, key));
    if (!existing) {
      this.entries.set(this.id(tenantId, key), { state: 'started', externalId: null, startedAt: new Date(now) });
      return { outcome: 'acquired' };
    }
    if (existing.state === 'done') return { outcome: 'done', externalId: existing.externalId ?? '' };
    return { outcome: 'in_doubt', startedAt: existing.startedAt };
  }

  async complete(tenantId: string, key: string, externalId: string): Promise<void> {
    if (this.failCompleteTimes > 0) {
      this.failCompleteTimes--;
      throw new Error('journalen kunde inte skrivas');
    }
    const entry = this.entries.get(this.id(tenantId, key));
    if (entry) {
      entry.state = 'done';
      entry.externalId = externalId;
    }
  }

  async abort(tenantId: string, key: string): Promise<void> {
    const entry = this.entries.get(this.id(tenantId, key));
    if (entry?.state === 'started') this.entries.delete(this.id(tenantId, key));
  }

  async resolve(
    tenantId: string,
    key: string,
    outcome: { applied: true; externalId: string } | { applied: false },
  ): Promise<boolean> {
    const entry = this.entries.get(this.id(tenantId, key));
    if (!entry || entry.state !== 'started') return false;
    if (outcome.applied) {
      entry.state = 'done';
      entry.externalId = outcome.externalId;
    } else {
      this.entries.delete(this.id(tenantId, key));
    }
    return true;
  }

  async listInDoubt(tenantId?: string) {
    return [...this.entries.entries()]
      .map(([id, e]) => ({ id: JSON.parse(id) as [string, string], e }))
      .filter(({ id, e }) => e.state === 'started' && (tenantId === undefined || id[0] === tenantId))
      .map(({ id, e }) => ({ tenantId: id[0], key: id[1], startedAt: e.startedAt }));
  }
}
