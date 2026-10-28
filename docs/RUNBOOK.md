# Driftinstruktion (runbook)

För den ansvariga människan. Beskriver hur du ser vad som är fel och hur du agerar utan att riskera dubbelbokning. Bakgrund finns i [ARCHITECTURE.md](ARCHITECTURE.md).

## 0. Läs först

- **Mänskligt beslut krävs** är markerat med **BESLUT** nedan. Gör inte de stegen på egen hand utan att ha stämt av med den som ansvarar för kundens bokföring.
- Det finns idag **inga riktiga adaptrar** (ingen Mondido, ingen Fortnox), ingen schemaläggare och ingen kommandorad. `runCycle` (`src/app/cycle.ts`) kör `recoverStale`, synk och utförare i ett svep och returnerar larm (`alerts`), men den måste anropas av driftsättningen och larmen måste vidarebefordras av den. Instruktionerna gäller databasen och API:t som finns i repot. Bygg larm på frågorna i avsnitt 1.
- Alla SQL-exempel gäller schemat i `src/db/migrations.ts`. Kör läsfrågor först. Kör skrivande SQL bara i en transaktion (`begin; ... commit;`) och kontrollera radantalet innan du kör `commit`.
- Varje manuell ändring ska följas av en revisionspost (mall i avsnitt 5). `audit_log` är append-only och kan inte ändras eller raderas (databasen avvisar det).
- Den som resonerar om "klart" ska titta på kommandona, inte bara på utbetalningsstatusen. `payout.status = 'complete'` betyder avstämd och köad, inte utförd.

## 1. Lägesbild: dagliga kontroller

`runCycle` returnerar larm för avvisade utbetalningar, misslyckad synk, döda kommandon (`critical`) och obekräftade kommandon, men inget skickar dem vidare. Kör därför dessa frågor en gång per arbetsdag, och oftare vid incident.

```sql
-- Döda kommandon (kräver människa)
select id, tenant_id, payout_id, seq, command->>'kind' as kind,
       attempts, last_error, updated_at
  from ledger_command
 where status = 'dead'
 order by updated_at;

-- Kommandon som blockeras av ett dött kommando i samma utbetalning
select c.tenant_id, c.payout_id, c.seq, c.status, c.command->>'kind' as kind
  from ledger_command c
 where c.status in ('pending','failed','in_progress')
   and exists (select 1 from ledger_command d
                where d.tenant_id = c.tenant_id and d.payout_id = c.payout_id
                  and d.seq < c.seq and d.status = 'dead')
 order by c.tenant_id, c.payout_id, c.seq;

-- Fastnade kommandon (in_progress längre än 10 minuter)
select id, tenant_id, payout_id, seq, locked_at, attempts
  from ledger_command
 where status = 'in_progress' and locked_at < now() - interval '10 minutes';

-- Kommandon som väntar på nytt försök, äldst först
select id, tenant_id, payout_id, seq, attempts, next_attempt_at, last_error
  from ledger_command
 where status in ('pending','failed')
 order by next_attempt_at
 limit 50;

-- Öppna avvikelser
select id, tenant_id, payout_id, code, line_id, message, created_at
  from reconcile_exception
 where status = 'open'
 order by created_at;

-- Utbetalningar som inte är klara
select tenant_id, payout_id, status, processed_at
  from payout
 where status <> 'complete'
 order by processed_at;
```

Kommandon som lyckats men krävde flera försök är värda att titta på vid misstänkt dubbelbokning (avsnitt 8): `select ... from ledger_command where status = 'succeeded' and attempts > 1`.

`last_error` kan innehålla text från affärssystemets svar (högst 500 tecken). Klistra inte in den i ärenden eller chatt utan att kontrollera att den inte innehåller kunddata eller token.

## 2. Se ett dött kommando

Ett kommando blir `dead` när gatewayen svarar med ett permanent fel (`LedgerError` med `retryable = false`) eller när `attempts >= 8` (standard `maxAttempts`).

```sql
select id, tenant_id, payout_id, seq, key,
       command, attempts, last_error, created_at, updated_at
  from ledger_command
 where status = 'dead'
   and tenant_id = '<tenant>' and payout_id = '<utbetalning>';
```

