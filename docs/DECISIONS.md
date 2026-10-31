# Beslutslogg (ADR)

Kort logg över arkitekturbeslut hittills. Status anges per beslut. Nytt beslut läggs till längst ned, gamla ändras inte (markera i stället som ersatt).

## ADR-001: TypeScript och PostgreSQL

**Status:** antaget (SPEC avsnitt 2). Koden är TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) på Node 22.

**Beslut:** TypeScript för all kod, PostgreSQL som enda datalager. Fastify för API, Zod för validering vid gränser.

**Motivering:** starkt typstöd mot externa API:er. Transaktioner, constraints och unika index är kärnan i idempotensen (unik `key`, unikt `(tenant, payout, seq)`, partiellt unikt index för öppna avvikelser, trigger för append-only revisionslogg).

**Alternativ:** Python/Go (mindre fördel av delade typer mellan motor och adaptrar). NoSQL (svagare transaktions- och constraint-stöd).

**Konsekvens:** tester körs mot PGlite (Postgres i WASM), inte en riktig server. Därför finns ett CI-jobb mot Postgres 16 (`test/pg`, kräver `PG_TEST_URL`). `Db` har två implementationer: PGlite (tester) och `pg`-pool (`src/db/pg.ts`). Drizzle/Kysely (SPEC) valdes bort till förmån för handskrivet SQL bakom ett litet `Db`-gränssnitt.

## ADR-002: Ren avstämningsmotor

**Status:** implementerat (`src/engine/reconcile.ts`).

**Beslut:** `reconcile()` är en ren funktion: ingen I/O, ingen klocka, ingen slump. Samma indata ger samma kommandon med samma idempotensnycklar. Allt leverantörsspecifikt hålls i adaptrar bakom portar.

**Motivering:** bokföringslogik måste vara testbar i detalj, inklusive egenskapsbaserade tester (fast-check) och guldtester. Determinism är en förutsättning för idempotens: nycklar byggs av `tenant:utbetalning:rad:typ`, och rader sorteras på id så att leverantörens radordning inte spelar roll.

**Alternativ:** matchning direkt i adaptrarna eller i SQL. Svårtestat och leverantörskopplat.

**Konsekvens:** motorn bokför aldrig på gissning (endast exakt referens och exakt belopp). Allt osäkert blir avvikelse. Priset är fler manuella fall.

## ADR-003: Kö i databasen, inte Redis eller pg-boss

**Status:** implementerat (`ledger_command`). Ändrar SPEC avsnitt 2, som angav pg-boss.

**Beslut:** kommandokön är en egen tabell i samma Postgres, med `for update skip locked`.

**Motivering:**
- Kommandon läggs i kön i samma transaktion som avvikelser, utbetalningsstatus och revisionspost (`UnitOfWork`). Med extern kö (Redis) går inte det att göra atomiskt.
- Ordning per utbetalning (`seq`, "nästa släpps först när föregående lyckats") är ett affärskrav som generella köbibliotek inte ger direkt. Det är en enkel `not exists`-fråga.
- En komponent mindre att driva och säkra. Förväntad volym är låg.
- Dött kommando och dess felorsak är vanliga rader som går att undersöka med SQL.

**Alternativ:** Redis/BullMQ (extra beroende, ingen atomicitet med databasen). pg-boss (Postgres-baserad, men ordning per utbetalning och transaktionell koppling till vårt eget schema hade fått byggas ovanpå).

**Konsekvens:** vi äger retry, backoff och stale-återställning själva (`executor.ts`). Ingen schemaläggare finns. Genomströmning begränsas av databasen. Det finns ingen inbyggd rate limiting per token.

## ADR-004: `dry_run`

**Status:** läget implementerat, godkännandeflödet inte.

**Beslut:** `processPayout` har `mode: 'dry_run'`, och kundens `TenantConfig.mode` styr om `syncTenant` kör dry_run eller live. I dry_run beräknas allt men ingenting skrivs.

**Motivering:** nya kunder ska kunna se förslag innan något bokförs (SPEC avsnitt 6). Eftersom inget köas kan ingenting nå affärssystemet.

**Alternativ:** köa kommandon som "föreslagna" och godkänna dem en och en (mer tillstånd och risk för halvgodkända utbetalningar). Separat sandbox-miljö (löser inte kundens egen granskning).

**Konsekvens:** förslag sparas inte och syns inte i API:t. "Godkännande" är en omkörning i live-läge. Cursorn flyttas inte fram i dry_run, så byte till live hämtar och bokför tidigare utbetalningar automatiskt. Se ARCHITECTURE avsnitt 8.

## ADR-005: `settledLineIds`

**Status:** implementerat.

**Beslut:** `processPayout` härleder vilka rader som redan har betalnings- eller krediteringskommando i kön och skickar in dem som `settledLineIds`. Motorn matchar och bokför dem inte igen, men räknar med dem i summakontroll och verifikat.

**Motivering:** efter att en betalning utförts är fakturan betald. Utan detta skulle en omkörning se betalda fakturor som `INVOICE_NOT_OPEN` och skapa falska avvikelser. Samtidigt måste summakontrollen och verifikatet alltid gälla hela utbetalningen.

