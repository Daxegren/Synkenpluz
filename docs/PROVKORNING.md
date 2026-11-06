# Provkörning med filer

Provkörningen visar hur stor del av en handlares utbetalningar som går att stämma av automatiskt, utan att något system kopplats och utan att något sparas. Handlaren (eller du) tar två filer: en **utbetalningsfil** från betalleverantören och en **fakturafil** från affärssystemet, och får träffsäkerhet, vanligaste avvikelser och vad som är fel i filerna.

Det är avsett som onboarding- och säljverktyg, och som sättet att komma igång med en pilot innan Mondido- och Fortnox-adaptrarna finns. Tre sätt att köra den:

| Sätt | Hur |
| --- | --- |
| Webbgränssnittet | Sidan *Provkör med filer* på `/app` (kräver nyckel med roll `operator` eller högre) |
| Terminalen | `npm run preview -- utbetalningar.csv fakturor.csv [--partial] [--payout-mapping fil.json] [--invoice-mapping fil.json]` |
| API | `POST /v1/preview`, se [API.md](API.md) |

Prova med exempelfilerna: `npm run preview -- docs/exempel/utbetalningar.csv docs/exempel/fakturor.csv`.

## Regeln: vi gissar aldrig

Allt som är tvetydigt avvisas med en förklaring, i stället för att tolkas. En bokföring får aldrig bero på vilket av två sätt att läsa en fil vi råkade välja.

- En fil med fel antal kolumner på en rad, en ostängd citering eller text efter ett avslutande citattecken **avvisas helt**.
- Belopp: `125`, `125,5`, `125.50`, `1 234,56` godtas. `1.234` och `1,234.56` avvisas, eftersom `.` och `,` då inte går att skilja som decimaltecken och tusentalsavgränsare. Högst två decimaler.
- Datum: bara riktiga kalenderdatum. `ÅÅÅÅ-MM-DD` (klockslag efter datumet ignoreras) eller, med `dateFormat: "dmy"`, `DD.MM.ÅÅÅÅ`. Ordningen avgörs av inställningen, aldrig av innehållet.
- **En utbetalning läses helt eller inte alls.** Har en enda rad ett problem utelämnas hela utbetalningen och problemet rapporteras.
- **Utbetalningens nettobelopp krävs i filen** (`payout_net`). Räknade vi fram det själva skulle summakontrollen alltid stämma och vara meningslös.
- Samma faktura-id på två rader: ingen av raderna används.
- Okänd radtyp eller fakturastatus avvisas. Ange leverantörens värden med `typeValues` / `statusValues`.
- Negativa belopp: en betalning eller avgift med minustecken avvisas (kan vara något annat än vi tror). En återbetalning får skrivas med eller utan minustecken.

## Utbetalningsfilen (en rad per transaktion)

Standardkolumner (skiftlägesokänsliga). Avgränsare avgörs av rubrikraden (`;` `,` eller tabb) om inget anges.

| Kolumn | Krävs | Innehåll |
| --- | --- | --- |
| `payout_id` | ja | Utbetalningens id, lika på alla dess rader |
| `payout_date` | ja | Utbetalningsdatum, lika på alla dess rader |
| `payout_net` | ja | Beloppet som betalas ut efter avgifter och återbetalningar, lika på alla dess rader (får vara negativt) |
| `currency` | ja | Tre bokstäver, t.ex. `SEK` |
| `line_id` | ja | Transaktionens id, unikt inom utbetalningen |
| `type` | ja | `payment`, `refund` eller `fee` (andra värden via `typeValues`) |
| `reference` | betalning och återbetalning | Referensen som binder ihop raden med fakturan |
| `amount` | betalning och återbetalning | Brutto |
| `fee_net`, `fee_vat` | valfria på betalning, krävs på `fee` | Avgift exklusive moms och momsen på den, båda icke-negativa |

Radtyper som känns igen utan inställning: `payment` (`sale`, `capture`, `purchase`, `betalning`), `refund` (`credit`, `återbetalning`), `fee` (`avgift`).

## Fakturafilen (en rad per faktura)