`command` är JSON med `kind` (`register_invoice_payment`, `credit_invoice`, `post_voucher`), `invoiceId`, `amount`, `lineId` m.fl. Kommandot innehåller kontonummer och belopp, så behandla det som kunddata.

Via API:t syns bara en avskalad bild (status, antal försök, `hasError`) i `GET /v1/payouts/:id`, se [API.md](API.md).

**Konsekvens:** ett dött kommando blockerar alla senare kommandon i samma utbetalning (inklusive verifikatet) tills du agerat. Utbetalningen blir `partial` vid nästa live-körning av `processPayout`.

### 2.1 Vad du gör

1. Läs `last_error` och fastställ orsaken: permanent fel från affärssystemet (faktura finns inte, redan betald, låst period, ogiltigt konto), eller för många tillfälliga fel.
2. **Kontrollera i affärssystemet om kommandot ändå utfördes** (sök på faktura, verifikat eller beloppet). Ett kommando kan vara dött trots att det gick igenom (till exempel svar som försvann). Om gatewayens idempotens inte är bevisad (och det är den inte mot Fortnox, se ARCHITECTURE avsnitt 6) är detta steg obligatoriskt.
3. **BESLUT** (bokföringsansvarig): välj ett av alternativen.

**A. Orsaken är åtgärdad, kommandot ska köras igen** (till exempel fakturan skapades, perioden öppnades, kontot lades till):

Enklast via API:t, som också skriver en revisionspost (`command.requeued`):

```sh
curl -s -X POST -H "x-api-key: $API_KEY" http://localhost:3000/v1/commands/<kommando-id>/retry
```

Motsvarande SQL, om API:t inte är tillgängligt (skriv då själv en revisionspost, avsnitt 5):

```sql
begin;
update ledger_command
   set status = 'failed',
       attempts = 0,                 -- annars blir kommandot dött igen vid första felet
       next_attempt_at = now(),
       last_error = coalesce(last_error, '') || ' [återställt manuellt]',
       locked_at = null,
       updated_at = now()
 where id = '<kommando-id>' and status = 'dead';
-- förväntat radantal: 1
commit;
```

Utföraren plockar upp det vid nästa omgång. Lägg in revisionspost (avsnitt 5).

**B. Det är redan bokfört i affärssystemet** (manuellt eller av en tidigare körning): markera som lyckat så att kön går vidare. Ange verifikat-/inbetalningsnummer från affärssystemet som `external_id`.

```sql
begin;
update ledger_command
   set status = 'succeeded',
       external_id = 'MANUELL:<id i affärssystemet>',
       last_error = null, locked_at = null, updated_at = now()
 where id = '<kommando-id>' and status = 'dead';
commit;
```

**C. Kommandot ska aldrig utföras** (rad felaktig, kunden vill hantera själv): detta kräver att du tar bort kommandot, eftersom `dead` blockerar kön. Gör det bara för ett kommando som aldrig lyckats (`external_id is null`) och efter punkt 2 ovan. Radera inte och skapa inte om kommandot om du inte vet varför det dog: nyckeln frigörs, och nästa live-körning av utbetalningen köar kommandot igen om raden fortfarande finns i leverantörsdata. Överväg A eller B först.

4. Kör `drain` (eller vänta på utföraren). Kör därefter `processPayout` live för utbetalningen (avsnitt 7) så att utbetalningsstatusen uppdateras.

## 3. Avvikelsekoder (`ExceptionCode`)

En rad per kod, från `src/domain/types.ts`. "Avvisad" betyder att hela utbetalningen får status `rejected`, ingenting köas och bara denna avvikelse skapas. Övriga koder ger en avvikelse per rad och status `partial`.

Allmänna regler:

- Att stänga en avvikelse i API:t (`resolve`) ändrar inte bokföringen och köar inget. Den stängs också automatiskt vid omkörning om orsaken är borta.
- Stänger du en avvikelse (`dismissed` eller `resolved`) utan att orsaken är borta uppstår den på nytt som ny öppen rad vid nästa live-körning.
- **Verifikatet skapas inte förrän alla rader är lösta.** Det finns idag ingen funktion för att markera en rad som "hanterad manuellt". Om en rad löses utanför systemet (bokas för hand i affärssystemet) blir den kvar som avvikelse vid omkörning, och verifikatet för utbetalningen får bokföras manuellt av redovisningsansvarig. Det är en känd lucka (se avsnitt 10).
- Rättelser görs i källsystemet (fakturan i affärssystemet, eller hos leverantören), därefter körs utbetalningen om (avsnitt 7).

