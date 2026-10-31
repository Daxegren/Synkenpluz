# HTTP-API

Dokumentationen följer `src/api/server.ts` (Fastify). Ändras koden gäller koden.

## Status och begränsningar

- Servern byggs med `buildServer(deps)` (Fastify) och sätts ihop av `createApp` i `src/app/compose.ts`. `src/main.ts` startar den (`npm start`).
- Autentisering: `createDetailedAuthenticator` (`src/security/apiKeys.ts`) mot tabellen `api_key`. Revisionsposter får `actor: api:<nyckel-id>` (aldrig hemligheten).
- API:t är avsett för människan som hanterar avvikelser. Det kan **läsa** avvikelser, utbetalningar, kommandostatus och dry_run-förslag, och **göra mänskliga åtgärder**: stänga avvikelser, köa om döda kommandon och avgöra osäkra gateway-anrop. Alla åtgärder revisionsloggas atomiskt. Det kan inte skapa utbetalningar eller ändra kommandon.
- **Paginering:** alla listor tar `limit` (1 till 500, standard 100) och `offset` (standard 0) och svarar `{ items, limit, offset, hasMore }`. Ogiltigt värde ger `400`.
- **Rate limiting** (token bucket i processminne, delas inte mellan instanser): per API-nyckel, och per IP för misslyckad autentisering och öppna rutter. `429` med `Retry-After`. Sätt `trustProxy` bakom en proxy.
- **Bodygräns** 64 KB (`413`), och okänd content-type ger `415`.
- Ingen TLS i servern. Det förutsätts finnas framför den.
- Loggning är avstängd i Fastify (`logger: false`) så att `x-api-key` inte hamnar i loggar.

## Webbgränssnitt (`/app`)

`GET /app` (med `/app/app.js`, `/app/lib.js`, `/app/style.css`) levererar ett webbgränssnitt för granskning (katalogen `web/`, se [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md)). Sidorna är öppna och innehåller inga uppgifter, men all data hämtas från `/v1` med en API-nyckel som användaren skriver in. Svaren har strikt `Content-Security-Policy` (inga inline-skript, inga externa resurser, ingen inbäddning i ramar), `nosniff` och `ETag`. Bara de fyra filerna levereras, ingen annan sökväg. Sökvägarna är absoluta (`/app/...`), så en proxy som lägger tjänsten under ett prefix måste skriva om dem. Rate limitern begränsar sidladdningar per IP. Sätts `WEB_DIR` i miljön används den katalogen, annars hittas `web/` automatiskt (i Docker-avbilden ligger den i `/app/web`).

## Autentisering

Alla endpoints under `/v1` kräver headern `x-api-key`. Nyckeln avgör kund (`tenantId`). Alla läsningar och skrivningar begränsas till den kunden. En resurs som tillhör en annan kund ser ut som att den inte finns (404).

- Saknad, tom eller längre än 256 tecken nyckel: `401`.
- Nyckel som `authenticate` inte känner igen: `401`. Med `createAuthenticator` gäller dessutom: nyckeln måste ha formatet `synk_<12 hex>_<43 tecken>`, får inte vara återkallad eller utgången, och kundens status måste vara `active`. Alla dessa fall ger samma `401`.
- `GET /health` kräver ingen nyckel.

## Felformat

Alla fel har samma form:

```json
{ "error": { "code": "validation_error", "message": "Ogiltig indata (query): ..." } }
```

| HTTP | `code` | När |
| --- | --- | --- |
| 400 | `validation_error` | Ogiltiga parametrar, query eller body (okända fält avvisas, schemana är strikta) |
| 400 | `bad_request` | Fastifys eget klientfel med status 400, till exempel trasig JSON |
| 401 | `unauthorized` | Se Autentisering |
| 404 | `not_found` | Resursen finns inte (eller tillhör annan kund), eller okänd route |
| 409 | `conflict` | Avvikelsen är inte öppen (redan stängd) |
| 4xx | `request_error` | Andra klientfel från Fastify (till exempel för stor body, fel content-type) |
| 500 | `internal_error` | Oväntat fel. Meddelandet är alltid "Internt fel", inga detaljer läcks |

## Endpoints

### `GET /health`

Öppen. Svar `200`: `{ "status": "ok" }`.

```sh
curl -s http://localhost:3000/health
```

### `GET /v1/exceptions`

Listar kundens avvikelser, äldst först.

Query (alla valfria):

| Parameter | Värden |
| --- | --- |
| `status` | `open`, `resolved`, `dismissed` |
| `payoutId` | utbetalnings-id (1 till 128 tecken) |

```sh
curl -s -H "x-api-key: $API_KEY" "http://localhost:3000/v1/exceptions?status=open"
```

Svar `200`:

```json
{
  "items": [
    {
      "id": "3f1c9c1e-7a0e-4c7e-9a52-0c3d8f6b2a11",
      "payoutId": "P1",
      "code": "NO_MATCH",
      "lineId": "l1",
      "message": "Ingen faktura med referens REF-A",
      "status": "open",
      "resolutionNote": null,
      "createdAt": "2026-10-28T12:00:00.000Z",
      "resolvedAt": null
    }
  ]
}
```

