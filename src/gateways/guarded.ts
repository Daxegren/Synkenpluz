import type { LedgerCommand } from '../domain/types.js';
import { LedgerError, type Clock, type GatewayGuardStore, type LedgerGateway } from '../ports/index.js';

export interface GuardedOptions {
  clock: Clock;
  /**
   * Valfritt: kan affärssystemet avgöra om ett kommando redan utförts (t.ex. genom att söka på en
   * referens vi skrev dit) löser det osäkra utfall automatiskt. Utan den kräver ett osäkert utfall
   * att en människa kontrollerar i affärssystemet (`resolve` på GatewayGuardStore).
   *
   * `found: false` måste betyda "säkert INTE utfört". Returnera hellre ett fel än ett osäkert `false`.
   */
  verify?:
    | ((tenantId: string, command: LedgerCommand) => Promise<{ found: true; externalId: string } | { found: false }>)
    | undefined;
  /**
   * Ett anrop som startade för kortare tid sedan kan fortfarande pågå hos en annan arbetare. Då
   * försöker vi igen senare (tillfälligt fel) i stället för att slå fast att utfallet är okänt.
   */
  inFlightGraceMs?: number | undefined;
}

const DEFAULT_IN_FLIGHT_GRACE_MS = 5 * 60_000;

/**
 * Skyddar mot dubbelbokning oavsett affärssystem. Fungerar även när affärssystemet saknar egen
 * idempotens, vilket vi inte kan veta om Fortnox. Regeln:
 *
 *   1. Skriv "påbörjad" i en journal (egen databas) FÖRE anropet.
 *   2. Lyckas anropet: skriv "klar" med affärssystemets id. Samma nyckel ger därefter alltid samma svar.
 *   3. Misslyckas anropet och felet är en LedgerError med `notApplied: true` (säkert inte utfört):
 *      släpp nyckeln, ett nytt försök är tillåtet.
 *   4. Misslyckas anropet på annat sätt (timeout, 5xx, avbruten anslutning, okänt fel) är utfallet OKÄNT.
 *      Nyckeln ligger kvar som "påbörjad". Nästa försök skickar INTE kommandot igen: det avgörs via
 *      `verify` om den finns, annars blir det ett permanent fel som kräver att en människa kontrollerar
 *      i affärssystemet. Hellre ett kommando som väntar på en människa än ett som bokförs två gånger.
 *
 * Kräver att adaptern klassar sina fel korrekt (se src/http/errors.ts). Ett fel som inte är en
 * LedgerError med notApplied räknas alltid som okänt utfall.
 */
export class GuardedLedgerGateway implements LedgerGateway {
  private readonly graceMs: number;

  constructor(
    private readonly inner: LedgerGateway,
    private readonly store: GatewayGuardStore,
    private readonly options: GuardedOptions,
  ) {
    this.graceMs = options.inFlightGraceMs ?? DEFAULT_IN_FLIGHT_GRACE_MS;
  }

  async execute(tenantId: string, command: LedgerCommand): Promise<{ externalId: string }> {
    const now = this.options.clock.now();
    let begin = await this.store.begin(tenantId, command.key, now);

    if (begin.outcome === 'done') return { externalId: begin.externalId };

    if (begin.outcome === 'in_doubt') {
      const age = now.getTime() - begin.startedAt.getTime();
      if (age < this.graceMs) {
        throw new LedgerError('Ett tidigare försök av samma kommando pågår kanske fortfarande. Försöker igen senare', true);
      }
      const verified = await this.tryVerify(tenantId, command);
      if (verified === undefined) {
        throw new LedgerError(
          'Utfallet av ett tidigare försök är okänt. Kontrollera i affärssystemet om kommandot utfördes och avgör det (resolve), köa sedan om kommandot',
          false,
        );
      }
      if (verified.found) {
        await this.store.resolve(tenantId, command.key, { applied: true, externalId: verified.externalId }, this.options.clock.now());
        return { externalId: verified.externalId };
      }
      // Säkert inte utfört: släpp nyckeln och försök på riktigt.
      await this.store.resolve(tenantId, command.key, { applied: false }, this.options.clock.now());
      begin = await this.store.begin(tenantId, command.key, this.options.clock.now());
      if (begin.outcome === 'done') return { externalId: begin.externalId };
      if (begin.outcome === 'in_doubt') {
        throw new LedgerError('Ett annat försök av samma kommando hann före. Försöker igen senare', true);
      }
    }

    // Vi äger nyckeln. Från och med nu är utfallet okänt tills vi vet annat.
    let result: { externalId: string };
    try {
      result = await this.inner.execute(tenantId, command);
    } catch (error) {
      if (error instanceof LedgerError && error.notApplied) {
        await this.store.abort(tenantId, command.key);
      }
      throw error;
    }

    // Anropet lyckades. Kan vi inte skriva det i journalen ligger nyckeln kvar som "påbörjad" och nästa
    // försök blir ett osäkert utfall i stället för en dubbelbokning.
    await this.store.complete(tenantId, command.key, result.externalId, this.options.clock.now());
    return result;
  }

  private async tryVerify(
    tenantId: string,
    command: LedgerCommand,
  ): Promise<{ found: true; externalId: string } | { found: false } | undefined> {
    if (!this.options.verify) return undefined;
    try {
      return await this.options.verify(tenantId, command);
    } catch {
      // Kan vi inte kontrollera är utfallet fortfarande okänt.
      return undefined;
    }
  }
}