| Kod | Nivå | Orsak | Åtgärd |
| --- | --- | --- | --- |
| `PAYOUT_SUM_MISMATCH` | Avvisad | Radernas summa (betalningar minus återbetalningar minus avgifter inkl. moms) är inte lika med utbetalningens `netAmount`. Ofta saknade eller extra rader, avgifter i fel fält, eller att leverantörens data är ofullständig | Jämför leverantörens utbetalningsrapport rad för rad mot det som hämtades. Rätta i adaptern eller invänta rättad data från leverantören. **Boka inget manuellt förrän summan stämmer**. Utbetalningen återupptas inte automatiskt av `syncTenant` (bara `partial` gör det): kör om manuellt (avsnitt 7) när data är rätt. **BESLUT** om leverantörens data själv är felaktig |
| `DUPLICATE_LINE_ID` | Avvisad | Samma rad-id förekommer två gånger i utbetalningen. Adapterbugg eller dubblett hos leverantören. Rad-id är grunden för idempotensnycklarna, så dubbletter är farliga | Undersök råsvaret från leverantören. Rätta adaptern eller invänta rättelse. Förvänta ingen automatisk lösning. Utvecklare behövs om det är adaptern |
| `INVALID_AMOUNT` | Avvisad eller radnivå | Avvisad: belopp som inte är säkra heltal, negativt belopp i rad/avgift, eller summor för stora för att läggas ihop. Radnivå: betalning eller återbetalning med belopp 0 | Kontrollera hur adaptern konverterar belopp till minsta enhet (öre). Ett flyttal eller negativt värde är en adapterbugg. Ett nollbelopp från leverantören: undersök varför raden finns, **BESLUT** om den ska ignoreras hos leverantören |
| `CURRENCY_MISMATCH` | Avvisad eller radnivå | Avvisad: en rad har annan valuta än utbetalningen (flervalutastöd saknas). Radnivå: fakturans valuta skiljer sig från radens | Flera valutor stöds inte. Boka utbetalningen manuellt i affärssystemet. **BESLUT** (redovisningsansvarig) om kursdifferenser. Radnivå: kontrollera att rätt faktura matchats |
| `NO_MATCH` | Radnivå | Ingen kandidatfaktura har radens referens. Fakturan är ännu inte skapad i affärssystemet, referensen skiljer sig, eller adaptern hittade inte fakturan | Skapa fakturan eller rätta referensen i affärssystemet. Kontrollera att fakturaläsaren (`InvoiceReader`) faktiskt söker på referensen. Kör om. Avvikelsen stängs automatiskt när fakturan hittas. `syncTenant` försöker själv om `partial`-utbetalningar vid varje synk. Gissa aldrig matchning |
| `AMBIGUOUS_MATCH` | Radnivå | Fler än en faktura har samma referens | **BESLUT** (bokföringsansvarig): vilken faktura är rätt. Gör referenserna unika i affärssystemet (eller makulera dubbletten) och kör om. Systemet kan inte välja åt dig |
| `INVOICE_NOT_OPEN` | Radnivå | Betalning: fakturan är redan betald, annullerad eller har noll saldo. Återbetalning: fakturan är inte betald ännu (till exempel att betalningen är köad men inte utförd) | Betalning: **misstänk dubbelbetalning eller betalning via annan väg**. Kontrollera fakturans betalningshistorik i affärssystemet och avsnitt 8. **BESLUT** hur överskjutande betalning hanteras. Återbetalning: vänta tills betalningskommandot utförts (kontrollera kön) och kör om. Löses då automatiskt |
| `AMOUNT_MISMATCH` | Radnivå | Betalningens belopp är inte lika med fakturans obetalda belopp (del- eller överbetalning, avgift avdragen från beloppet, fel faktura). Delbetalning stöds inte | **BESLUT** (bokföringsansvarig): kontrollera mot kundens bankutdrag och faktura. Rätta faktura/referens eller boka manuellt i affärssystemet |
| `REFUND_EXCEEDS_INVOICE` | Radnivå | Återbetalningen är större än det som återstår att kreditera på fakturan (redan krediterat tidigare, eller fel faktura) | Kontrollera tidigare krediteringar på fakturan, och om samma återbetalning redan hanterats på annat sätt. **BESLUT** (bokföringsansvarig) om övrigt belopp (till exempel kundfordran eller fel faktura) |
| `INTERNAL_IMBALANCE` | Radnivå (utbetalningsnivå) | Verifikatet som motorn byggde balanserar inte (debet skiljer sig från kredit). Ska inte kunna inträffa efter summakontrollen och är en intern felindikator | Stäng inte avvikelsen. Eskalera till utvecklare med utbetalnings-id. Verifikatet har inte skapats. Boka inte manuellt förrän orsaken är känd |
| `INVALID_PAYOUT` | Avvisad | Utbetalningen saknar id, har ogiltigt datum (kräver `YYYY-MM-DD`), en rad med okänd typ eller tomt id, eller en betalnings-/återbetalningsrad utan referens | Adapterbugg eller trasig leverantörsdata. Undersök råsvaret. Utvecklare behövs för adaptern. Invänta rättelse och kör om |
| `INVALID_INVOICE` | Radnivå | Fakturan från adaptern har obegripliga uppgifter: negativa eller icke-heltal, moms över total, obetalt eller krediterat över total, krediterad moms över fakturans moms, eller betald faktura med kvarvarande saldo. Motorn vägrar bokföra mot inkonsekvent data | Öppna fakturan i affärssystemet och jämför med det adaptern levererade. Är fakturan korrekt är det en adapterbugg (utvecklare). Är den felaktig i affärssystemet: **BESLUT** hos bokföringsansvarig om hur den rättas. Kör om |
| `DUPLICATE_INVOICE_ID` | Avvisad | Adaptern levererade samma faktura-id mer än en gång bland kandidatfakturorna | Adapterbugg. Utvecklare behövs. Kör om efter rättning |
| `EMPTY_PAYOUT` | Avvisad | Utbetalningen har inga rader. Ofta en utbetalning som hämtats innan leverantören fyllt den | Vänta och kör om. Om leverantören bekräftar att utbetalningen verkligen är tom: stäng avvikelsen med anteckning. Inget bokförs |
| `COMMAND_CONFLICT` | Radnivå (eller verifikat) | En redan köad rad har sedan ändrats eller försvunnit hos leverantören (annat belopp, annan typ, raden saknas), eller så har det nya verifikatet ett annat innehåll än det köade. Det köade kommandot behålls oförändrat | Se avsnitt 4 |

