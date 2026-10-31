import type { LedgerCapabilities } from '../ports/ledger.js';

/**
 * Onboarding av en ny kund: vad som återstår innan förslagen kan godkännas och kunden gå live.
 * Allt här är rena funktioner. Fakta hämtas av src/db/onboarding.ts.
 */

/** Betalleverantörer vi kan läsa utbetalningar från. */
export const PAYOUT_PROVIDERS: readonly string[] = ['mondido'];
/** Affärssystem vi kan bokföra i. Kunden behöver en aktiv koppling till minst ett av dem. */
export const LEDGER_PROVIDERS: readonly string[] = ['fortnox', 'spiris', 'briox'];

export type OnboardingStepId = 'tenant_active' | 'accounts' | 'api_key' | 'payout_connection' | 'ledger_connection' | 'dry_run' | 'in_doubt';

export interface OnboardingFacts {
  tenantStatus: 'active' | 'suspended';
  mode: 'dry_run' | 'live';
  /** Kontoplanen finns och är giltig. */
  accountsValid: boolean;
  /** Antal nycklar som varken är återkallade eller utgångna. */
  activeKeys: number;
  /** Leverantörer med aktiv koppling. */
  activeProviders: readonly string[];
  proposalCount: number;
  proposalsWithExceptions: number;
  payoutCount: number;
  /** Anrop mot affärssystemet med okänt utfall. */
  inDoubtCount: number;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  label: string;
  done: boolean;
  /** Vad som ska göras när steget inte är klart. */
  hint: string;
}

export interface OnboardingStatus {
  tenantStatus: OnboardingFacts['tenantStatus'];
  mode: OnboardingFacts['mode'];
  /** setup: något återstår. review: allt är klart och förslagen kan godkännas. live: kunden bokför på riktigt. */
  phase: 'setup' | 'review' | 'live';
  steps: OnboardingStep[];
  /** Steg som hindrar go-live. Tom i fasen review och live. */
  blockers: OnboardingStepId[];
  proposals: { count: number; withExceptions: number };
}

const has = (providers: readonly string[], wanted: readonly string[]): boolean => providers.some((p) => wanted.includes(p));

export function evaluateOnboarding(facts: OnboardingFacts): OnboardingStatus {
  const steps: OnboardingStep[] = [
    {
      id: 'tenant_active',
      label: 'Kunden är aktiv',
      done: facts.tenantStatus === 'active',
      hint: 'Kunden är avstängd. Aktivera den med adminverktyget (activate).',
    },
    {
      id: 'accounts',
      label: 'Kontoplan inställd',
      done: facts.accountsValid,
      hint: 'Ange bank-, clearing-, avgifts- och momskonto (set-accounts). Låt redovisningskonsulten bekräfta dem.',
    },
    {
      id: 'api_key',
      label: 'Personlig API-nyckel utfärdad',
      done: facts.activeKeys > 0,
      hint: 'Utfärda en nyckel per person som ska granska (issue-key).',
    },
    {
      id: 'payout_connection',
      label: 'Koppling till betalleverantör',
      done: has(facts.activeProviders, PAYOUT_PROVIDERS),
      hint: `Anslut kundens betalleverantör (${PAYOUT_PROVIDERS.join(', ')}) med set-connection.`,
    },
    {
      id: 'ledger_connection',
      label: 'Koppling till affärssystem',
      done: has(facts.activeProviders, LEDGER_PROVIDERS),
      hint: `Anslut kundens affärssystem (${LEDGER_PROVIDERS.join(', ')}) med set-connection.`,
    },
    {
      id: 'dry_run',
      label: 'Testkörning har gjorts',
      done: facts.proposalCount > 0 || facts.payoutCount > 0,
      hint: 'Vänta på nästa körcykel. Förslag från kundens utbetalningar visas då under Förslag.',
    },
    {
      id: 'in_doubt',
      label: 'Inga osäkra anrop',
      done: facts.inDoubtCount === 0,
      hint: 'Avgör de osäkra anropen under Osäkra anrop innan kunden går live.',
    },
  ];

  const blockers = steps.filter((s) => !s.done).map((s) => s.id);
  const phase = facts.mode === 'live' ? 'live' : blockers.length === 0 ? 'review' : 'setup';
  return {
    tenantStatus: facts.tenantStatus,
    mode: facts.mode,
    phase,
    steps,
    blockers: phase === 'live' ? [] : blockers,
    proposals: { count: facts.proposalCount, withExceptions: facts.proposalsWithExceptions },
  };
}

/** Konsekvenserna av vad en adapter inte kan, formulerade för en handläggare. */
export function describeCapabilities(c: LedgerCapabilities): string[] {
  const notes: string[] = [];
  if (!c.searchByReference) notes.push('Affärssystemet kan inte söka faktura på referens: utbetalningar går inte att matcha automatiskt.');
  if (!c.postVoucher) notes.push('Affärssystemet kan inte ta emot verifikat: avgifter kan inte bokföras automatiskt.');
  if (!c.creditInvoice) notes.push('Affärssystemet kan inte kreditera fakturor: återbetalningar blir avvikelser att hantera för hand.');
  if (!c.idempotentWrites && !c.verifyByReference) {
    notes.push('Affärssystemet saknar både idempotens och sökning på vår referens: varje osäkert utfall måste kontrolleras av en människa i affärssystemet.');
  } else if (!c.idempotentWrites) {
    notes.push('Affärssystemet saknar egen idempotens: skyddsgatewayen och sökning på referens avgör osäkra utfall.');
  }
  return notes;
}
