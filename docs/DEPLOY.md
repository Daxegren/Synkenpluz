# Driftsättning

Hur tjänsten sätts upp, körs och sätts i skarp drift. Läs [RUNBOOK.md](RUNBOOK.md) för daglig drift och [SECURITY.md](SECURITY.md) för risker.

## Vad som är verifierat och inte

| Sak | Status |
| --- | --- |
| Kompilerad build (`npm run build`) och start med bara produktionsberoenden | ✅ Verifierat: rökprov mot bygget (`SMOKE_PROD=1 npm run smoke`) och en simulerad produktionsinstallation utan utvecklingsberoenden |
| `Dockerfile`, `docker-compose.yml` | ⚠️ **Inte byggda här** (ingen Docker-demon i utvecklingsmiljön). CI-jobbet `docker` bygger avbilden och kontrollerar uppstarten vid varje push. Verifiera första gången lokalt med `docker compose up --build` |
| TLS, backup, övervakning | 🔲 Ingår inte i repot. Kontrolllista nedan |

## Snabbstart lokalt

```sh
cp .env.example .env
# Fyll i API_KEY_PEPPER och MASTER_KEYS (openssl rand -hex 32, se kommentarerna i .env.example)
docker compose up --build

# Skapa en kund och en API-nyckel (körs i containern):
docker compose run --rm app node dist/scripts/admin.js create-tenant kund1 "Kund AB"
docker compose run --rm app node dist/scripts/admin.js set-accounts kund1 1930 1580 6570 2641   # exempelkonton
docker compose run --rm app node dist/scripts/admin.js issue-key kund1

curl -s http://127.0.0.1:3000/health
```

Utan Docker: `npm ci && npm run build && npm run start:prod` (kräver miljövariablerna i `.env.example` och en Postgres 16).

## Miljövariabler

Se [`.env.example`](../.env.example) och [FUNKTIONSKARTA.md](FUNKTIONSKARTA.md) avsnitt 6. Obligatoriska: `DATABASE_URL`, `API_KEY_PEPPER`, `MASTER_KEYS`. Appen vägrar starta med ogiltig konfiguration och skriver aldrig ut hemliga värden i felet.

## Webbgränssnittet

Tjänsten levererar granskningsgränssnittet på `/app` från katalogen `web/`. I Docker-avbilden kopieras den till `/app/web`. Saknas katalogen finns gränssnittet helt enkelt inte (API:t fungerar ändå). Eftersom användare skriver in en API-nyckel i webbläsaren är **TLS obligatoriskt** framför tjänsten, och nycklar bör vara kortlivade och per person (`issue-key <kund> 30`). Gränssnittet använder absoluta sökvägar (`/app/...`): lägg inte tjänsten under ett URL-prefix utan att skriva om dem.

## Kontrolllista inför skarp drift

**Hemligheter**
- [ ] `API_KEY_PEPPER` och `MASTER_KEYS` genererade per miljö (aldrig samma i staging och prod) och lagrade i en secret manager, inte i repot eller i bilden.
- [ ] En säker kopia av `MASTER_KEYS` och `API_KEY_PEPPER` finns utanför servern. **Förlorad `MASTER_KEYS` = alla sparade åtkomsttoken är oläsliga. Byte av pepper ogiltigförklarar alla API-nycklar.**
- [ ] `ALERT_WEBHOOK_URL` satt och testad (en människa ska faktiskt få larmen).
- [ ] `METRICS_TOKEN` satt om `/metrics` ska skrapas.

**Nätverk**
- [ ] TLS framför tjänsten (lastbalanserare eller omvänd proxy). Servern pratar bara HTTP.
- [ ] `trustProxy` aktiverat bakom proxy, annars blir alla anrop samma IP i rate limitern.
- [ ] Databasen nås bara från appen (ingen publik port). I `docker-compose.yml` är appens port bunden till `127.0.0.1`.
- [ ] `/metrics` och `/ready` ej öppna mot internet utan skydd.
- [ ] TLS är på innan någon loggar in i `/app` (nyckeln skickas i en header).
- [ ] Utfärda en API-nyckel **per person** med utgångsdatum, så att åtkomst kan återkallas individuellt (`revoke-key`) och revisionsloggen visar vilken nyckel som gjorde vad.

**Databas**
- [ ] Hanterad Postgres 16 med automatisk säkerhetskopiering och **testad återställning**. Utan fungerande återställning finns ingen bokföringsspårbarhet.
- [ ] Applikationsrollen har inte rätt att `UPDATE`, `DELETE` eller `TRUNCATE` på `audit_log` (triggers stoppar det redan, men ta bort rättigheterna också).
- [ ] Migrationer körs vid start (`migrate`). Ta en säkerhetskopia före varje release som innehåller en ny migration. **Det finns ingen automatisk nedgradering.**

**Körning**
- [ ] Restart-policy satt (`unless-stopped` i compose). Graciös nedstängning hanteras (SIGTERM, 30 s).
- [ ] Flera instanser är säkra mot varandra (kön och utföraren är samtidighetstestade mot riktig Postgres), men **rate limitern delas inte mellan instanser** (processminne).
- [ ] Bara en körcykel behöver gå åt gången. Flera går att köra men ger onödig databaslast. `CYCLE_INTERVAL_MS=0` startar en instans som bara serverar API:t.
- [ ] Loggarna samlas in (JSON-rader på stdout/stderr) och innehåller inga hemligheter (verifierat av rökprovet, men granska nya loggrader).

**Övervakning**
- [ ] Larm på: döda kommandon > 0, osäkra anrop > 0, äldsta väntande kommando > 30 min, `/ready` ≠ 200 (se [RUNBOOK.md](RUNBOOK.md) avsnitt 12).
- [ ] Någon är utsedd att ta emot larm och har läst [RUNBOOK.md](RUNBOOK.md) (särskilt avsnitt 10, osäkert utfall).

## Release och go-live

1. **Staging först.** Samma bild, en egen databas, simulerade eller sandbox-system.
2. Ta backup. Kör migrationer via start. Kontrollera `/ready` och `npm run admin:prod -- list-tenants`.
3. **Ny kund startar alltid i `dry_run`.** Låt några körcykler gå och granska förslagen (`GET /v1/proposals`, `list-proposals`) tillsammans med kundens redovisningskonsult. Underlag för granskningen: [BESLUT_REDOVISNING.md](BESLUT_REDOVISNING.md).
4. **Byte till live bokför allt som granskats på en gång** (cursorn står kvar i dry_run). Gör bytet med `set-mode <kund> live` först när förslagen är godkända och gatewayen är provkörd i sandbox ([FORTNOX_TESTPLAN.md](FORTNOX_TESTPLAN.md)).
5. Bevaka kön de första dagarna: `GET /v1/payouts`, `GET /v1/exceptions`, mätvärden.

## Återställning och nödbroms

- **Stoppa all bokföring för en kund:** `suspend <kund>`. Kön utför inget för avstängda kunder.
- **Stoppa bokföring för alla:** sätt `CYCLE_INTERVAL_MS=0` och starta om (API:t fortsätter).
- **Backa en release:** redeploya föregående bild. Om en ny migration körts: återställ från backupen (ingen nedgradering finns). Därför: backup före varje release.
- **Misstänkt dubbelbokning:** [RUNBOOK.md](RUNBOOK.md) avsnitt 8.
