# Datakontrakt: vad vi behöver från Mondido

**Till:** Mondidos utvecklare och produktansvariga. **Syfte:** vi bygger en fristående tjänst som automatiskt bokför och stämmer av Mondido-utbetalningar mot fakturor i kundens affärssystem. Det här dokumentet beskriver exakt vilka data vi behöver från Mondido, i vilket format, och vilka frågor vi behöver få svar på innan vi skriver adaptern. Allt här är tillräckligt för att bedöma om Mondidos API räcker eller om något måste byggas.

Dokumentet beskriver vårt interna, normaliserade format (se `src/domain/types.ts`). Adaptern översätter Mondidos format till det. Allt som saknas i Mondidos data blir en manuell avvikelse hos kunden, så luckor här kostar direkt i drift.

## 1. Det vi behöver få ut: en utbetalning

```json
{
  "id": "UTB-2026-10-28-001",
  "date": "2026-10-28",
  "currency": "SEK",
  "netAmount": 227500,
  "lines": [
    { "type": "payment", "id": "TX-1001", "reference": "ORDER-1001", "amount": 149000, "currency": "SEK",
      "fee": { "net": 3120, "vat": 780 } },
    { "type": "payment", "id": "TX-1002", "reference": "ORDER-1002", "amount": 59900,  "currency": "SEK",
      "fee": { "net": 1360, "vat": 340 } },
    { "type": "refund",  "id": "RF-0007", "reference": "ORDER-1001", "amount": 50000,  "currency": "SEK" },
    { "type": "fee",     "id": "FEE-77",  "currency": "SEK", "fee": { "net": 640, "vat": 160 } }
  ]
}
```

(Belopp i exemplet är påhittade. `netAmount` ska vara den summa som faktiskt betalas ut till handlaren.)

### Fält på utbetalningen

| Fält | Krav | Varför |
| --- | --- | --- |
| `id` | Unikt och **stabilt** för handlaren. Samma utbetalning får aldrig byta id | Bokföringen är idempotent på id. Byter id = ny bokföring = dubbelbokning |
| `date` | Utbetalningsdatum, `YYYY-MM-DD`, svensk tid | Datum på inbetalning och verifikat |
| `currency` | ISO 4217, **en** valuta per utbetalning | Blandade valutor avvisas idag (se fråga 9) |
| `netAmount` | Heltal i **minsta enhet** (öre), det som faktiskt betalas ut | Kontrollsumma: raderna måste summera exakt till detta, annars avvisas hela utbetalningen |
| `lines` | Alla rader som ingår, inga som saknas | En saknad rad ger summafel |

### Radtyper

| Typ | Fält | Betydelse |
| --- | --- | --- |
| `payment` | `id`, `reference`, `amount`, `currency`, `fee?` | En betalning från en kund. `amount` är **brutto** (vad kunden betalade). `fee` är avgiften Mondido drar på just den betalningen, uppdelad i `net` och `vat` |
| `refund` | `id`, `reference`, `amount`, `currency` | En återbetalning till kund (helt eller delvis). `amount` är det återbetalda beloppet, positivt tal |
| `fee` | `id`, `currency`, `fee {net, vat}` | En avgift som inte hör till en enskild betalning (t.ex. månadsavgift, korrigering) |

**Regler som gäller alla rader**
- `id` är unikt inom utbetalningen och **stabilt**: samma rad får aldrig byta id mellan hämtningar.
- Belopp är heltal i minsta enhet och aldrig negativa (riktningen avgörs av radtypen).
- `currency` på raden är samma som utbetalningens.
- Utbetalt belopp = summa av `payment.amount − payment.fee` − summa av `refund.amount` − summa av fristående `fee`. Det måste stämma exakt, annars avvisas utbetalningen och en människa får titta på den.

## 2. Referensen: den viktigaste punkten

`reference` är vad som binder en betalning till **rätt faktura** i kundens affärssystem. Vi matchar på exakt referens och exakt belopp, och gissar aldrig.

Det vi måste få veta:

1. **Vilket fält hos Mondido** innehåller ordernumret/referensen som handlarens webbshop skickade in vid betalningen?
2. Hamnar det **samma värde** på fakturan i affärssystemet (t.ex. som fakturareferens, ordernummer eller OCR)? Det avgörs av den integration som skapar fakturan, inte av Mondido, men vi måste veta vilket fält som är gemensamt.
3. Kan en handlare skicka **samma referens två gånger** (t.ex. vid ny betalningsförsök efter avbruten betalning)? Då blir matchningen tvetydig och går till manuell hantering.
4. Är referensen **versalkänslig**, kan den innehålla blanksteg, och har den max längd?

## 3. Hur vi hämtar: kontraktet mot Mondido

Vi hämtar med polling (webhooks är ett bra tillägg, inte ett krav). Adaptern måste uppfylla `PayoutSource` (se `src/ports/sources.ts`) och klara den färdiga testsviten i `test/contracts/ports.contract.ts`:

