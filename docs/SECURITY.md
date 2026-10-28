# Säkerhet och efterlevnad

Status: tidigt skede, inget i drift. Dokumentet skiljer på **implementerat** (finns i koden och verifierat), **planerat** (finns i SPEC men inte i koden) och **kvarstående risker**. `src/security` finns (`apiKeys.ts`, `crypto.ts`) och beskrivs i avsnitt 3.5 och 3.6. Läget gäller koden när dokumentet skrevs (migrationerna 001 till 003).

## 1. Vad som skyddas

- Kunders ekonomidata: utbetalningar, fakturareferenser, belopp, kontoplan, bokföringskommandon.
- Åtkomst till kunders system: tokens för betalleverantör och affärssystem (lagring och kryptering finns, se 3.6, men ingen adapter använder dem ännu).
- Bokföringens riktighet: ingen dubbel- eller felbokning, spårbar historik.
- API-nycklar som ger åtkomst till en kunds avvikelser.

## 2. Hotmodell (kort)

| Hot | Exempel | Motåtgärd i dag |
| --- | --- | --- |
| Läckage mellan kunder | Kund A läser eller stänger kund Bs avvikelser | Tenant-isolering i API och repositorier (3.1). Ingen databasnivå-isolering |
| Obehörig API-åtkomst | Gissad eller stulen nyckel | Nyckel krävs, lagras som HMAC med pepper, återkallning och utgångsdatum, enhetliga 401 (3.5). Ingen blockering av upprepade felförsök |
| Manipulerad eller felaktig leverantörsdata | Ändrad rad, dubbletter, summor som inte stämmer | Validering i motorn, `rejected`, `COMMAND_CONFLICT`, bokför aldrig på gissning |
| Dubbelbokning | Omkörning, krasch, återställning av fastnade kommandon | Unik nyckel i kön, `settledLineIds`, krav på idempotent gateway. **Gatewayen är obevisad mot Fortnox** |
| Förvanskad historik | Någon redigerar eller raderar revisionsloggen | Databastrigger som avvisar update/delete på `audit_log` (3.2) |
| Läckage via loggar och fel | Nycklar, belopp eller personuppgifter i loggar | Logger avstängd i API, strukturerade revisionsposter utan känsliga fält (3.3) |
| Stulna åtkomsttoken | Dumpad databas eller konfiguration | AES-256-GCM med kundbunden AAD (3.6). **Ingen KMS-provider än, och ingen adapter använder det** |
| Insider eller komprometterad driftmiljö | Någon med databasåtkomst ändrar kön | Ingen teknisk motåtgärd utöver revisionsloggen. Se risker (7) |
| Överbelastning | Många anrop mot API:t | Ingen rate limiting i servern. Förutsätts finnas framför |

## 3. Implementerade skydd

### 3.1 Tenant-isolering

- Alla portar tar `tenantId` som första argument och alla SQL-frågor filtrerar på `tenant_id` (`src/db/repositories.ts`).
- API:t härleder `tenantId` enbart från den autentiserade nyckeln (`request.tenantId`). Klienten kan inte ange kund. Resurser som tillhör annan kund svarar `404`, vilket inte avslöjar att de finns. Detta är testat i `test/api/`.
- Idempotensnycklar innehåller kundens id (URL-kodat), så kunder kan inte kollidera i kön.
- `claimDue` är systemomfattande (utföraren arbetar över alla kunder). Utförarprocessen är därför betrodd och ska inte exponeras.
- **Begränsning:** isoleringen sker i applikationslagret. Det finns ingen radnivåsäkerhet (Postgres RLS) och ingen separat databasroll per kund. En bugg i en fråga kan alltså bryta isoleringen.

### 3.2 Append-only revisionslogg

- `audit_log` har en trigger (`audit_log_no_update`) som kastar fel vid `update` och `delete`. Gränssnittet `AuditLog` har bara `append` och `list`.
- `processPayout` skriver en post per körning (live: `payout.processed`, bara när något faktiskt ändrats; dry_run loggar inget) i samma transaktion som övriga ändringar.
- **Begränsning:** triggern skyddar inte mot `truncate`, mot att triggern tas bort, eller mot superuser. Skydd mot en illasinnad databasadministratör kräver åtgärder utanför koden (separata roller, loggexport till write-once-lagring).
- Att stänga en avvikelse (`exception.resolved`) och köa om ett dött kommando (`command.requeued`) via API:t revisionsloggas atomiskt med åtgärden. Handlingens `actor` är 'api' utan nyckel-id (lucka). Manuella SQL-ingrepp loggas bara om den som gör dem skriver en post (RUNBOOK avsnitt 5). Utförarens statusändringar av kommandon loggas inte i `audit_log` (de syns i `ledger_command`, som kan uppdateras).

### 3.3 Inga känsliga data i loggar

