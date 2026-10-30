# Testplan för Fortnox-sandboxen

Det här är planen för **första dagen** med ett Fortnox-utvecklarkonto och ett testbolag. Målet är att avgöra de få saker som styr hur adaptern ska byggas, innan någon adapterkod skrivs. Gör testerna i ordning: de tidiga avgör om de senare är relevanta.

**Viktigt om källan:** allt som står här om hur Fortnox beter sig är **hypoteser från minnet, inte verifierad kunskap** (jämför `docs/SPEC.md`, öppen fråga 9). Planens uppgift är att bekräfta eller avfärda dem. Skriv aldrig in en hypotes i koden som om den vore sann. Fyll i resultattabellerna och uppdatera sedan [ARCHITECTURE.md](ARCHITECTURE.md) och koden efter vad som faktiskt visade sig.

## Förberedelser

- [ ] Fortnox-utvecklarkonto och en integration (klient-id och hemlighet). Notera vilka behörigheter (scope) som krävs.
- [ ] Ett testbolag med: kunder, 3 till 5 fakturor i olika tillstånd (öppen, betald, delvis krediterad), bokföringskonton motsvarande de vi antar (bank 1930, clearing 1580, avgift 6570, ingående moms 2641 är **exempel**) och minst en verifikatserie.
- [ ] Nätverksåtkomst från utvecklingsmiljön till Fortnox-domänerna (idag blockerad i sessionen).
- [ ] Ett sätt att anropa API:t manuellt (curl eller Postman) **innan** någon kod skrivs.
- [ ] Läs Fortnox aktuella API-dokumentation och rate limit-regler och notera datum och version här: `__________`.

## Hur vi fyller i resultaten

Varje test har en tabell. Skriv **verkligt observerat beteende** (statuskod, svarsfält, konton), inte vad vi hoppades. Där tabellen säger "Konsekvens" står vilken del av koden resultatet avgör.

---

## Test 0: åtkomst och behörighet

**Mål:** kunna läsa och skriva som en integration, och förstå tokenlivslängd.

| Fråga | Hypotes (overifierad) | Observerat |
| --- | --- | --- |
| Hur får en handlare (kund) ge oss åtkomst? | OAuth2 med auktorisationskod, access token + refresh token | |
| Hur länge lever access token och refresh token? Roterar refresh token vid varje förnyelse? | Kort access token, refresh token som roterar | |
| Vilka behörigheter behövs för: läsa fakturor, registrera inbetalning, skapa kreditering, skapa verifikat? | Separata scope per område | |
| Vad händer när ett token är utgånget eller återkallat (statuskod och svarskropp)? | 401 | |
| Kan en handlare återkalla vår åtkomst, och hur märker vi det? | | |

**Konsekvens:** `createOAuth2TokenProvider` (`src/http/oauth.ts`) stödjer rotation via `onRefreshTokenRotated`. Rotation betyder att nya token **måste** sparas krypterat direkt (`connection`-tabellen, `npm run admin -- set-connection`). Om förnyelse kan förlora token (5xx efter att leverantören roterat) kräver det en omauktoriseringsrutin: se `needs_reauth` i `src/db/connections.ts`.

## Test 1: läsa fakturor på referens (`InvoiceReader`)

**Mål:** kunna hitta en faktura från Mondidos `reference` och få **färsk** status.

Vi behöver kunna fylla vår `Invoice` (se `src/domain/types.ts`): `id`, `reference`, `currency`, `total`, `vatTotal`, `balance` (obetalt), `creditedTotal`, `creditedVatTotal`, `status` (`open`/`paid`/`cancelled`).

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Vilket fält på fakturan innehåller handlarens ordernummer/referens, och går det att **söka** på det? | Något av fakturans referens-/ordernummerfält | |
| Finns det flera fält som kan innehålla referensen (olika webbshopintegrationer skriver olika)? | Ja, beror på integrationen | |
| Går det att söka på flera referenser i ett anrop, eller ett anrop per referens? | | |
| Hur räknar vi ut `balance` (obetalt) och `status`? Finns ett fält för det, eller måste inbetalningar summeras? | | |
| Finns `creditedTotal`/`creditedVatTotal` direkt, eller måste krediteringar (kreditfakturor) hittas och summeras? | | |
| Vilka belopp är i kronor med decimaler, och hur konverterar vi exakt till öre utan flyttalsfel? | Decimaltal i svaret | |
| Hur representeras moms: totalt momsbelopp, per rad, eller bara per momssats? | | |
| Är resultatet **färskt** direkt efter en ändring, eller finns fördröjning/cache? | | |
| Sökningen: är den versalkänslig, och trimmas blanksteg? | | |
| Rate limit: antal anrop per tidsenhet? Mät genom att skicka anrop tills det stoppar. | Begränsning per access token | |