`code` är en av `ExceptionCode` (se [RUNBOOK.md](RUNBOOK.md)). `lineId` kan vara `null`. `tenantId` returneras aldrig.

### `GET /v1/exceptions/:id`

Hämtar en avvikelse. Svar `200`: samma objekt som ovan. `404` om den inte finns.

```sh
curl -s -H "x-api-key: $API_KEY" http://localhost:3000/v1/exceptions/3f1c9c1e-7a0e-4c7e-9a52-0c3d8f6b2a11
```

### `POST /v1/exceptions/:id/resolve`

Stänger en öppen avvikelse. **Ändrar bara avvikelsen**: inget kommando köas eller ändras och bokföringen påverkas inte. API:t skriver en revisionspost (`exception.resolved`) med avvikelsens id, kod och utfall. Den fria anteckningen loggas inte, eftersom den kan innehålla personuppgifter.

Body (JSON, strikt):

| Fält | Typ | Regler |
| --- | --- | --- |
| `status` | `"resolved"` eller `"dismissed"` | obligatoriskt |
| `note` | sträng | obligatoriskt, trimmas, 1 till 2000 tecken |

```sh
curl -s -X POST \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"status":"dismissed","note":"Verifierat mot bankutdrag, bokfört manuellt av redovisningskonsult"}' \
  http://localhost:3000/v1/exceptions/3f1c9c1e-7a0e-4c7e-9a52-0c3d8f6b2a11
```

Svar `200`: den uppdaterade avvikelsen (`status`, `resolutionNote`, `resolvedAt` satta). `404` om den inte finns, `409` om den inte var öppen, `400` vid ogiltig body.

Observera: orsaken kvarstår efter stängning. Vid nästa live-körning av utbetalningen skapas avvikelsen på nytt om problemet finns kvar.

### `GET /v1/payouts`

Listar kundens utbetalningar, äldst bearbetade först. Bara utbetalningar som bearbetats i live-läge finns (dry_run sparar ingen utbetalning).

Query: `status` (valfri): `rejected`, `partial`, `complete`.

```sh
curl -s -H "x-api-key: $API_KEY" "http://localhost:3000/v1/payouts?status=partial"
```

Svar `200`:

```json
{ "items": [ { "payoutId": "P1", "status": "partial", "processedAt": "2026-10-28T12:00:00.000Z" } ] }
```

`status: "complete"` betyder avstämd och köad, inte utförd. Se kommandona i nästa endpoint.

### `GET /v1/proposals`

Sparade dry_run-förslag för kunden: vad som SKULLE bokföras i live-läge. Filter `?status=` (`rejected`, `partial`, `complete`), samt `limit` och `offset`. Finns bara om `proposals` är kopplad (annars `404`).

```sh
curl -s -H "x-api-key: $API_KEY" "http://localhost:3000/v1/proposals?status=partial"
```

Svar `200`: `{ "items": [ { "payoutId": "P1", "status": "partial", "commandCount": 2, "exceptionCount": 1, "updatedAt": "..." } ], "limit": 100, "offset": 0, "hasMore": false }`.

### `GET /v1/proposals/:payoutId`

Ett förslag i detalj: `commands` (utan idempotensnyckel) och `exceptions`. `404` om förslag saknas. Förslaget försvinner när utbetalningen bokförs live.

### `GET /v1/payouts/:id`

Hämtar en utbetalning med dess kommandon i utförandeordning. Kommandots `id` används för att köa om det med `POST /v1/commands/:id/retry`. `404` om utbetalningen inte finns.

```sh
curl -s -H "x-api-key: $API_KEY" http://localhost:3000/v1/payouts/P1
```

Svar `200`:

```json
{
  "payoutId": "P1",
  "status": "partial",
  "processedAt": "2026-10-28T12:00:00.000Z",
  "commands": [
    {
      "id": "b0a7d7f0-5a53-4a3e-8f70-6a8e8d6c9d02",
      "kind": "post_voucher",
      "status": "dead",
      "attempts": 1,
      "nextAttemptAt": "2026-10-28T12:00:00.000Z",
      "hasError": true
    }
  ]
}
```

Kommandon visas medvetet avskalade: inget tenant-id, ingen idempotensnyckel, inget innehåll (konton, belopp, fakturor), inget externt id och inget felmeddelande, bara `hasError`. För att se orsaken till ett fel används SQL, se [RUNBOOK.md](RUNBOOK.md).

`kind` är `register_invoice_payment`, `credit_invoice` eller `post_voucher`. `status` är `pending`, `in_progress`, `succeeded`, `failed` eller `dead`.

### `POST /v1/commands/:id/retry`

