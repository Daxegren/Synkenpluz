# SYNKA+

SYNKA+ är en integrationsplattform som automatiserar flödet mellan webbshop och affärssystem. Plattformen tar bort manuell dubbelregistrering av order, fakturor, produkter, lager och priser, samt avstämning mot betalleverantörens utbetalningar.

Mer information: <https://synkaplus.se>

## Funktioner

### Bokföring av fakturor och avstämningar

Order, fakturor och avstämningar automatiseras mot affärssystemet.

1. En order eller faktura skapas i affärssystemet när ordern i webbshoppen når en specifik status.
2. När en utbetalning kommer från betalleverantören skapas en inbetalning på fakturan i affärssystemet.
3. Fakturan stäms därmed av automatiskt.

### Produkter

Produkter synkas mellan affärssystem och webbshop med följande data:

- Namn
- Artikelnummer
- EAN
- Lager
- Pris

Produkter behöver inte skapas manuellt i båda systemen. Grunden för artikeln skapas automatiskt.

### Lager och pris

Lager och pris kan synkas automatiskt från både webbshop och affärssystem, så att systemen hålls uppdaterade utan manuellt arbete.

### Återbetalningar och avstämningar

- Återbetalningar och delkrediteringar som görs i webbshoppen hanteras automatiskt.
- De stäms av mot utbetalningarna från betalleverantören.

## Målgrupp

E-handlare som driver webbshop (Shopify, WooCommerce, PrestaShop eller Magento 2) och affärssystem (Fortnox, Spiris, HiCore eller Specter) parallellt och vill minska tiden som läggs på dubbelregistrering och manuell avstämning. Även redovisningskonsulter nämns som mottagare av tidsbesparingen.

## Kopplingar och priser

Priser i kronor per månad. Samtliga paket kan tecknas utan bindningstid eller med bindningstid (lägre pris), utom AutoPrint som endast listas utan bindningstid.

### Grundpaket

| Webbshop | Affärssystem | Utan bindningstid | Med bindningstid |
| --- | --- | --- | --- |
| Shopify | Fortnox | 649 | 499 |
| Shopify | Spiris | 649 | 499 |
| Shopify | HiCore | 649 | 499 |
| PrestaShop | Fortnox | 749 | 599 |
| PrestaShop | Spiris | 749 | 599 |
| WooCommerce | Fortnox | 749 | 599 |
| WooCommerce | Spiris | 749 | 599 |
| WooCommerce | HiCore | 749 | 599 |
| WooCommerce | Specter | 749 | 599 |
| Magento 2 | Fortnox | 1 399 | 1 100 |
| Magento 2 | Spiris | 1 399 | 1 100 |

Grundpaketen för bokföringssystemen (Fortnox, Spiris, Specter) omfattar bokföring, ordrar, kundkort och kunddetaljer. Grundpaketen för HiCore omfattar ordrar, produkter och lager.

### Synka+ AutoPrint

Automatiserar fraktprocessen genom att fraktetiketter kan skrivas ut direkt från webbshopen eller andra system. 199 kr/mån utan bindningstid.

### Tilläggstjänster

Tilläggen ligger utöver grundpaketet och tillkommer på priset. Alla kostar 250 kr/mån utan bindningstid och 150 kr/mån med bindningstid.

**Betalleverantörer** (automatisk avstämning av utbetalningar, inklusive transaktionsavgifter och övriga avgifter):

| Betalleverantör | Fortnox | Spiris |
| --- | --- | --- |
| Klarna | ✓ | ✓ |
| Mollie | ✓ | ✓ |
| Nets Easy | ✓ | ✓ |
| PayPal | ✓ | ✓ |
| Ledyer | ✓ | |
| Dintero | ✓ | |
| Qliro | ✓ | |

**CDON** (Fortnox och Spiris): för över CDON-ordrar till webbshopen, skapar dem i affärssystemet med bokföringsunderlag och stämmer av mot CDON Settlement.

> Listan över tillägg är hämtad från webbplatsen och kan vara ofullständig. Kontrollera mot <https://synkaplus.se> innan den används som underlag.

## Status

Tidigt skede. Funktionsbeskrivningen ovan bygger på informationen på webbplatsen och är inte implementerad i sin helhet. Repot innehåller den tekniska kärnan för första skivan (utbetalningsavstämning, Mondido till Fortnox).

**Implementerat och testat:**

- Avstämningsmotor (`src/engine/reconcile.ts`): ren funktion som matchar utbetalningsrader mot fakturor på exakt referens och belopp, hanterar återbetalningar och delkrediteringar, och bygger ett verifikat per utbetalning. Osäkra rader blir avvikelser.
- Domän (`src/domain/`): normaliserade typer och beloppshantering med heltal i minsta enhet.
- Tjänstelager (`src/service/`): `processPayout` (en utbetalning, atomiskt, med dry_run och konfliktdetektion) och `syncTenant`.
- Kommandokö i Postgres-schema (`src/db/`, klient via `pg` eller PGlite) med ordning per utbetalning och idempotensnycklar, samt utförare med retry och återställning (`src/executor/`). Körcykel som knyter ihop synk och utförare (`src/app/cycle.ts`).
- HTTP-API (`src/api/server.ts`) för att läsa utbetalningar och avvikelser och stänga avvikelser.
- Kunder, hashade API-nycklar och krypterad lagring av anslutningsuppgifter (`src/security/`, `src/db/tenants.ts`, `src/db/connections.ts`).

