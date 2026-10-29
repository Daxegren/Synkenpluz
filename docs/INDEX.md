# Dokumentationsindex

Börja här. Dokumenten är skrivna på svenska och beskriver koden som den **är**, inte som den önskas.

## Läs i den här ordningen

| # | Dokument | Läs det när du vill... |
| --- | --- | --- |
| 1 | [../README.md](../README.md) | förstå vad produkten är, vad den kostar och hur du kör den |
| 2 | [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md) | se **allt** som finns: funktioner, filer, tabeller, rutter, koder, tester, med diagram |
| 3 | [NEXT_STEPS.md](NEXT_STEPS.md) | veta vad som blockerar nästa steg och vad som är rekommenderad ordning |
| 4 | [ARCHITECTURE.md](ARCHITECTURE.md) | förstå hur delarna hänger ihop, tillståndsmaskiner och garantier (och var de bryts) |
| 5 | [RUNBOOK.md](RUNBOOK.md) | hantera drift: dött kommando, avvikelsekoder, misstänkt dubbelbokning, jour |
| 6 | [SECURITY.md](SECURITY.md) | se hotmodell, vad som skyddas, GDPR-checklista och kvarstående risker |
| 7 | [API.md](API.md) | använda HTTP-API:t, med curl-exempel |
| 8 | [DECISIONS.md](DECISIONS.md) | förstå *varför* något är som det är (beslutslogg) |
| 9 | [LOGG.md](LOGG.md) | se vad som byggdes när, vem/vad som granskade och vad granskningarna hittade |
| 10 | [SPEC.md](SPEC.md) | läsa den ursprungliga specen (delvis föråldrad, koden gäller) |

## Snabbsvar

| Fråga | Svar |
| --- | --- |
| Hur ser helheten ut? | Bilden [karta-system.png](karta-system.png), eller diagrammen i kartan |
| Finns det redan något som gör X? | Sök i [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md), avsnitt 2 och 3 |
| Var ändrar jag Y? | [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md), avsnitt 9 |
| Vad kan systemet faktiskt göra idag? | `npm run demo`, och statusmärkena i kartan |
| Vad saknas? | Kartan (🔲) och [NEXT_STEPS.md](NEXT_STEPS.md) |
| Något är trasigt i drift | [RUNBOOK.md](RUNBOOK.md) |

## Dokumentationsregeln

Allt som byggs ska dokumenteras i samma ändring som koden. Vad som ska uppdateras:

| Du ändrar... | Uppdatera... |
| --- | --- |
| En kodfil (ny, flyttad, borttagen) eller en exporterad funktion/klass | [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md) avsnitt 3 (och 2 om det är en ny förmåga) |
| En API-rutt | [API.md](API.md) och kartans avsnitt 6 |
| En avvikelsekod | [RUNBOOK.md](RUNBOOK.md) (åtgärd) och kartans avsnitt 7 |
| Ett databasschema | ny migration, kartans avsnitt 5 och [ARCHITECTURE.md](ARCHITECTURE.md) |
| Ett npm-skript, ett adminkommando eller en miljövariabel | kartans avsnitt 6 och README |
| En testfil | kartans avsnitt 8 |
| Ett designbeslut | [DECISIONS.md](DECISIONS.md) (ny ADR) |
| Något som byggts eller hittats | [LOGG.md](LOGG.md) (ny rad) |
| Vad som är klart/saknas | statusmärkena i kartan och [NEXT_STEPS.md](NEXT_STEPS.md) |

**Det efterlevs av ett test:** `test/docs.test.ts` underkänner bygget (`npm run check`, och därmed CI) om en kodfil, exporterad funktion eller klass, API-rutt, avvikelsekod, tabell, migration, npm-skript, adminkommando, miljövariabel eller testfil saknas i dokumentationen, eller om ett dokument i `docs/` saknas i det här indexet. Testet kontrollerar att namnen *finns*, inte att beskrivningen är bra. Det senare är ditt jobb.