## 4. Hantera `COMMAND_CONFLICT`

Betydelse: systemet skulle ha skrivit en annan bokföring än den som redan ligger i kön eller har utförts. Det köade kommandot behålls för att inte bokföra på gissning. **BESLUT** krävs alltid.

1. Hitta det köade kommandot och dess status:

   ```sql
   select id, seq, key, status, attempts, external_id, command, updated_at
     from ledger_command
    where tenant_id = '<tenant>' and payout_id = '<utbetalning>'
    order by seq;
   ```

2. Hämta leverantörens nuvarande rad för samma rad-id och jämför med `command` (belopp, typ). Fråga leverantören vilken version som gäller.

3. Fallen:

   - **Det köade kommandot är rätt** (leverantörens ändring var ett fel eller irrelevant): lämna kön orörd. Stäng avvikelsen med `dismissed` och anteckning. Observera att den dyker upp igen vid nästa live-körning så länge leverantörsdata skiljer sig. Utbetalningen blir kvar som `partial` och verifikatet skapas inte. Bokför verifikatet manuellt om det är nödvändigt, **BESLUT** hos bokföringsansvarig.
   - **Den nya versionen är rätt och kommandot inte har körts** (`status = 'pending'`, `attempts = 0`, `external_id is null`): ta bort det köade kommandot så att nästa körning köar rätt version. Ta bort *även verifikatkommandot* om det har byggts på fel summor och ännu inte körts. Gör det bara i en transaktion och logga det (avsnitt 5):

     ```sql
     begin;
     delete from ledger_command
      where id = '<kommando-id>' and status = 'pending' and attempts = 0 and external_id is null;
     -- förväntat radantal: 1
     commit;
     ```

     Kör sedan om utbetalningen (avsnitt 7). Det borttagna kommandots löpnummer lämnar ett hål, vilket är ofarligt. Ordningen bevaras eftersom nya kommandon får högre löpnummer.
   - **Den nya versionen är rätt men kommandot redan är utfört** (`succeeded`, eller `failed`/`in_progress` med risk att det gått igenom): rätta bokföringen i affärssystemet (kreditering eller korrigeringsverifikat) på redovisningsansvarigs ansvar. Systemet korrigerar inget själv. Dokumentera i avvikelsens anteckning och i revisionsloggen. Avvikelsen kommer att återkomma vid omkörning tills leverantörsdata matchar igen.

