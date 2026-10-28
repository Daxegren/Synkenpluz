# HTTP-API

Dokumentationen följer `src/api/server.ts` (Fastify). Ändras koden gäller koden.

## Status och begränsningar

- Servern byggs med `buildServer(deps)` och returnerar en Fastify-instans. **Det finns ingen startfil** som anropar `listen`, läser konfiguration eller kopplar in en databas. Den som driftsätter måste göra det.
- Autentiseringen är en injicerad funktion: `authenticate(apiKey) => tenantId | null`. `createAuthenticator` i `src/security/apiKeys.ts` är en implementation mot tabellen `api_key` (se nedan), men servern kräver inte att den används och det finns ingen startfil som kopplar ihop dem.
- API:t är avsett för människan som hanterar avvikelser. Det kan **läsa** avvikelser, utbetalningar och kommandostatus, och **stänga** avvikelser. Det kan inte skapa utbetalningar, köra om, eller ändra kommandon.
- Ingen paginering. Listor returnerar alla träffar för kunden (filtrerade).
- Ingen TLS eller rate limiting i servern. Det förutsätts finnas framför den.
- Loggning är avstängd i Fastify (`logger: false`) så att `x-api-key` inte hamnar i loggar.

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

Stänger en öppen avvikelse. **Ändrar bara avvikelsen**: inget kommando köas eller ändras och bokföringen påverkas inte. Ingen revisionspost skrivs av API:t.

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

### `GET /v1/payouts/:id`

Hämtar en utbetalning med dess kommandon i utförandeordning. `404` om utbetalningen inte finns.

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