**Konsekvens:** `findByReferences` byggs på resultatet. **Måste** klara `invoiceReaderContract` (`test/contracts/ports.contract.ts`): bara efterfrågade fakturor, färsk status, ingen läcka mellan kunder, giltiga belopp. Hittar vi inget sökbart fält för referensen kan matchning mot Fortnox inte automatiseras och hela upplägget måste omprövas.

## Test 2: registrera inbetalning på faktura, **det viktigaste testet**

**Mål:** förstå exakt vad som bokförs när en inbetalning registreras, så att verifikatet inte dubbelräknar något.

Vår motor skapar (a) `register_invoice_payment` per betalning och (b) ett verifikat per utbetalning som **krediterar clearingkontot** för betalningarna, debiterar banken med nettobeloppet och debiterar avgift och ingående moms. Det fungerar bara om inbetalningen på fakturan debiterar **clearingkontot** och inte banken. Gör så här:

1. Registrera för hand (via API) en inbetalning på en öppen testfaktura.
2. Hämta resulterande verifikat/bokföringsposter och skriv ner **vilka konton som debiteras och krediteras**.

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Vilket konto debiteras vid inbetalning? Styrs det av ett betalsätt/ett konto vi anger, eller av inställningar i bolaget? | Det finns ett betalsätt med ett kopplat konto | |
| Kan vi **ange** vilket konto (clearing) som ska debiteras per inbetalning? | | |
| Vilket konto krediteras (kundfordringar), och sker det automatiskt? | 1510 (kundfordringar) | |
| Skapas bokföringen direkt eller först när inbetalningen "bokförs"/"godkänns" i ett separat steg? | Ett separat bokföringssteg kan finnas | |
| Går det att registrera en inbetalning på ett **annat belopp än fakturans** (delbetalning)? Vad händer med fakturan? | | |
| Går det att registrera en inbetalning på en **redan betald** faktura? (Vi förväntar oss ett tydligt fel.) | | |
| Vilket datum får inbetalningen: det vi anger, eller dagens? Påverkas det av stängd period? | | |
| Vad är **svaret** efter att inbetalningen skapats: vilket id kan vi spara som `externalId`? | | |

**Konsekvens:**
- Debiteras **banken** direkt av inbetalningen blir vårt verifikat fel: banken blir dubbelräknad. Då ska verifikatet bara bokföra avgifterna och eventuellt flytta mellan konton. **`buildVoucher` i `src/engine/reconcile.ts` ska i så fall ändras innan något annat byggs.**
- Debiteras ett konto vi inte styr behöver kontoplanen per kund (`AccountMapping`) och verifikatet anpassas.
- Finns ett separat bokföringssteg måste adaptern göra det, och de två stegen måste vara idempotenta var för sig.

## Test 3: kreditering (återbetalning och delkreditering)

**Mål:** förstå hur en helkreditering och delkreditering skapas och hur moms fördelas.

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Hur skapas en kreditering: kreditfaktura kopplad till originalfakturan, eller något annat? | Kreditfaktura som refererar till originalet | |
| Går det att kreditera ett **belopp** (delkreditering) och ange moms, eller krediteras rader? | | |
| Hur fördelar Fortnox moms på en delkreditering? **Stämmer det med vår fördelning** (`splitCreditVat`: proportionellt mot kvarvarande moms och netto)? Testa 500 kr av en faktura på 1 490 kr med 298 kr moms: vi förväntar netto 400,00 och moms 100,00. | | |
| Vad händer med fakturans saldo och status efter kreditering? Går ett kreditbelopp som överstiger återstående krediterbart att skapa? | | |
| Hur betalas ett kreditbelopp ut/bokförs när återbetalningen dras från en utbetalning? Vilket konto? | | |
| Vilket id får vi tillbaka (`externalId`)? | | |