4. Konflikt på verifikat uppstår typiskt när avgifter ändrats efter att verifikatet köats. Verifikatet köas bara när alla rader är lösta, så kontrollera varför avgifterna ändrats.

## 5. Revisionspost för manuella ingrepp

Skriv alltid en post när du ändrar något via SQL. `actor` ska vara `human:<ditt namn eller id>`, aldrig en hemlighet. `details` får inte innehålla personuppgifter eller betalningsdetaljer.

```sql
insert into audit_log (tenant_id, at, actor, action, details)
values ('<tenant>', now(), 'human:<namn>', 'command.requeued_manually',
        jsonb_build_object('commandId', '<id>', 'payoutId', '<utbetalning>', 'reason', '<kort orsak>'));
```

Använd tydliga åtgärdsnamn, till exempel `command.requeued_manually`, `command.marked_succeeded_manually`, `command.deleted_manually`, `stale.released_manually`.

Avvikelser som stängs via API:t (`POST /v1/exceptions/:id/resolve`) får **ingen** automatisk revisionspost i nuvarande kod; bara avvikelsens status, anteckning och tid ändras. Skriv en egen post om du behöver spårbarhet.

## 6. Återställa fastnade kommandon (`recoverStale`)

**När:** kommandon har legat som `in_progress` längre än tröskeln (standard 10 minuter). Typiska orsaker: processen dog mitt i ett anrop, eller `markSucceeded` kunde inte skrivas (då räknas kommandot som `unconfirmed` i `RunSummary`).

**Risk:** kommandot kan redan ha gått igenom i affärssystemet. Återställning gör att det körs igen. Det är säkert **enbart** om gatewayen är idempotent på `key` (krav i `src/ports/index.ts`). `FakeLedgerGateway` är det. En kommande Fortnox-adapter måste bevisas vara det innan produktion.

**Före återställning:**

1. Kontrollera att ingen utförare fortfarande kör (annars körs samma kommando parallellt).
2. Är gatewayens idempotens inte bevisad: kontrollera i affärssystemet för varje fastnat kommando om det redan utförts.

**Så här gör du:**

Från kod (rekommenderat, så att det är samma logik som i drift):

```ts
import { recoverStale } from './src/executor/executor.js';
const released = await recoverStale({ commands, clock }, 10 * 60_000); // staleAfterMs
```

Funktionen sätter alla `in_progress` med `locked_at` äldre än tröskeln till `failed`, med `next_attempt_at = nu`. `attempts` behålls. Utföraren plockar upp dem vid nästa omgång. `runCycle` anropar `recoverStale` i början av varje cykel (tröskel `staleAfterMs`, standard 10 minuter), så om cykeln körs på schema sker återställningen av sig själv. Manuell körning behövs om cykeln inte körs eller du vill släppa kommandon tidigare. Sätt tröskeln högre än längsta tillåtna tid för ett gatewayanrop, annars släpps pågående kommandon.

Motsvarande SQL, om kod inte är tillgänglig:

```sql
begin;
update ledger_command
   set status = 'failed', locked_at = null, updated_at = now(), next_attempt_at = now(),
       last_error = coalesce(last_error, 'Frisläppt efter avbrott')
 where status = 'in_progress' and locked_at < now() - interval '10 minutes'
returning id, tenant_id, payout_id, seq;
commit;
```

Därefter `drain` eller invänta utföraren. Kontrollera att kommandona blir `succeeded`.

## 7. Köra om en utbetalning säkert

Omkörning är avsedd att vara säker: samma indata ger samma nycklar, köade rader hoppas över, och ingenting köas två gånger. Men följ ordningen.

