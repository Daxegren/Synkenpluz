# Nästa steg

Status per 2026-10-28: den tekniska kärnan för första skivan (utbetalningsavstämning, Mondido till Fortnox) är byggd och testad mot både PGlite och en riktig Postgres 16. Det som saknas är **allt som kräver information eller konton utanför repot**. Det här dokumentet listar vad som behövs och i vilken ordning det är klokast att ta det.

Se [README.md](../README.md) för vad som finns, [ARCHITECTURE.md](ARCHITECTURE.md) för hur det hänger ihop och [RUNBOOK.md](RUNBOOK.md) för drift.

## Vad systemet kan idag

Kör `npm run demo` för en berättande genomkörning med simulerade system. Kör `npm run smoke` för att se den riktiga tjänsten (server, administrationsverktyg, API, nedstängning) starta mot en temporär Postgres.

Det systemet **inte** kan: prata med Mondido eller Fortnox. Allt mot omvärlden går via gränssnitt i `src/ports/` som idag bara har simulerade implementationer (`src/gateways/`). Tjänsten startar med platshållare som misslyckas tydligt per kund.

## Underlag som är färdiga att skicka vidare

| Dokument | Skickas till | Svarar på |
| --- | --- | --- |
| [MONDIDO_DATAKONTRAKT.md](MONDIDO_DATAKONTRAKT.md) | Mondidos utvecklare | Rad 1 nedan: vilka data finns och i vilket format |
| [FORTNOX_TESTPLAN.md](FORTNOX_TESTPLAN.md) | Den som har sandboxen | Rad 2 och riskerna nedan (dubbelräknad bank, idempotens) |
| [BESLUT_REDOVISNING.md](BESLUT_REDOVISNING.md) | Redovisningskonsult | Rad 4 och 5 nedan samt gallringstider |
| [DEPLOY.md](DEPLOY.md) | Den som driftsätter | Hur tjänsten körs och sätts i skarp drift |

## Det jag behöver från dig (blockerar adaptrarna)

| # | Vad | Varför | Vem |
| --- | --- | --- | --- |
| 1 | **Mondidos API-dokumentation** för transaktioner, återbetalningar och utbetalningar/settlements | Avgör om utbetalningar med avgifter per rad finns, och hur `Payout`-typen ska fyllas. Utan det är hela PayoutSource-adaptern en gissning | David / Mondido |
| 2 | **Fortnox utvecklarkonto och sandbox** (klient-id och hemlighet, testbolag) | Gateway (skapa inbetalning, kreditering, verifikat) och InvoiceReader. Dokumentationen och rate limits måste verifieras mot aktuell version | David |
| 3 | **Nätverksåtkomst** i sessionen till Fortnox- och Mondido-domäner | Så att jag kan testa mot sandboxarna. Idag blockeras alla externa domäner utom pakethanteraren | David |
| 4 | **Beslut: hur ska avgifter bokföras?** Standardkontoplan eller konfigurerbart per kund? | Idag fyra konton per kund (bank, clearing, avgift, ingående moms) | Redovisningskonsult |
| 5 | **Beslut: kreditfaktura eller korrigerad inbetalning vid återbetalning?** | Motorn skapar `credit_invoice`, men hur det ska se ut i Fortnox är inte avgjort | Redovisningskonsult |
| 6 | **Namn, domän och bolagsform** för det fristående varumärket | Behövs för kundavtal, PUB och utvecklarkontot hos Fortnox | David |

## Viktig risk att verifiera först mot Fortnox

Verifikatet som motorn bygger **krediterar clearingkontot** för betalningarna. Om Fortnox själv bokför clearing/bank när man registrerar en inbetalning på en faktura kan banken bli **dubbelräknad**. Det går inte att avgöra utan att provköra mot sandboxen. Det ska göras före allt annat i Fortnox-adaptern, för det kan ändra vad `post_voucher` ska innehålla (eller om motorn bara ska bokföra avgifterna).

Likaså: gatewayens **idempotens**. Den är nu skyddad av `GuardedLedgerGateway`, som är på som standard och som journalför varje anrop så att ett kommando aldrig skickas om när utfallet är okänt. Det fungerar även om Fortnox saknar egen idempotens, och är bevisat mot ett simulerat affärssystem utan idempotens (`test/guarded.test.ts`, `test/guard-app.test.ts`). Kvarstår att den riktiga adaptern **klassar sina fel rätt** (`notApplied: true` bara när det är säkert att inget utfördes, annars okänt) och helst får en `verify`-hook (kan Fortnox söka på en referens vi skriver dit?). Utan `verify` kräver varje osäkert utfall att en människa kontrollerar i Fortnox.

## Rekommenderad ordning

1. **Fortnox-sandbox: provkör bokföringsmodellen manuellt.** Registrera en inbetalning och ett verifikat för hand och se vad som faktiskt hamnar på vilka konton. Avgör punkt 4 och clearing-risken ovan.
2. **Fortnox InvoiceReader** (läsning, ofarlig). Visar att OAuth, rate limiting och sökning på referens fungerar.
3. **Mondido PayoutSource** (läsning). Fyller `Payout`-typen från riktig data och visar vilka avvikelser som uppstår i praktiken.
4. **Kör i dry_run mot en riktig pilotkund.** Granska förslagen med deras redovisningskonsult innan något skrivs. Cursorn står kvar i dry_run, så byte till live bokför allt som granskats.
5. **Fortnox LedgerGateway** (skrivning) med bevisad idempotens. Först därefter live.
6. **Spiris** som andra adapter mot samma gränssnitt.

## Redan känt och medvetet uppskjutet

- Förslag från dry_run sparas inte och syns inte i API:t. Ett explicit godkännandeflöde saknas.
- Larm skickas via webhook (`ALERT_WEBHOOK_URL`) men inte via e-post eller pager.
- Ingen KMS-integration. `KeyProvider` är ett gränssnitt och nycklarna hålls i miljövariabler.
- Rate limiting i API:t ligger i processminne och delas inte mellan instanser. Paginering av förslag och osäkra anrop sker i minnet.
- Gallring körs bara manuellt och gränsvärdena är inte avstämda med en redovisningskonsult.
- `ledger_command`, `reconcile_exception`, `payout` och `audit_log` saknar främmande nyckel mot `tenant`.
- Produkt-, lager- och prissynk samt order- och fakturaskapande (det Synka+ gör utöver avstämning) är inte påbörjat.

## Det som kräver en människa, inte mig

- Driftansvar och jour. Någon måste kunna svara när en avstämning blir fel en fredag kväll.
- Personuppgiftsbiträdesavtal med varje kund, och bedömning av bokföringslagens krav på spårbarhet tillsammans med en redovisningskonsult.
- Avtal och partnerskap med Fortnox, Spiris och Mondido, samt beslut om vilka kunder som får gå från dry_run till live.