Mänsklig åtgärd: sätter ett **dött** kommando tillbaka i kön med nollställda försök, så att det körs igen vid nästa körcykel. Använd bara efter att orsaken åtgärdats och efter att ha kontrollerat i affärssystemet att kommandot inte redan utfördes (se [RUNBOOK.md](RUNBOOK.md), avsnitt 2).

```sh
curl -s -X POST -H "x-api-key: $API_KEY" http://localhost:3000/v1/commands/$COMMAND_ID/retry
```

Svar `200`: `{"id": "...", "status": "pending"}`. `409` om kommandot inte finns, tillhör en annan kund eller inte är dött (ett kommando som är `pending`, `failed`, `in_progress` eller `succeeded` kan inte köas om). Åtgärden revisionsloggas som `command.requeued`.

### `GET /v1/onboarding`

Kundens onboarding: vad som återstår innan förslagen kan godkännas. Finns bara om onboarding-tjänsten är kopplad (annars `404`).

Svar `200`: `{ "tenantStatus", "mode", "phase": "setup" | "review" | "live", "steps": [ { "id", "label", "done", "hint" } ], "blockers": ["accounts", ...], "proposals": { "count", "withExceptions" }, "ledger": { "provider", "capabilities", "notes" } }`. `ledger` finns bara om en leverantör av affärssystem är kopplad. Stegen är `tenant_active`, `accounts`, `api_key`, `payout_connection`, `ledger_connection`, `dry_run` och `in_doubt`. `blockers` är tom i faserna `review` och `live`.

### `POST /v1/onboarding/go-live`

Godkänner att kunden går från dry_run till live. Body: `{ "approvedProposalCount": 12 }`, antalet förslag godkännaren har sett. Allt som granskats bokförs då på riktigt, eftersom cursorn inte flyttas i dry_run. Svar `200` `{ "mode": "live" }`. Svar `409` med kod `not_ready` (checklistan är inte klar), `stale_review` (antalet förslag är ett annat nu, granska igen) eller `already_live`. Lägesbytet och revisionsposten `tenant.go_live` skrivs atomiskt. Det finns ingen väg tillbaka härifrån, och inga roller: vem som helst med kundens nyckel kan godkänna.

### `POST /v1/onboarding/check-connection`

Gör ett skrivskyddat test av anslutningen till affärssystemet. Svar `200` `{ "ok": true, "problems": [] }` eller `{ "ok": false, "problems": ["..."] }` (högst 10 problem om 200 tecken). Kastar testet visas bara ett allmänt meddelande, aldrig orsaken. `404` om ingen leverantör är kopplad.

### `GET /v1/guard/in-doubt`

Kundens gateway-anrop vars utfall är **okänt**: anropet skickades men vi vet inte om affärssystemet tog emot det (timeout, avbruten anslutning, 5xx). Systemet skickar dem aldrig om automatiskt, eftersom det kunde ge dubbelbokning. En människa ska kontrollera i affärssystemet och avgöra med `POST /v1/guard/resolve`. Paginerad. Finns bara om `guard` är kopplad (annars `404`).

Svar `200`: `{ "items": [ { "key": "...", "startedAt": "..." } ], "limit": 100, "offset": 0, "hasMore": false }`.

### `POST /v1/guard/resolve`

Avgör ett okänt utfall efter att du kontrollerat i affärssystemet. Body: `{ "key": "...", "applied": true, "externalId": "..." }` när kommandot **utfördes** (`externalId` krävs), eller `{ "key": "...", "applied": false }` när det **inte** utfördes (`externalId` får inte anges). Svar `200` `{ "key", "applied", "resolved": true }`, `409` om ingen osäker post finns för nyckeln. Revisionspost `guard.resolved` med en kort hash av nyckeln, utan externt id och fritext. Köa därefter om det döda kommandot med `POST /v1/commands/:id/retry`.

### `GET /ready`

Öppen beredskapskoll: `200 {"status":"ready"}` när databasen svarar, annars `503 {"status":"unavailable"}` utan detaljer. Rate-limitad per IP.

### `GET /metrics`

Prometheus-mätvärden (kö per status, döda kommandon, äldsta väntande kommando, öppna avvikelser, osäkra anrop, kunder per läge). **Inga kund-id** i etiketter. Finns bara om `METRICS_TOKEN` är satt (annars `404`). Kräver `Authorization: Bearer <token>`, jämförs tidskonstant, annars `401`. Format `text/plain; version=0.0.4`.

## Exempel: arbetsflöde för avvikelser

```sh
export API_KEY=...            # kundens nyckel
BASE=http://localhost:3000

# 1. Vad är öppet?
curl -s -H "x-api-key: $API_KEY" "$BASE/v1/exceptions?status=open"

# 2. Hur ser utbetalningen ut?
curl -s -H "x-api-key: $API_KEY" "$BASE/v1/payouts/P1"

# 3. När orsaken är hanterad i källsystemet och kunden/ansvarig godkänt:
curl -s -X POST -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"status":"resolved","note":"Faktura skapad i affärssystemet"}' \
  "$BASE/v1/exceptions/<id>/resolve"
```
