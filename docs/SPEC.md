# Teknisk specifikation: avstämningsflöde Mondido till Fortnox (v0.1, utkast)

Status: utkast för granskning. Ingen kod finns än. Varumärkesnamn är inte bestämt (fristående varumärke, ej Mondido-branding).

## 1. Mål och avgränsning

**Mål:** Ett kundkonto ska kunna koppla sin Mondido-butik och sitt Fortnox-konto och därefter få utbetalningar från Mondido bokförda och avstämda automatiskt, inklusive avgifter, återbetalningar och delkrediteringar.

**Ingår i första skivan (MVP):**
- Hämta transaktioner, återbetalningar och utbetalningar från Mondido.
- Matcha utbetalda transaktioner mot kundfakturor i Fortnox.
- Registrera inbetalning på faktura.
- Bokföra transaktionsavgifter och övriga avgifter som verifikat.
- Hantera hel- och delåterbetalning.
- Avvikelsekö med manuell hantering när automatisk matchning inte är säker.

**Ingår inte i MVP:**
- Order- och fakturaskapande från webbshop (finns hos konkurrenter, tyngre, kommer senare om efterfrågan finns).
- Produkt-, lager- och prissynk.
- Spiris (görs som andra adapter efter att Fortnox fungerar, se avsnitt 9).
- Andra betalleverantörer än Mondido.

**Förutsättning:** Fakturan finns redan i Fortnox, skapad av kundens befintliga integration eller manuellt. MVP bokför bara inbetalningen. Vilket fält som binder ihop faktura och Mondido-transaktion (se 5.1) är en öppen fråga.

## 2. Teknikval

| Område | Val | Motivering |
| --- | --- | --- |
| Språk | TypeScript (strict), Node.js LTS | Starkt typstöd mot externa API:er, brett ekosystem |
| API-server | Fastify | Snabb, enkel validering med scheman |
| Validering | Zod | All data från externa API:er valideras vid gränsen |
| Databas | PostgreSQL | Transaktioner, constraints och idempotens är kärnan |
| Kö/jobb | pg-boss (Postgres-baserad) | En beroende mindre än Redis, räcker för förväntad volym |
| ORM/migrationer | Drizzle eller Kysely, SQL-migrationer | Explicit SQL, spårbara scheman |
| Test | Vitest, samt kontraktstester mot inspelade API-svar | |
| Hosting | Containeriserat, EU-region | GDPR, kunders ekonomidata |

## 3. Arkitektur

```
 Mondido API ──► [Mondido-adapter] ──► normaliserade händelser ─┐
                                                                ▼
                                                      [Avstämningsmotor]
                                                                │
 Fortnox API ◄── [Fortnox-adapter] ◄── bokföringskommandon ◄────┘
                                                                │
                                                       [Avvikelsekö + UI/API]
```

- **Adaptrar** isolerar allt leverantörsspecifikt. Avstämningsmotorn pratar bara i ett internt, normaliserat format.
- **Avstämningsmotorn** är ren logik utan nätverksanrop. Den får normaliserad indata och producerar bokföringskommandon. Det gör den testbar i detalj.
- **Utförare** kör kommandona mot Fortnox med idempotens, retry och rate limiting.
- Samma mönster gör att Spiris och fler betalleverantörer kan läggas till som nya adaptrar.

## 4. Datamodell (översikt)

- `tenant`: kundkonto.
- `connection`: koppling per tenant och leverantör, med krypterade åtkomsttoken, status och senaste lyckade synk.
- `payment_event`: normaliserad händelse från betalleverantör (typ: betalning, återbetalning, delåterbetalning, utbetalningsrad, avgift). Unik på (`tenant`, `provider`, `provider_event_id`).
- `payout`: utbetalning med summa, valuta, datum och de händelser den innehåller.
- `match`: koppling mellan `payment_event` och Fortnox-faktura, med `confidence` och `method`.
- `ledger_command`: bokföringskommando mot Fortnox (inbetalning, verifikat), med `idempotency_key`, status och Fortnox-id.
- `exception`: avvikelse som kräver manuell hantering.
- `audit_log`: append-only, alla ändringar och kommandon.

Principer: pengar lagras som heltal i minsta enhet med valutakod, aldrig flyttal. Alla skrivningar mot Fortnox sker via `ledger_command` så att varje bokföring är spårbar och kan återupptas.

## 5. Avstämningslogik

### 5.1 Matchning transaktion till faktura

I prioritetsordning:
1. **Exakt referens:** Mondido-ordernummer/referens lika med fakturans referens eller OCR i Fortnox. *Öppen fråga:* vilket fält som faktiskt skickas i praktiken.
2. **Belopp + kund + datum inom fönster**, endast om entydig träff.
3. Annars: till avvikelsekön. Gissa aldrig bokföring.

Varje match får en `confidence`. Endast exakt träff bokförs automatiskt i MVP. Resten kräver godkännande tills vi har data på träffsäkerheten.

### 5.2 Flöde per utbetalning

1. Hämta utbetalning och dess ingående rader från Mondido.
2. Kontrollera att radernas summa efter avgifter stämmer med utbetalt belopp. Om inte: hela utbetalningen till avvikelse, inget bokförs.
3. För varje betalningsrad: matcha mot faktura, skapa inbetalning på fakturan.
4. Skapa **ett verifikat per utbetalning** för avgifter och övriga poster, och det belopp som flyttas till bankkonto/ clearing enligt kundens kontoplan (konfigurerbart per tenant).
5. Markera utbetalningen avstämd när alla delar lyckats. Annars delvis, med kvarvarande delar i kö.