- Fastify startas med `logger: false`, så `x-api-key` och övriga headers loggas inte. Felhanteraren returnerar aldrig interna detaljer (`500` ger "Internt fel").
- Revisionsposter (`summarize` i `processPayout.ts`) innehåller bara utbetalnings-id, status, antal kommandon och avvikelsekoder. Inga belopp per kund, referenser eller personuppgifter. `AuditEntry.details` är dokumenterad som fri från personuppgifter och betalningsdetaljer, men typen tvingar det inte.
- API:t visar kommandon avskalade: utan tenant-id, idempotensnyckel, innehåll, externt id och felmeddelande.
- **Begränsning:** `ledger_command.last_error` (högst 500 tecken) lagrar fritt felmeddelande från gatewayen, och avvikelsernas `message` innehåller fakturaid, referenser och belopp. `syncTenant` returnerar feltext (högst 300 tecken) till anroparen. En gateway-adapter måste se till att inte felmeddelanden innehåller token eller personuppgifter. Det är inte kontrollerat eftersom ingen riktig adapter finns.

### 3.5 API-nycklar (`src/security/apiKeys.ts`, `src/db/tenants.ts`)

- Format `synk_<12 hex>_<43 tecken base64url>`. Id:t är offentligt och används för uppslag och revision. Hemligheten är 32 slumpbyte.
- Bara `HMAC-SHA256(pepper, hela nyckeln)` lagras (`api_key.hash`). Pepparn (minst 32 byte) ska ligga i secret manager, inte i databasen. Nyckeln visas en enda gång vid utfärdande.
- Verifiering sker med `timingSafeEqual`, och en jämförelse mot en blindhash görs även när nyckeln inte finns.
- Återkallad nyckel, utgången nyckel och avstängd kund (`tenant.status = 'suspended'`) ger null och därmed `401`. `last_used_at` uppdateras vid lyckad autentisering.
- **Begränsningar:** ingen rate limiting eller utelåsning vid upprepade felförsök. Pepparn har ingen rotationsrutin (byte ogiltigförklarar alla nycklar). Ingen endpoint eller CLI för att utfärda eller återkalla nycklar, det görs via `ApiKeyRepository`. Att utfärda och återkalla nycklar loggas inte i `audit_log`.

### 3.6 Kryptering av åtkomsttoken (`src/security/crypto.ts`, `src/db/connections.ts`)

- Envelope-liknande schema med AES-256-GCM: blobben `v1.<keyId>.<nonce>.<chiffertext>.<tag>`. Key id ligger i blobben så att gamla data går att läsa efter nyckelrotation. `reencryptAll` omkrypterar till aktuell nyckel.
- AAD binder chiffertexten till version, key id, kund, anslutning och fält. En blob som flyttas till en annan kunds rad går därför inte att dekryptera.
- Felmeddelanden är fasta och innehåller aldrig klartext eller nyckelmaterial. `ConnectionInfo` (det som listas) innehåller varken klartext eller krypterad blob.
- Klartext lämnas bara ut av `getCredentialsForExecution`, avsett för intern körning mot leverantören.
- **Begränsningar:** den enda nyckelleverantören är `StaticKeyProvider` (test och dev). Någon `KeyProvider` mot KMS/secret manager finns inte, så nycklarna måste i dag skickas in av driftsättningen. Strikt sett är kryptering med en nyckel som hanteras av applikationen inte ett skydd mot någon som kompromissar applikationsprocessen. Ingen adapter hämtar eller använder anslutningar ännu, så flödet är bara enhetstestat.

### 3.7 Dataminimering i modellen

Domänmodellen innehåller inga kundnamn, adresser, e-post eller kortuppgifter. Det som lagras är rad-id, fakturareferens, belopp, valuta, fakturaid och kontonummer. Fakturareferensen kan ändå vara ett ordernummer som går att koppla till en person i kundens eget system.

## 4. Planerat men inte implementerat

| Område | Plan (SPEC avsnitt 7) | Status |
| --- | --- | --- |
| Kryptering av åtkomsttoken | Envelope encryption, nycklar i KMS eller secret manager, aldrig i klartext i databas eller loggar | **Delvis.** Kryptering och tabellen `connection` finns (3.6). KMS-/secret manager-leverantör saknas |
| Minsta möjliga OAuth-scope | Minimala rättigheter hos Fortnox | Inte tillämpligt än, ingen adapter |
| API-nycklar | Hashade nycklar per kund, rotation | Hash, återkallning och utgång finns (3.5). Pepper-rotation, rate limiting och loggning av utfärdande saknas |
| Gallring | Regler för att radera data | Inte implementerat |
| Radnivåsäkerhet | Inte i SPEC, rekommenderas | Inte implementerat |
| Daglig kontrollsumma och larm | SPEC avsnitt 6 | Inte implementerat |

## 5. GDPR-checklista

Kryssa av när det är gjort. Allt nedan är i nuläget öppet om inget annat anges.