**Alternativ:** be anroparen hålla reda på det (felbenäget). Ta bort redan bokförda rader ur indata (summakontrollen skulle då alltid felaktigt slå larm).

**Konsekvens:** raderna "låses" av att kommandot finns, oavsett kommandots status. Ändringar hos leverantören i en redan köad rad syns därför inte i motorn utan upptäcks av konfliktdetektionen (ADR-007).

## ADR-006: Ordning per utbetalning

**Status:** implementerat (`seq` och `claimDue`).

**Beslut:** varje kommando får löpnummer inom sin utbetalning. Ett kommando körs först när alla tidigare i samma utbetalning är `succeeded`. Verifikatet köas sist. Ingen ordning mellan utbetalningar.

**Motivering:** verifikatet (avgifter, clearing) får inte bokföras före betalningarna, och en återbetalning ska komma efter sin betalning. Fel ordning ger felaktig bokföring även om varje enskilt kommando är korrekt. Begränsad ordning (bara per utbetalning) behåller parallellism mellan kunder och utbetalningar.

**Alternativ:** global ordning (onödigt långsamt, ett fel stoppar alla). Ingen ordning och i stället beroenden som retry (kan bokföra verifikat för tidigt).

**Konsekvens:** ett dött kommando blockerar resten av sin utbetalning tills en människa agerat (avsiktligt). En utförarrunda tar högst ett kommando per utbetalning. Köande serialiseras per utbetalning med advisory lock för att `seq` inte ska kollidera.

## ADR-007: Konfliktdetektion (`COMMAND_CONFLICT`)

**Status:** implementerat (`withConflicts` i `processPayout.ts`).

**Beslut:** om ett redan köat kommando skiljer sig från vad utbetalningen nu säger (annat belopp, annan typ, raden saknas, annat verifikat) skapas avvikelsen `COMMAND_CONFLICT`, och utbetalningen kan inte bli `complete`. Det köade kommandot behålls oförändrat.

**Motivering:** köns idempotens (`on conflict (key) do nothing`) släpper tyst ett nytt kommando med samma nyckel. Om innehållet ändrats utförs det gamla och det nya försvinner utan att någon vet. För bokföring är tyst fel värre än synligt stopp.

**Alternativ:** skriva över köat kommando (farligt om det redan utförts eller är på väg). Låta nyckeln inkludera belopp (då skulle ändrad rad ge ett nytt kommando bredvid det gamla, vilket kan ge dubbelbokning).

**Konsekvens:** människa avgör vilken version som gäller (RUNBOOK avsnitt 4). Det finns ingen automatisk ersättning av köade kommandon. Avvikelsen återkommer vid omkörning tills data stämmer igen.

## ADR-008: Gatewayens idempotenskrav

**Status:** krav definierat, uppfyllt bara av `FakeLedgerGateway`.

**Beslut:** `LedgerGateway.execute` måste vara idempotent på `command.key`. Utföraren garanterar *minst en gång*, inte exakt en gång.

**Motivering:** det går inte att göra "skriv till externt system och spara resultat" atomiskt. Krasch mellan de två stegen är oundviklig, så återupptagning (`recoverStale`) måste vara säker.

**Alternativ:** *exakt en gång* i utföraren (omöjligt utan stöd i det externa systemet). Aldrig automatisk retry efter oklart utfall (säkert men ger mycket manuellt arbete).

**Konsekvens:** en Fortnox-adapter måste själv kunna avgöra om något redan gjorts. Detta är inte undersökt mot Fortnox och är den största öppna risken.

## ADR-009: Pengar som heltal i minsta enhet

**Status:** implementerat (`src/domain/money.ts`).

**Beslut:** alla belopp är säkra heltal (öre). `allocate` delar belopp med största-återstoden-metoden (BigInt internt), `checkedAdd` kastar vid overflow.

**Motivering:** flyttal ger avrundningsdrift. Delar av en delkreditering (moms och netto) ska alltid summera exakt till helheten.

**Alternativ:** decimalbibliotek (onödigt när allt är i minsta enhet). Flyttal (olämpligt för bokföring).

## ADR-010: Hårdning efter oberoende granskning

**Bakgrund:** en oberoende granskning av kö, tjänstelager, säkerhet och API hittade bekräftade fel som ingen testsvit fångat.

**Beslut och ändringar:**
- `claimDue` hoppar över kunder som är avstängda eller i dry_run.
- Ett kommando som dör efter att utbetalningen blivit `complete` gör den `partial` (`onDead`), och `runCycle` larmar kritiskt så länge något är dött.
- Retry-After respekteras men aldrig under vanlig backoff, aldrig över taket, och ogiltiga värden ignoreras.
- Varje gateway-anrop har en timeout, och ett fel när utfallet sparas lämnar inte resten av omgången låst.
- Stale-gränsen är 30 minuter, större än en hel omgång, för att inte släppa kommandon som fortfarande körs.
- `markSucceeded`/`markFailed` är fencade på försöksnummer, så en försenad arbetare kan inte skriva över ett senare försök.
- Idempotensnyckeln är unik per kund (migration 004). `audit_log` skyddas även mot TRUNCATE.
- Mänskliga åtgärder via API:t och deras revisionspost är atomiska.
- Avvisade utbetalningar återupptas som delvis avstämda.
- dry_run skriver ingenting, inte ens revisionsposter.
- Kopplingar som inte är aktiva lämnar inte ut uppgifter.