**Förutsättningar:**

- Fakturastatus måste vara **färsk**. `InvoiceReader` ska hämta fakturorna på nytt vid varje körning. Gamla fakturadata ger falska avvikelser (eller fel beslut).
- Kontrollera nuläget: `GET /v1/payouts/:id` (kommandon) och öppna avvikelser för utbetalningen.
- Finns dött kommando eller `COMMAND_CONFLICT`, åtgärda enligt avsnitt 2 respektive 4 först.

**Steg:**

1. **Torrkörning.** Kör `processPayout` med `mode: 'dry_run'`. Det skriver bara en revisionspost (`payout.dry_run`) och returnerar förslaget. Läs `result.status`, `result.commands` och `result.exceptions`. Förvänta dig inga nya kommandon för rader som redan köats.
2. **Granska.** Är förslaget väntat (inga nya konflikter, rimliga nya kommandon)? Om inte, stanna.
3. **Live.** Kör `processPayout` med `mode: 'live'` och `actor: 'human:<namn>'`. Resultatet anger `enqueued` (nya kommandon) och `autoResolved` (avvikelser som löstes).
4. **Utför.** `drain`, eller invänta utföraren. Kontrollera att kommandona blir `succeeded`.
5. **Verifiera.** `payout.status` ska bli `complete` och inga öppna avvikelser ska finnas för utbetalningen.

Exempel (beroenden `uow`, `clock`, `source`, `invoices` kommer från din driftsättning, de levereras inte som färdig process):

```ts
const payout = await source.getPayout(tenantId, payoutId);
const invoices = await invoicesReader.findByReferences(
  tenantId,
  payout.lines.flatMap((l) => (l.type === 'fee' ? [] : [l.reference])),
);
const outcome = await processPayout(
  { uow, clock },
  { tenantId, payout, invoices, accounts },
  { mode: 'dry_run', actor: 'human:<namn>' },
);
console.log(outcome.result.status, outcome.result.commands.length, outcome.result.exceptions);
// Först efter granskning: samma anrop med mode: 'live'.
```

**Vad du aldrig gör:**

- Ändra eller återanvänd `key` på kommandon, eller skriv egna rader i `ledger_command` för att "tvinga" en bokföring.
- Köra om live för en utbetalning där du misstänker dubbelbokning (avsnitt 8) innan du utrett det.
- Radera döda kommandon bara för att få kön att gå (avsnitt 2).

**Särskilda fall:**

- `rejected` utbetalningar upptas inte automatiskt av `syncTenant`. Kör om dem manuellt när leverantörsdata är rättad.
- **Kund som bytt från dry_run till live** (`TenantRepository.setMode(tenantId, 'live')`): cursorn flyttas inte fram i dry_run, så nästa körcykel hämtar och bokför alla utbetalningar som hittills bara körts i dry_run. Se till att förslagen är granskade *före* bytet, eftersom allt bokförs på riktigt direkt. **BESLUT** att byta läge ska fattas av bokföringsansvarig efter att förslagen granskats.

## 8. Misstänkt dubbelbokning

Tecken: kunden rapporterar dubbel inbetalning/kreditering/verifikat, `INVOICE_NOT_OPEN` på en faktura som borde vara öppen, eller kommandon som lyckats efter många försök.

**Omedelbart:**

1. Stoppa utföraren (och `syncTenant`) för berörd kund, eller helt om du inte vet omfattningen. Fler körningar kan förvärra. Ändra inget i `ledger_command` ännu, det är bevis.
2. Anteckna tidpunkt, kund och berörda fakturor/utbetalningar.

**Utred:**

```sql
-- Samma faktura bokförd av flera lyckade kommandon
select tenant_id, command->>'invoiceId' as invoice_id, command->>'kind' as kind,
       count(*) as antal, array_agg(payout_id) as utbetalningar, array_agg(external_id) as externa_id
  from ledger_command
 where status = 'succeeded' and command->>'kind' in ('register_invoice_payment','credit_invoice')
 group by 1, 2, 3
having count(*) > 1;

-- Lyckade kommandon som krävde flera försök (kan ha körts dubbelt hos affärssystemet)
select id, tenant_id, payout_id, seq, command->>'kind' as kind, attempts, external_id, last_error
  from ledger_command
 where status = 'succeeded' and attempts > 1;

-- Hela historiken för en utbetalning
select at, actor, action, details from audit_log
 where tenant_id = '<tenant>' and details->>'payoutId' = '<utbetalning>' order by id;
```

