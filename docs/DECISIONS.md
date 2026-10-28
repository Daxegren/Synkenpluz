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

**Beslut:** `processPayout` har `mode: 'dry_run'`, och kundens `TenantConfig.mode` styr om `syncTenant` kör dry_run eller live. I dry_run beräknas allt men det enda som skrivs är en revisionspost.

**Motivering:** nya kunder ska kunna se förslag innan något bokförs (SPEC avsnitt 6). Eftersom inget köas kan ingenting nå affärssystemet.

**Alternativ:** köa kommandon som "föreslagna" och godkänna dem en och en (mer tillstånd och risk för halvgodkända utbetalningar). Separat sandbox-miljö (löser inte kundens egen granskning).

**Konsekvens:** förslag sparas inte och syns inte i API:t. "Godkännande" är en omkörning i live-läge. Cursorn flyttas fram även i dry_run, så byte till live kräver manuell omkörning av tidigare utbetalningar (se RUNBOOK). Se ARCHITECTURE avsnitt 8.

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