**Konsekvens:** beslut D3 i [BESLUT_REDOVISNING.md](BESLUT_REDOVISNING.md) (kreditfaktura eller korrigerad inbetalning). Avviker momsfördelningen från vår måste `splitCreditVat` anpassas, annars bokförs fel moms.

## Test 4: verifikat

**Mål:** kunna skapa vårt balanserade verifikat.

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Vilka fält krävs: verifikatserie, datum, beskrivning, rader med konto/debet/kredit? | Verifikatserie krävs | |
| Vilken serie ska användas för våra verifikat, och finns den? Kan vi skapa en egen? | | |
| Avvisas ett verifikat som inte balanserar, med vilken statuskod? | | |
| Går det att skriva en **referens/beskrivning** som innehåller vår idempotensnyckel och senare **söka på den**? | | |
| Hur representeras belopp (decimaler) och hur hanteras avrundning? | | |
| Kan vi koppla en kostnadsställe/projekt? (Behövs det per kund?) | | |
| Vad är **svaret**: verifikatnummer och serie (blir `externalId`)? | | |

**Konsekvens:** verifikatserien blir kundkonfiguration (idag saknas den i `AccountMapping`). Att kunna söka på en referens är det som gör att **`verify`-hooken** (se Test 6) går att bygga.

## Test 5: perioder, stängda år och spärrar

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Vad händer när vi bokför i en **låst period** eller ett stängt räkenskapsår? Statuskod och meddelande | Fel | |
| Är det ett permanent fel (kräver mänsklig åtgärd) eller kan det lösa sig? | Permanent tills perioden öppnas | |
| Kan en faktura vara spärrad för ändring, och hur ser det ut? | | |

**Konsekvens:** avgör `retryable` och `notApplied` för dessa fel (Test 7).

## Test 6: idempotens och `verify`, det avgörande för säkerheten

Skyddsgatewayen (`GuardedLedgerGateway`) ser till att ett kommando aldrig skickas om när utfallet är okänt. Utan en **`verify`-hook** kräver varje osäkert utfall en människa. Med en kan systemet själv avgöra.

| Fråga | Hypotes | Observerat |
| --- | --- | --- |
| Går det att skriva vår idempotensnyckel (eller ett id härlett ur den) i ett fält på inbetalningen/verifikatet/krediteringen? Vilket fält, vilken maxlängd? | Ett fritextfält eller referensfält finns | |
| Går det att **söka** på det fältet efteråt (för varje kommandotyp)? | | |
| Är sökningen **omedelbart konsistent** (hittar vi det vi nyss skrev direkt)? Om inte: hur lång fördröjning? | | |
| Stödjer API:t en egen idempotens-header? | Antagligen inte | |

**Så provar vi förlorat svar:** skapa en inbetalning, kasta bort svaret, och slå upp om den finns. Gör det för alla tre kommandotyperna.

**Konsekvens:** går det att söka konsistent kan en `verify` implementeras (`GuardedOptions.verify`): `found: true` med externt id om det finns, `found: false` **bara** om det säkert inte finns, annars kasta fel. Går det inte kommer varje osäkert utfall kräva en människa (det är säkert, men ger manuellt arbete).

## Test 7: felklassning

Fyll i tabellen utifrån verkliga svar. Det här är det som avgör `retryable` och `notApplied` i `LedgerError` och därmed om skyddsgatewayen släpper eller låser ett kommando.

**Regel:** `notApplied: true` får bara sättas när det är **säkert** att inget bokfördes. Osäkert = `false`.

| Situation | Statuskod / felform | Utfördes något? | Föreslagen klassning | Observerat |
| --- | --- | --- | --- | --- |
| Valideringsfel (fel belopp, saknat fält) | 4xx | Nej | `retryable: false`, `notApplied: true` | |
| Faktura finns inte | | Nej | `false`, `true` | |
| Faktura redan betald | | Nej | `false`, `true` | |
| Låst period | | Nej | `false`, `true` | |
| Utgånget token | | Nej | `false`, `true`, `authExpired` (förnya och försök en gång) | |
| Rate limit | 429 + `Retry-After`? | Nej | `true`, `true`, `retryAfterMs` | |
| Serverfel | 5xx | **Okänt** | `true`, **`false`** | |
| Timeout | | **Okänt** | `true`, **`false`** | |
| Anslutning bröts under svar | | **Okänt** | `true`, **`false`** | |
| Ingen anslutning kunde upprättas | | Nej | `true`, `true` | |