Tolka resultatet:

- **Två kommandon på samma faktura** (olika `lineId`/utbetalning): leverantören har skickat samma betalning två gånger under olika rad-id eller utbetalningar. Idempotensen skyddar bara mot samma nyckel. Orsaken ligger i leverantörsdata eller adaptern.
- **Ett kommando i vår databas men dubbel bokning i affärssystemet:** detta syns **inte** i vår databas (en rad, ett `external_id`). Det inträffar om gatewayen inte är idempotent och kommandot kördes två gånger (`attempts > 1`, stale-återställning). Jämför affärssystemet med `external_id`:n. Detta är den största risken i systemet tills gatewayen bevisats.

**Åtgärd (alla steg är BESLUT hos bokföringsansvarig):**

1. Rätta bokföringen i affärssystemet (makulera, kreditera eller korrigera) med spårbarhet. Systemet gör det aldrig automatiskt.
2. Lägg revisionspost (avsnitt 5) och anteckning i berörda avvikelser.
3. Informera kunden om påverkan. Eventuell anmälan eller kommunikation mot kund, partner (Fortnox/Mondido) eller revisor är ett mänskligt beslut.
4. Rotorsaksanalys (utvecklare): varför bröts idempotensen? Tillför ett regressionstest. Återuppta drift först när orsaken är åtgärdad.

## 9. Jourrutin

Jourlösning och vem som svarar är ännu inte beslutat (SPEC fråga 8). Tills vidare gäller denna rutin för den ansvariga:

| Allvar | Exempel | Reaktion |
| --- | --- | --- |
| Hög: pengar eller bokföring kan vara fel | Misstänkt dubbelbokning, `INTERNAL_IMBALANCE`, utföraren kör okontrollerat | Stoppa utföraren för berörd kund. Utred enligt avsnitt 8. Informera kunden |
| Medel: bokföring är försenad | Dött kommando, kö som inte tömmer sig, gateway nere, många `partial` | Åtgärda samma dag enligt avsnitt 2 och 3 |
| Låg: enstaka avvikelser | `NO_MATCH` för saknad faktura, `AMBIGUOUS_MATCH` | Hantera vid daglig genomgång |

Rutin:

1. Kör kontrollerna i avsnitt 1 (varje arbetsdag).
2. Kör `recoverStale` om det finns fastnade kommandon (avsnitt 6).
3. Gå igenom öppna avvikelser per kund. Åtgärda orsaken i källsystemet, kör om (avsnitt 7).
4. Dokumentera varje manuellt ingrepp i `audit_log` (avsnitt 5).
5. Vid incident: anteckna tidslinje, påverkade kunder och åtgärd. Kundkommunikation om incidenter är ett mänskligt beslut.

**Kräver alltid mänskligt beslut:** att bokföra eller korrigera i kundens affärssystem, hur avvikelser i belopp/valuta/moms behandlas, om ett dött kommando ska köras igen/markeras klart/tas bort, byte av kund från dry_run till live, kundkommunikation, och kontakt med partners.

## 10. Kända luckor som påverkar driften

- Larmen från `runCycle` skickas ingenstans. Allt i avsnitt 1 är manuellt tills driftsättningen kopplat in dem.
- Ingen funktion för att markera en rad som manuellt hanterad. Därmed kan verifikat och `complete`-status inte nås för en utbetalning där en rad löstes utanför systemet.
- Ingen funktion för att återuppta dött kommando. Allt sker via SQL.
- API-stängning av avvikelser skriver ingen revisionspost.
- `rejected` utbetalningar körs inte om automatiskt.
- Ingen process eller schemaläggare som anropar `runCycle` levereras.
- Det finns inga verktyg för att skapa kunder, nycklar eller anslutningar. Det görs med repositorierna (`createTenantRepository`, `createApiKeyRepository`, `createConnectionRepository`) i egen kod. Återkalla en nyckel: `revoke(tenantId, id, now)`. Stäng av en kund: `setStatus(id, 'suspended')` (nycklar och synk slutar då fungera).