| Krav | Förklaring |
| --- | --- |
| **Lista nya utbetalningar sedan en cursor** | Vi sparar en cursor och hämtar bara det nya. Cursor kan vara ett löpnummer, tidsstämpel eller sidtoken, men måste vara stabil |
| **Inget tappas, inget dubbleras** | Samma anrop med samma cursor ger samma svar. Utbetalningar får inte försvinna mellan hämtningar. Dubbletter är OK (vi är idempotenta) men hellre än tappade |
| **Hämta en enskild utbetalning på id** | För att kunna återuppta en delvis avstämd utbetalning |
| **Per handlare** | Varje handlare har egna uppgifter. En handlare får aldrig kunna se en annans utbetalningar |
| **Ändras en utbetalning efteråt** | Vi måste få veta hur. Helst: **rapporterade utbetalningar är oföränderliga** och rättelser kommer som nya rader (justering/återbetalning) i en senare utbetalning. Muteras en rad ändrar vi inget automatiskt: raden flaggas för manuell granskning |

## 4. Åtkomst

| Fråga | Behöver vi veta |
| --- | --- |
| Autentisering | API-nyckel, OAuth eller annat? Per handlare (merchant) eller en partnernyckel som kan agera för flera? Hur får en handlare ge oss åtkomst (och återkalla den)? |
| Rate limits | Anrop per sekund/minut, per nyckel eller per partner, och vad som returneras vid överträdelse (statuskod, `Retry-After`) |
| Felkoder | Hur skiljer vi tillfälligt fel (försök igen) från permanent (ogiltig begäran)? |
| Sandbox | Finns en testmiljö med testhandlare och möjlighet att skapa testutbetalningar? **Det avgör hur snabbt vi kan bygga** |
| Historik | Hur långt bakåt kan vi hämta utbetalningar? |
| SLA/underhåll | Tider då API:t är nere, versionering, hur ändringar aviseras |

## 5. Frågor till Mondido (svara gärna direkt i listan)

**Avgifter och utbetalningar**
1. Dras avgiften **per betalning** innan utbetalning (nettoutbetalning), eller faktureras den **separat** (t.ex. månadsvis)? Vår modell förutsätter att avgiften dras i utbetalningen. Faktureras den separat behöver vi en annan hantering.
2. Är Mondidos avgifter **momspliktiga**? Hur redovisas momsen på avgiften per rad (netto och moms var för sig)? Vi behöver `net` och `vat` separat, och vi bokför ingående moms utifrån det.
3. Återförs avgiften helt eller delvis när en betalning **återbetalas**? Idag modellerar vi inte avgiftsåterföring på återbetalningar. Händer det behöver modellen utökas.
4. Förekommer **återhållna belopp** (reserver, rolling reserve)? Hur syns de i utbetalningen?
5. Hur hanteras **chargebacks/tvister**? Som negativ rad, egen radtyp, eller egen utbetalning? De modelleras inte idag.
6. Kan en utbetalning vara **negativ** (återbetalningar och avgifter större än betalningar)? Vi hanterar det, men vill veta om det händer.

**Data och format**
7. Finns **delåterbetalningar** och hur identifieras de mot ursprungsbetalningen? (Vi matchar återbetalningen mot fakturan via `reference`.)
8. Är alla belopp i **heltal i minsta enhet**, eller decimaltal? Hur avrundas moms på avgifter?
9. Kan **en utbetalning innehålla flera valutor**? Idag avvisas sådana utbetalningar. Har handlare utbetalningar i EUR eller annan valuta behöver vi avgöra hur de ska bokföras.
10. Vilken **tidszon** har datum och tidsstämplar, och vilket datum gäller för "utbetalt" (initierat, avräknat, mottaget)?
11. Är rad-id och utbetalnings-id **stabila** över tid och unika per handlare?

**Process**
12. Hur snabbt efter en betalning finns den i en utbetalning? Kan en betalning som ingått i en utbetalning senare flyttas till en annan?
13. Hur ska vi få veta att **ett API-fel** på er sida kräver åtgärd av oss?
14. Finns webhooks för "ny utbetalning" och "utbetalning ändrad"?
15. Vem på Mondido är **teknisk kontakt** för partnerintegrationen?

## 6. Testdata vi behöver i sandboxen

För att kunna bevisa att adaptern klarar verkligheten, skapa (eller låt oss skapa) minst:

1. En vanlig utbetalning med flera betalningar med avgift.
2. En utbetalning med en helåterbetalning.
3. En utbetalning med en **delåterbetalning** (flera i rad på samma betalning).
4. En betalning och en återbetalning på **samma order** i samma utbetalning.
5. En utbetalning med en **fristående avgift**.
6. En utbetalning där återbetalningar och avgifter är större än betalningarna (negativt netto).
7. Två betalningar med **samma referens** (tvetydig matchning).
8. En betalning med **okänd referens** (ingen faktura finns).
9. En utbetalning i **annan valuta** än SEK.
10. En chargeback/tvist, om det finns.
11. Beloppsfall: 0,01 kr, belopp med många decimaler i moms, och stora belopp.
12. Två handlare med överlappande ordernummer (för att bevisa isolering).

## 7. Så avgör vi att adaptern är klar

1. Den klarar `payoutSourceContract` i `test/contracts/ports.contract.ts` (ingen förlorad utbetalning, inga dubbletter, ingen läcka mellan handlare, summor som hänger ihop).
2. Alla tolv testfallen ovan ger förväntat utfall i motorn (se `test/scenarios/golden.test.ts` för hur samma fall ser ut för simulerad data).
3. En pilotkund kör i dry_run en tid och dess redovisningskonsult har granskat förslagen utan anmärkning.