- Körbar tjänst (`src/main.ts`): API-server och schemalagd körcykel (synk, avstämning, bokföring) mot riktig Postgres (`src/db/pg.ts`), med graciös nedstängning.
- Administrationsverktyg (`scripts/admin.ts`): skapa kund, kontoplan, läge, API-nycklar och krypterade kopplingar.
- Säkerhet (`src/security/`): AES-256-GCM-kryptering av åtkomsttoken bundet till kund och koppling, och HMAC-hashade API-nycklar.
- Testat mot både PGlite och riktig Postgres 16, inklusive samtidighet med flera parallella arbetare.

**Saknas:**

- Adaptrar mot Mondido och Fortnox. Det finns bara gränssnitt (`src/ports/`) och simulerade implementationer för tester (`src/gateways/`). Tjänsten startar med platshållare som misslyckas tydligt per kund. Den kan inte bokföra i något riktigt affärssystem förrän adaptrarna finns (kräver API-dokumentation och sandbox-konton).
- Riktig nyckelhantering (KMS) och larm via e-post/pager. Larm skickas via webhook om `ALERT_WEBHOOK_URL` är satt.
- Produkt-, lager- och prissynk, order- och fakturaskapande, Spiris och övriga betalleverantörer.

Detaljer: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Dokumentation

**Börja med [docs/INDEX.md](docs/INDEX.md)** (läsordning och snabbsvar) och **[docs/FUNKTIONSKARTA.md](docs/FUNKTIONSKARTA.md)** (karta över allt som finns: funktioner, filer, diagram, tabeller, rutter, koder, tester, och vad som är simulerat eller saknas).

| Dokument | Innehåll |
| --- | --- |
| [docs/INDEX.md](docs/INDEX.md) | Index, läsordning och dokumentationsregeln |
| [docs/FUNKTIONSKARTA.md](docs/FUNKTIONSKARTA.md) | Funktionskarta med diagram |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Driftsättning: Docker, kontrolllista inför skarp drift, go-live |
| [docs/MONDIDO_DATAKONTRAKT.md](docs/MONDIDO_DATAKONTRAKT.md) | Underlag till Mondidos utvecklare: vilka data vi behöver |
| [docs/FORTNOX_TESTPLAN.md](docs/FORTNOX_TESTPLAN.md) | Testplan för första dagen i Fortnox-sandboxen |
| [docs/BESLUT_REDOVISNING.md](docs/BESLUT_REDOVISNING.md) | Beslut och exempelverifikat till redovisningskonsult |
| [docs/NEXT_STEPS.md](docs/NEXT_STEPS.md) | Vad som behövs för att gå vidare (API-dokumentation, konton, beslut) och rekommenderad ordning |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Implementerad arkitektur, tillståndsmaskiner, idempotens |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Beslutslogg (ADR) |
| [docs/LOGG.md](docs/LOGG.md) | Byggloggen: vad som byggdes när och vad granskningarna hittade |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Driftinstruktion och avvikelsekoder |
| [docs/SECURITY.md](docs/SECURITY.md) | Hotmodell, skydd, GDPR-checklista, kvarstående risker |
| [docs/API.md](docs/API.md) | HTTP-API med exempel |
| [docs/SPEC.md](docs/SPEC.md) | Ursprunglig teknisk specifikation (delvis föråldrad) |

**Dokumentationsregel:** allt som byggs dokumenteras i samma ändring. `npm run check` underkänner bygget om en kodfil, exporterad funktion, API-rutt, avvikelsekod, tabell, skript, adminkommando, miljövariabel eller testfil saknas i dokumentationen (`test/docs.test.ts`). Vad som ska uppdateras när står i [docs/INDEX.md](docs/INDEX.md).

## Utveckling

Kräver Node.js 22 eller senare.

```sh
npm install
npm run check    # typkontroll och tester (PGlite, ingen databas behövs)
npm run demo     # berättande genomkörning av hela flödet med simulerade system
npm run test:pg  # tester mot en temporär riktig Postgres (kräver Postgres 16-binärer)
npm run smoke    # rökprov: temporär Postgres, admin-verktyg, server, API, nedstängning
npm run build    # kompilera till dist/  (SMOKE_PROD=1 npm run smoke provar det kompilerade bygget)
docker compose up --build   # lokal körning med Postgres, se docs/DEPLOY.md
```

Köra tjänsten (se `src/app/config.ts` för alla variabler):

```sh
export DATABASE_URL=postgres://...
export API_KEY_PEPPER=$(openssl rand -hex 32)
export MASTER_KEYS="k1:$(openssl rand -hex 32)"
npm run admin -- create-tenant kund1 "Kund AB"
npm run admin -- set-accounts kund1 1930 1580 6570 2641   # kontonummer är exempel
npm run admin -- issue-key kund1
npm start
```

CI (`.github/workflows/ci.yml`) kör `npm ci` och `npm run check` vid push och pull request, samt ett separat jobb som kör `test/pg` mot en Postgres 16-container (`PG_TEST_URL`).