### 5.3 Återbetalningar och delkrediteringar

- Hel återbetalning: kreditfaktura eller korrigering enligt Fortnox-flöde. Öppen fråga: vilket flöde kunden vill ha (kreditfaktura i Fortnox eller bara korrigerad inbetalning).
- Delåterbetalning: delkreditering på fakturan, belopp och moms fördelas proportionerligt, med tydlig regel för avrundning (summa av delar ska alltid bli exakt rätt belopp).
- Återbetalning som dras från en senare utbetalning hanteras som negativ rad i den utbetalningen.

### 5.4 Edge cases som måste ha tester från start

- Valutor och växling. Avgifter i annan valuta än försäljningen.
- Momsfördelning på avgifter.
- Utbetalning som täcker flera fakturor, och flera utbetalningar för en faktura.
- Dubbla webhooks eller omkörning. Samma händelse får aldrig bokföras två gånger.
- Betalning som återkallas efter att den bokförts (chargeback).
- Fakturan saknas eller är redan betald.
- Stängt räkenskapsår eller låst period i Fortnox.

## 6. Tillförlitlighet

- **Idempotens:** `idempotency_key` per kommando. Före varje skrivning kontrolleras att det inte redan gjorts (Fortnox saknar inbyggd idempotens, så vi lagrar och kontrollerar själva).
- **Retry:** exponentiell backoff, tydlig skillnad på tillfälliga fel (retry) och permanenta fel (avvikelse).
- **Rate limits:** per token-kö med begränsad genomströmning. Fortnox rate limit ska verifieras mot aktuell dokumentation.
- **Avstämningsrapport:** daglig kontrollsumma per tenant. Allt Mondido utbetalat ska motsvaras av bokfört i Fortnox, annars larm.
- **Dry-run-läge:** nya kunder startar i läge där inget skrivs till Fortnox, bara förslag visas för godkännande.

## 7. Säkerhet och efterlevnad

- Åtkomsttoken krypteras med envelope encryption, nycklar i KMS/secret manager, aldrig i klartext i databas eller loggar.
- Minsta möjliga behörighet (OAuth-scope) hos Fortnox.
- Personuppgiftsbiträdesavtal (PUB) med varje kund. Data stannar inom EU.
- Loggar innehåller inga personuppgifter eller betalningsdetaljer i klartext.
- Fullständig audit log, oföränderlig.
- Dataminimering: spara bara det som behövs för avstämning, med gallringsregler.
- Bokföringslagens krav på spårbarhet ska stämmas av med redovisningskonsult innan skarp drift.

## 8. Drift och agenter

Faser, inte allt på en gång:

**Fas 1 (vid byggstart):**
- *Granskare:* granskar varje ändring med fokus på bokföringslogik och säkerhet.
- *Verifierare:* nattlig körning av testflöden mot sandbox, larmar vid avvikelse.

**Fas 2 (när första kunden är live):**
- *API-bevakare:* schemalagd läsning av changelogs för Fortnox och Mondido, öppnar ärenden vid påverkan.
- *Supportsortering:* klassar inkommande ärenden och förbereder felsökning.

**Fas 3 (vid fler adaptrar/kunder):**
- Dokumentation/onboarding. Egen agent för varje ny adapter först när det finns volym.

**Mänskligt ansvar som inte kan delegeras:** driftansvar och jour, beslut om kunders bokföringsfrågor, avtal och partnerskap hos Fortnox/Spiris/Mondido, incidenthantering mot kunder.

## 9. Spiris (senare)

Samma interna format, ny adapter. Kräver egen kartläggning av API:t (OAuth, rate limits, hur inbetalningar och verifikat skapas) innan uppskattning. Görs efter att Fortnox-flödet är stabilt hos minst en kund.

## 10. Öppna frågor och risker

| # | Fråga/risk | Ägare |
| --- | --- | --- |
| 1 | Har Mondido API för utbetalningar och avgifter per rad, eller bara transaktioner? Avgör hela avstämningsdesignen | David |
| 2 | Vilket fält binder ihop Mondido-transaktion och Fortnox-faktura hos typiska kunder? | David/Mondido |
| 3 | Utvecklarkonto och sandbox hos Fortnox. Partnerprogram och krav för att listas | David |
| 4 | Hur vill kunder bokföra avgifter och clearing? Standardkontoplan eller konfigurerbart? | Redovisningskonsult |
| 5 | Kreditfaktura eller korrigering vid återbetalning? | Redovisningskonsult |
| 6 | Varumärkesnamn, domän och bolagsform (fristående från Mondido) | David |
| 7 | Neutralitet: ska även kunder utan Mondido kunna använda tjänsten på sikt? | David |
| 8 | Hosting, jourlösning och vem som svarar när något går fel | David |
| 9 | API-detaljer (endpoints, rate limits, scope) i denna spec är ännu inte verifierade mot aktuell dokumentation | Claude, när nätverksåtkomst finns |
| 10 | Sessionen når idag inte externa API-domäner, de måste tillåtas för att kunna testa | David |

## 11. Första byggsteg

1. Skelett: repo-struktur, TypeScript, lint, tester, CI, migrationer.
2. Normaliserat händelseformat och avstämningsmotor med full testtäckning på ren logik (inga nätverksanrop).
3. Mondido-adapter mot inspelade svar (när API-dokumentation finns).
4. Fortnox-adapter mot sandbox.
5. Dry-run end-to-end för en testtenant.
6. Pilotkund i dry-run, därefter skarpt läge.