| Kolumn | Krävs | Innehåll |
| --- | --- | --- |
| `invoice_id` | ja | Fakturans id i affärssystemet |
| `reference` | ja | Samma referens som betalleverantören anger |
| `currency` | ja | Tre bokstäver |
| `total`, `vat_total`, `balance` | ja | Totalt, varav moms, och obetalt belopp |
| `credited_total`, `credited_vat_total` | nej (0) | Redan krediterat |
| `status` | nej | `open`, `paid` eller `cancelled` (`obetald`, `betald`, `makulerad` m.fl.). Saknas kolumnen blir fakturan öppen om saldot är över noll, annars betald. En makulerad faktura måste anges |

## Egna kolumnnamn och format

Har leverantörens eller affärssystemets fil andra rubriker skickas en mappning (JSON). Allt utom `columns` är valfritt:

```json
{
  "columns": { "payoutId": "Settlement", "payoutDate": "Datum", "payoutNet": "Netto", "currency": "Valuta",
               "lineId": "TxId", "type": "Typ", "reference": "Order", "amount": "Brutto", "feeNet": "Avgift", "feeVat": "Moms" },
  "delimiter": ";",
  "dateFormat": "dmy",
  "amountsInMinorUnits": true,
  "typeValues": { "payment": ["köp"], "refund": ["retur"], "fee": ["kostnad"] }
}
```

Fakturafilens kolumnnycklar är `invoiceId`, `reference`, `currency`, `total`, `vatTotal`, `balance`, `creditedTotal`, `creditedVatTotal`, `status`, och den har `statusValues` (`open`, `paid`, `cancelled`) i stället för `typeValues`. `amountsInMinorUnits` betyder att beloppen redan är heltal i öre.

## Problem som rapporteras

| Kod | Betydelse |
| --- | --- |
| `FILE_INVALID` | Filen är trasig (fel antal kolumner, ostängd citering, tom, för stor) och lästes inte alls |
| `COLUMN_MISSING` | En obligatorisk kolumn saknas. Meddelandet listar rubrikerna som hittades |
| `INVALID_VALUE` | Ett värde går inte att läsa säkert (belopp, datum, valuta, saknat id eller referens) |
| `UNKNOWN_TYPE`, `UNKNOWN_STATUS` | Okänd radtyp eller fakturastatus |
| `INCONSISTENT_PAYOUT` | Raderna i en utbetalning har olika datum eller nettobelopp |
| `DUPLICATE_LINE`, `DUPLICATE_INVOICE` | Samma rad-id i en utbetalning, eller samma faktura-id på flera rader |
| `NEGATIVE_AMOUNT` | Negativ betalning eller avgift |
| `PAYOUT_OMITTED` | Följdnotis: utbetalningen utelämnas eftersom en av dess rader har ett problem. Räknas inte som ett eget problem |

## Hur resultatet räknas

Utbetalningarna körs i datum- och id-ordning med samma avstämningsmotor som i drift, och varje utbetalnings resultat tillämpas på fakturorna innan nästa. Två utbetalningar mot samma faktura blir därför inte båda "klara". Resultatet är det som *skulle* hända: inga kommandon köas och inget skickas till något system. Kontona i verifikatet är exempelkonton (BAS) om inget annat anges; de påverkar inte träffsäkerheten.

## Begränsningar

- Fakturafilen är en ögonblicksbild. Provkörningen vet inget om fakturor som saknas i filen eller ändrats sedan den togs.
- Högst 5 MB per fil, 50 000 rader och 60 kolumner. Beräkningen sker i en enda förfrågan.
- Provkörningen **ersätter inte** en riktig koppling: den visar träffsäkerheten, men bokför inget.
- Formatet är vårt eget. Leverantörens riktiga exportformat är inte känt än (Mondidos filformat saknas), så en mappning kan behövas. Ett riktigt exempel från en handlare gör att vi kan lägga in en färdig mappning.

## Integritet

Filerna innehåller kunduppgifter och belopp. De läses in i förfrågan, räknas på och **sparas aldrig**: ingen databas anropas, ingenting loggas och ingen revisionspost skrivs (revisionsloggen innehåller bara id:n och antal). I webbgränssnittet läses filerna i webbläsaren och skickas bara till samma server.