- [ ] **Roller fastställda.** Kunden (e-handlaren) är personuppgiftsansvarig, tjänsten är personuppgiftsbiträde. Bekräfta med juridisk rådgivning.
- [ ] **Personuppgiftsbiträdesavtal (PUB)** tecknat med varje kund före första produktionsdata.
- [ ] **Underbiträden** förtecknade och kunderna informerade (hosting, databas, e-post, övervakning). Gäller även Fortnox/leverantören där de är biträden.
- [ ] **Dataminimering.** Spara bara det avstämning kräver. Modellen är minimal (3.7). Kontrollera varje ny adapter så att den inte lagrar kundnamn eller kortdata. `AuditEntry.details` och feltexter ska hållas fria från personuppgifter (kontroll saknas i kod).
- [ ] **Gallring/lagringstid.** Beslut om hur länge `ledger_command`, `reconcile_exception`, `payout` och `audit_log` sparas. Bokföringslagen kräver att räkenskapsinformation sparas länge (normalt sju år), så radering måste vägas mot den. Revisionsloggen är oföränderlig med avsikt och innehåller därför inte personuppgifter. **Ingen gallring är implementerad.**
- [ ] **EU-hosting.** Applikation, databas, backup och loggar i EU/EES. Bekräfta för varje tjänsteleverantör. Ingen hosting vald än (SPEC fråga 8).
- [ ] **Kryptering.** TLS framför API:t. Kryptering i vila för databas och backup. Tokenkryptering (4).
- [ ] **Åtkomstkontroll.** Vem får läsa produktionsdatabasen (kunddata) och hur loggas det.
- [ ] **Registrerades rättigheter.** Rutin för begäran om tillgång, rättelse och radering (via kunden som ansvarig). Vad som kan raderas utan att bryta bokföringsskyldighet.
- [ ] **Incidenthantering.** Rutin för personuppgiftsincident, med anmälan till IMY inom 72 timmar när det krävs, och underrättelse till kunden som ansvarig utan onödigt dröjsmål.
- [ ] **Registerförteckning.** Biträdets förteckning över behandlingar (artikel 30).
- [ ] **Konsekvensbedömning behövs?** Bedöm om behandlingen kräver konsekvensbedömning (DPIA).
- [ ] **Bokföringsspårbarhet** avstämd med redovisningskonsult före skarp drift (SPEC avsnitt 7).

## 6. Beroenden och leveranskedja

Beroenden i `package.json`: `fastify`, `zod`, `@electric-sql/pglite`. CI kör `npm ci` mot `package-lock.json`. Det finns ingen automatisk sårbarhetsskanning eller beroendeuppdatering i repot.

## 7. Kvarstående risker (ärlig lista)

1. **Gatewayens idempotens är obevisad.** Utförarens semantik är *minst en gång*. En Fortnox-adapter som inte kan avgöra "redan utfört" ger dubbelbokning vid krasch eller stale-återställning. Ingen Fortnox-adapter finns och Fortnox beteende är inte verifierat.
2. **Inga riktiga adaptrar.** Hela flödet är bara testat mot simulerade källor och en fake-gateway. Verkliga format, rate limits, felkoder och retryable/permanenta fel är okända.
3. **Tokenkryptering saknar riktig nyckelhantering.** Kryptering finns men bara med `StaticKeyProvider`. Ingen KMS-integration, ingen rotationsrutin för nycklarna i drift, och ingen adapter har använt flödet.
4. **API-autentiseringen saknar skydd mot gissning och rutiner.** Ingen rate limiting eller utelåsning, ingen pepper-rotation, ingen TLS i servern, inga verktyg för att utfärda nycklar, och utfärdande/återkallning loggas inte.
5. **Isolering endast i applikationslagret.** Ingen RLS. Utföraren har tillgång till alla kunders kö.
6. **Revisionsloggen är ofullständig.** API-stängningar och utförarens statusändringar loggas inte, manuella SQL-ingrepp kräver disciplin, och triggern skyddar inte mot `truncate` eller en administratör.
7. **Dödläge utan verktyg.** Dött kommando kräver SQL-ingrepp av människa. Det ger risk för mänskliga fel och att ingreppet inte loggas.
8. **Ingen övervakning eller larm.** Döda kommandon eller fastnade köer upptäcks bara om någon tittar.
9. **Luckor i avstämningen.** Ingen daglig kontrollsumma mot bokfört. Ändringar hos leverantören efter att en rad köats upptäcks bara för belopp/typ av rad och vid verifikat (COMMAND_CONFLICT täcker inte ändrad referens).
10. **Byte till live bokför allt på en gång.** Cursorn står kvar i dry_run, så alla hittills ej bokförda utbetalningar köas när kunden går live. Förslagen måste vara granskade före bytet.
11. **Gallring och lagringstider ej beslutade eller implementerade.**
12. **Testmiljö skiljer sig från drift.** Tester körs mot PGlite. Beteende som advisory locks och `skip locked` under verklig samtidighet är inte testat i drift, vilket Postgres-jobbet i CI delvis ska täcka.
13. **Ingen skanning av beroenden eller hemligheter i CI.**
