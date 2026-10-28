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

Tidigt skede. Funktionsbeskrivningen ovan bygger på informationen på webbplatsen. Det som finns i repot:

- `docs/SPEC.md`: teknisk specifikation för första skivan (Mondido till Fortnox).
- `src/engine/reconcile.ts`: avstämningsmotorn, en ren funktion utan nätverksanrop.
- `src/domain/`: normaliserade typer och beloppshantering (heltal i minsta enhet).
- Adaptrar mot Mondido och Fortnox saknas ännu.

## Utveckling

Kräver Node.js 22 eller senare.

```sh
npm install
npm run check   # typkontroll och tester
```
