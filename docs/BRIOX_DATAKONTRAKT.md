# Briox: vad vi behöver veta innan en adapter

**Status:** ingen adapter finns, och **ingenting här är verifierat mot Briox egen dokumentation**. Utvecklardokumentationen gick inte att nå från byggmiljön (sökning gav inga träffar och nätverket tillåter bara vissa domäner). Allt nedan är därför frågor att besvara, inte fakta. Svara på dem med Briox utvecklardokumentation och ett testkonto, och fyll sedan i förmågorna i adaptern (`LedgerCapabilities` i `src/ports/ledger.ts`).

Briox är ett bokföringssystem och passar som tredje affärssystem bredvid Fortnox och Spiris. Adaptern implementerar `LedgerGateway` (skriva), `InvoiceReader` (läsa fakturor) och `LedgerProvider` (förmågor och anslutningstest) och ska klara kontraktssviterna i `test/contracts/ports.contract.ts`. Namnet i tabellen `connection` är `briox` (redan känt av onboardingen, se `LEDGER_PROVIDERS`).

## Frågor som avgör adaptern

| # | Fråga | Avgör |
| --- | --- | --- |
| 1 | Hur autentiserar en integration, och hur länge gäller en token? Kan kunden godkänna åtkomst själv (OAuth) eller måste vi få en nyckel av dem? | Hur kunden kopplar sig (`src/http/oauth.ts` eller manuell nyckel) och `needs_reauth` |
| 2 | Finns det ett sandbox- eller testbolag, och hur skaffas ett utvecklarkonto? | Om vi kan provköra innan en kund är inblandad |
| 3 | Går det att söka kundfaktura på **referens** (OCR, ordernummer eller fritt fält), och vilket fält? | `searchByReference`. Utan det går ingenting att matcha automatiskt |
| 4 | Går det att registrera en inbetalning på en faktura via API, och minskar det fakturans saldo? | `register_invoice_payment` |
| 5 | Vad bokförs automatiskt när en inbetalning registreras (bank- och kundfordranskonto)? Bokförs clearingkontot? | Samma risk som i [FORTNOX_TESTPLAN.md](FORTNOX_TESTPLAN.md): dubbelräknad bank om vårt verifikat också krediterar clearing |
| 6 | Går det att kreditera en betald faktura helt eller delvis? | `creditInvoice` och återbetalningar |
| 7 | Går det att skapa ett verifikat med flera rader och egen verifikatserie? Kan vi skriva en egen referens på det? | `postVoucher` och `verifyByReference` |
| 8 | Finns idempotens (en nyckel som gör att samma anrop inte körs två gånger)? | `idempotentWrites`. Utan den bär skyddsgatewayen hela ansvaret |
| 9 | Kan vi avgöra efteråt om ett anrop utfördes, genom att söka på en referens vi skrev dit? | `verifyByReference` och om osäkra utfall kan avgöras automatiskt |
| 10 | Vilka fel är **säkert** att ett anrop inte utfördes (till exempel validering eller 4xx), och vilka är osäkra (timeout, 5xx)? | Felklassningen (`notApplied`) i `src/http/errors.ts` |
| 11 | Vilka rate limits gäller, och kommer `Retry-After` med? | Konfiguration av `src/http/rateLimiter.ts` |
| 12 | Hur hanteras momskoder, kostnadsställen och räkenskapsår som är stängda? | Om verifikat kan nekas av skäl vi måste förklara för kunden |
| 13 | Kan en kund koppla flera företag, och hur väljer vi rätt? | Vad en koppling identifieras av |
| 14 | Villkor: kräver Briox partneravtal eller godkännande innan vi kan använda API:t i produktion? | Tidplan och avtal |

## Så går vi vidare

1. Besvara frågorna ovan mot Briox dokumentation. Lägg svaren här och i `docs/DECISIONS.md`.
2. Provkör bokföringsmodellen för hand i ett testbolag (samma upplägg som Fortnox-testplanen).
3. Bygg läsdelen (`InvoiceReader` och anslutningstestet) först, eftersom den är ofarlig.
4. Bygg skrivdelen först när felklassningen och förmågorna är bevisade mot kontraktssviterna.

Kleer ingår inte här: så vitt vi vet är det inte ett bokföringssystem utan en tjänst för utlägg och kort som själv bokför till affärssystem. Det är en annan sorts källa än utbetalningar och hör till en senare skiva.