**Kvarstående (se NEXT_STEPS och SECURITY):** gateway-idempotens mot riktiga affärssystem, paginering och rate limiting i API:t, `actor` utan nyckel-id, främmande nycklar mot `tenant`, rättvisa mellan kunder vid långsam gateway.

## ADR-011: Skyddsgateway i stället för att lita på affärssystemets idempotens

**Bakgrund:** utföraren ger minst-en-gång. Det enda som skyddade mot dubbelbokning var att gatewayen själv var idempotent på nyckeln, vilket vi inte kan veta om Fortnox. Det är den allvarligaste risken i systemet (dubbla inbetalningar i kunders bokföring).

**Beslut:** varje riktig gateway körs bakom `GuardedLedgerGateway`, **på som standard**. Journal (`gateway_guard`) skrivs före anropet ("påbörjad") och efter ("klar"). Säkert avvisade anrop (`LedgerError.notApplied`) släpper nyckeln. Okänt utfall skickas **aldrig** om automatiskt: det avgörs via `verify` om adaptern har en, annars av en människa. Ett anrop som startade för under 5 minuter sedan räknas som pågående (tillfälligt fel).

**Alternativ:** (1) kräva idempotens av varje adapter, vilket vi inte kan bevisa mot Fortnox och som varje adapter skulle få fel på olika sätt. (2) Alltid skicka om vid okänt utfall, vilket ger dubbelbokning. (3) Aldrig skicka om vid fel överhuvudtaget, vilket ger för många manuella ärenden.

**Konsekvens:** säkert men ger manuellt arbete för varje osäkert utfall tills adaptern får en `verify`. Kräver att adaptrar klassar fel rätt (`notApplied` bara när det är säkert), vilket `src/http/errors.ts` gör en gång för alla HTTP-adaptrar. Sviterna i `test/contracts/` bevisar kraven för nya adaptrar.

## ADR-012: dry_run sparar förslag

**Beslut:** dry_run sparar senaste förslaget per utbetalning (`dry_run_proposal`), synligt via API och CLI, och tas bort när utbetalningen bokförs live. Inga kommandon köas och ingen revisionspost skrivs. **Skäl:** kunden och deras redovisningskonsult måste kunna granska vad som SKULLE bokföras innan go-live. **Konsekvens:** förslag innehåller belopp, så de ligger i en egen tabell (inte i `audit_log`) och gallras efter egen gräns.

## ADR-013: Gallring med konservativa regler, manuell körning

**Beslut:** gallring (`src/db/retention.ts`) raderar bara klara, gamla utbetalningars kommandon samt avslutade avvikelser, förslag och klara guard-poster. Aldrig öppet, dött, pågående, osäkert, `audit_log` eller `payout`. Torrkörning först, `--yes` krävs. **Skäl:** bokföringslagen kräver långa lagringstider och en felaktig radering går inte att ångra. **Kvarstår:** gränsvärden ska fastställas med en redovisningskonsult, och körningen är inte schemalagd.

## ADR-014: Onboarding som checklista och godkännande, inte som engångsskript

**Bakgrund:** en ny kund kräver fem adminkommandon i terminal, och bytet till live gjordes med `set-mode` utan något spår av vem som granskat vad. Det skalar inte, och godkännandet är den mest riskfyllda åtgärden i hela flödet: allt som granskats bokförs på riktigt.

**Beslut:** (1) Onboardingens tillstånd *beräknas* av rena funktioner (`evaluateOnboarding`) ur fakta i databasen, i stället för att lagras som ett eget tillstånd som kan komma ur synk. (2) Go-live är ett API-anrop som kräver att godkännaren anger hur många förslag hen har sett; stämmer inte antalet längre vägras det (`stale_review`). Lägesbyte och revisionspost `tenant.go_live` skrivs i samma transaktion med kundens rad låst. (3) Affärssystemen beskrivs av `LedgerProvider` med `LedgerCapabilities`, så att checklistan kan säga ärligt vad en adapter inte kan, och så att Fortnox, Spiris och Briox har samma kontrakt.

**Alternativ:** ett lagrat onboardingtillstånd (kan driva isär från verkligheten, till exempel om en nyckel återkallas efteråt), eller att låta `set-mode` vara enda vägen (inget spår, ingen kontroll). Vi behöll `set-mode` för drift och nödfall.

**Konsekvens:** godkännandet är bara så starkt som nyckeln: det finns inga roller, så vem som helst med kundens nyckel kan godkänna. Roller och en särskild godkännandebehörighet är kvar att bygga. Antalet förslag är ett grovt men billigt skydd mot att godkänna något som ändrats; det visar inte *vilka* förslag som ändrats.