**Konsekvens:** `classifyHttpFailure` i `src/http/errors.ts` är redan byggd efter den här tabellen. Avviker Fortnox (t.ex. returnerar 500 för ett valideringsfel) måste klassningen anpassas för just Fortnox. Det är en felklassning som saknas, inte en allmän regel.

## Test 8: volym och takt

| Fråga | Observerat |
| --- | --- |
| Rate limit (anrop/sekund), mätt: hur många anrop innan avslag? | |
| Hur lång tid tar ett inbetalningsanrop, ett verifikatanrop, en fakturasökning? | |
| Hur många fakturor kan sökas per anrop? | |
| Är gränsen per token (alltså per kund) eller per integration? | |

**Konsekvens:** `createRateLimiter` (`src/http/rateLimiter.ts`) konfigureras efter detta. En utbetalning med 200 rader blir ca 200 inbetalningar plus ett verifikat; vi måste veta att det går inom rimlig tid.

## Test 9: kantfall

Gör vart och ett för hand i sandboxen och notera utfallet.

- [ ] Betalning på **0,01 kr** och på mycket stort belopp.
- [ ] Faktura i **annan valuta** än SEK.
- [ ] Kreditering som överstiger faktura.
- [ ] Två fakturor med **samma referens**.
- [ ] Referens med blanksteg och blandade versaler.
- [ ] Moms med ören som inte går jämnt upp (t.ex. 1,99 kr med 25 %).
- [ ] Avrundning: vilken moms ger en delkreditering på 333,33 kr av tre lika delar på en faktura på 1 000 kr?

---

## När adaptern byggs: färdiga tester att klara

Koppla in adaptern i de färdiga kontraktssviterna (`test/contracts/ports.contract.ts`). De bevisar de egenskaper resten av systemet förlitar sig på. Skiss (anpassa fabrikerna till sandboxen):

```ts
// test/contracts/fortnox.contract.test.ts (skiss, finns inte än)
import { describe } from 'vitest';
import { invoiceReaderContract, ledgerGatewayContract } from './ports.contract.js';

describe.skipIf(!process.env.FORTNOX_SANDBOX)('Fortnox (sandbox)', () => {
  invoiceReaderContract('Fortnox InvoiceReader', async () => ({
    reader: /* din FortnoxInvoiceReader */,
    seed: async (tenantId, invoices) => { /* skapa fakturor i sandboxen */ },
    update: async (tenantId, id, patch) => { /* ändra en faktura i sandboxen */ },
  }), () => [/* tre fakturor med olika referenser */]);

  ledgerGatewayContract('Fortnox LedgerGateway', async () => ({
    gateway: /* new GuardedLedgerGateway(din FortnoxGateway, store, { clock, verify }) */,
    prepare: async (tenantId, command) => { /* skapa en öppen faktura som kommandot kan betala */ },
    appliedCount: (tenantId, key) => { /* räkna hur många gånger nyckeln bokförts i Fortnox */ },
  }));
});
```

**Klart när:** alla kontraktssviter är gröna mot sandboxen, alla tester ovan är ifyllda, de två riskerna i [NEXT_STEPS.md](NEXT_STEPS.md) är avgjorda (dubbelräknad bank, idempotens/`verify`), och en pilotkund har kört i dry_run med granskade förslag ([BESLUT_REDOVISNING.md](BESLUT_REDOVISNING.md)). **Först därefter** sätts någon kund i `live`.

## Beslut som provkörningen ger

| Resultat | Kodändring |
| --- | --- |
| Inbetalning debiterar banken direkt | Ändra `buildVoucher`: bara avgifter (och ev. clearing) |
| Konto styrs av betalsätt | Lägg betalsätt/konto i kundens konfiguration |
| Referensen kan inte sökas | Omprövning av matchningen |
| Referensen kan sökas konsistent | Bygg `verify` i adaptern |
| Fortnox klassar fel annorlunda | Anpassa `classifyHttpFailure` för Fortnox |
| Momsfördelning avviker | Anpassa `splitCreditVat` |
| Verifikatserie krävs | Lägg serie i `AccountMapping` |
