# Funktionskarta

Det här är kartan över **allt som finns** i repot: vilka funktioner systemet har, var i koden varje del bor, vad som testar den och vad som fortfarande är simulerat eller saknas. Använd den när du undrar "finns det redan något som gör X?" eller "var ändrar jag Y?".

Kartan hålls aktuell av ett test (`test/docs.test.ts`): bygget faller om en kodfil, exporterad funktion, API-rutt, avvikelsekod, tabell, migration, npm-skript, adminkommando, miljövariabel eller testfil saknas här. Se [INDEX.md](INDEX.md) för dokumentationsregeln.

**Statusmärken:** ✅ klar och testad · 🧪 klar men bara mot simulerade system · 🔲 saknas (se [NEXT_STEPS.md](NEXT_STEPS.md)).

## 1. Systemkarta

```mermaid
flowchart TB
    subgraph Ute["Omvärlden"]
        MON["Mondido<br/>(betalleverantör)"]:::saknas
        FNX["Fortnox / Spiris<br/>(affärssystem)"]:::saknas
        KUND["Kundens system<br/>& redovisningskonsult"]
    end

    subgraph Portar["Portar = gränssnitt (src/ports)"]
        PS["PayoutSource"]
        IR["InvoiceReader"]
        LG["LedgerGateway"]
    end

    subgraph Fake["Simulerat (src/gateways)"]
        FPS["FakePayoutSource"]
        FLG["FakeLedgerGateway"]
    end

    subgraph Kärna["Kärnan"]
        SYNC["syncTenant<br/>hämta + återuppta"]
        PROC["processPayout<br/>spara atomiskt"]
        ENG["reconcile<br/>ren avstämningsmotor"]
        EXE["Utförare<br/>runDueCommands / drain"]
        GRD["GuardedLedgerGateway<br/>skydd mot dubbelbokning"]
        CYC["runCycle<br/>körcykel + larm"]
        NOT["Larmutskick<br/>webhook, dämpning"]
    end

    subgraph Data["Postgres (src/db)"]
        Q[("ledger_command<br/>kön")]
        EX[("reconcile_exception")]
        PO[("payout")]
        AU[("audit_log<br/>append-only")]
        TE[("tenant · api_key<br/>connection · sync_state")]
        GG[("gateway_guard<br/>journal över anrop")]
        PR[("dry_run_proposal<br/>förslag")]
    end

    subgraph Ytan["Gränssnitt utåt"]
        API["HTTP-API<br/>src/api/server.ts"]
        ADM["Admin-CLI<br/>scripts/admin.ts"]
        MAIN["src/main.ts<br/>server + schemalagd cykel"]
    end

    MON -.-> PS
    FNX -.-> IR
    FNX -.-> LG
    FPS --> PS
    FLG --> IR
    FLG --> LG

    CYC --> SYNC
    CYC --> EXE
    SYNC --> PS
    SYNC --> IR
    SYNC --> PROC
    PROC --> ENG
    PROC --> Q
    PROC --> EX
    PROC --> PO
    PROC --> AU
    EXE --> Q
    EXE --> GRD
    GRD --> LG
    GRD --> GG
    PROC --> PR
    CYC --> NOT
    API --> EX
    API --> PO
    API --> Q
    API --> AU
    ADM --> TE
    MAIN --> CYC
    MAIN --> API
    KUND --> API

    classDef saknas stroke-dasharray: 5 5,fill:#fff3cd,stroke:#b58900
```

Streckade rutor är externa system som **inte är anslutna ännu**. En färdigrenderad bild av samma karta finns i [karta-system.png](karta-system.png) (ögonblicksbild, diagrammet ovan är den som gäller).

![Systemkarta](karta-system.png)

 Allt i "Kärnan" och "Postgres" är byggt och testat.

## 2. Funktionskatalog: vad systemet kan göra

### Avstämning (kärnlogik)

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| Matcha betalning mot faktura | Exakt referens och exakt belopp. Allt annat blir avvikelse, ingen gissning | `src/engine/reconcile.ts` | `test/reconcile.test.ts`, `test/scenarios/` | ✅ |
| Återbetalning och delkreditering | Hel- eller delkredit med moms/netto fördelat på kvarvarande belopp, utan avrundningsdrift | `reconcile`, `allocate` i `src/domain/money.ts` | `test/engine-review.test.ts`, `test/money.test.ts` | ✅ |
| Avgifter | Avgift per betalning eller som fristående rad (netto + moms) bokförs i verifikatet | `reconcile` | `test/reconcile.test.ts` | ✅ |
| Balanserat verifikat | Ett verifikat per utbetalning (bank, avgifter, ingående moms, clearing). Skapas först när alla rader är lösta | `reconcile` | `test/scenarios/properties.test.ts` | ✅ |
| Summakontroll | Raderna måste summera exakt till utbetalt belopp, annars avvisas hela utbetalningen | `reconcile` | `test/reconcile.test.ts` | ✅ |
| Validering av indata | Ogiltiga belopp, dubbla id, tom utbetalning, ogiltiga fakturor, säkra heltalssummor | `reconcile` | `test/engine-review.test.ts` | ✅ |
| Deterministiska idempotensnycklar | Samma indata ger samma kommandon och nycklar. Kolon i id kodas | `reconcile` | `test/scenarios/properties.test.ts` | ✅ |
| Omkörning utan falska avvikelser | `settledLineIds`: rader som redan köats matchas inte om | `reconcile`, `processPayout` | `test/reconcile.test.ts`, `test/e2e.test.ts` | ✅ |

### Flöde och drift

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| Spara en utbetalning atomiskt | Kommandon, avvikelser, status och revisionspost i en transaktion | `processPayout` i `src/service/processPayout.ts` | `test/e2e.test.ts` | ✅ |
| Dry-run | Beräkna förslag utan att spara eller logga något. Nya kunder startar här | `processPayout` (`mode: 'dry_run'`) | `test/e2e.test.ts`, `test/sync.test.ts` | ✅ |
| Sparade dry_run-förslag | Dry-run sparar förslaget per utbetalning (kommandon + avvikelser) för granskning före go-live. Oförändrat förslag rörs inte. Försvinner när utbetalningen bokförs live | `processPayout`, `src/db/proposals.ts` | `test/proposals.test.ts` | ✅ |
| Konfliktdetektering | Upptäcker att en redan köad rad ändrats hos leverantören | `withConflicts` i `processPayout.ts` | `test/e2e.test.ts` | ✅ |
| Auto-stäng avvikelser | Avvikelser som inte längre uppstår stängs vid omkörning | `processPayout` | `test/e2e.test.ts` | ✅ |
| Hämta nya utbetalningar | Hämtar från leverantör efter cursor, avstämmer varje, felisolerat per utbetalning | `syncTenant` i `src/service/syncTenant.ts` | `test/sync.test.ts` | 🧪 |
| Återuppta delvis/avvisade | Hämtar om `partial` och `rejected` varje cykel (en saknad faktura kan ha dykt upp) | `syncTenant` | `test/sync.test.ts`, `test/hardening.test.ts` | 🧪 |
| Kö med ordning per utbetalning | Kommando N släpps först när N-1 lyckats. Samtidighetssäker (`skip locked`, advisory lock) | `src/db/repositories.ts` | `test/db/`, `test/pg/` | ✅ |
| Utförare med omförsök | Backoff, Retry-After (golv/tak), timeout per anrop, dött kommando efter max försök | `runDueCommands`, `drain` i `src/executor/executor.ts` | `test/e2e.test.ts`, `test/hardening.test.ts` | ✅ |
| Återhämtning efter krasch | Släpper kommandon som fastnat; försenade arbetare fencas på försöksnummer | `recoverStale`, `releaseStale` | `test/e2e.test.ts`, `test/db/` | ✅ |
| Körcykel och larm | Synka alla kunder, kör kön, skapa larm (kritiskt så länge något är dött) | `runCycle` i `src/app/cycle.ts` | `test/cycle.test.ts` | ✅ (larm skickas ej vidare) |
| Dött kommando → utbetalning `partial` | `onDead` sätter status och loggar | `createApp` i `src/app/compose.ts` | `test/hardening.test.ts` | ✅ |
| Avstängd kund får inget utfört | `claimDue` hoppar över avstängda och dry_run-kunder | `claimDue` | `test/hardening.test.ts` | ✅ |

### Skydd mot dubbelbokning

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| Skyddsgateway | Journalför varje anrop (påbörjad före, klar efter). Samma nyckel ger samma svar. Skickar aldrig om ett kommando vars utfall är okänt. Fungerar även om affärssystemet saknar egen idempotens. **På som standard** i `createApp` | `GuardedLedgerGateway` i `src/gateways/guarded.ts`, `src/db/gatewayGuard.ts` | `test/guarded.test.ts`, `test/guard-app.test.ts` | ✅ |
| Okänt utfall avgörs av människa | Osäkra anrop listas och avgörs ("utfördes"/"utfördes inte") via API eller CLI, därefter köas kommandot om | `GET /v1/guard/in-doubt`, `POST /v1/guard/resolve`, adminkommandona `list-in-doubt`/`resolve-in-doubt` | `test/guard-app.test.ts`, `test/api/extended.test.ts`, `test/retention.test.ts` | ✅ |
| Automatisk kontroll av okänt utfall | `verify`-hook: affärssystemet kan själv svara om kommandot redan utförts | `GuardedOptions.verify` | `test/guarded.test.ts` | 🧪 ingen adapter använder den |
| Kontraktssviter för adaptrar | Färdiga tester som varje `PayoutSource`, `InvoiceReader` och `LedgerGateway` ska klara (idempotens, isolering, färsk status, felklassning) | `test/contracts/ports.contract.ts` | `test/contracts/fakes.test.ts` | ✅ (körs mot simulerade) |
| Felklassning för HTTP | En enda tabell från HTTP-utfall till `LedgerError` med `retryable`, `retryAfterMs`, `notApplied` | `classifyHttpFailure` i `src/http/errors.ts` | `test/http/errors.test.ts` | ✅ |

### Infrastruktur för framtida adaptrar (`src/http/`)

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| HTTP-klient | Timeout, svarsstorlek, rate limiter, auth-header, ett omförsök vid 401, aldrig hemligheter i fel | `createHttpClient` i `src/http/client.ts` | `test/http/client.test.ts` | ✅ |
| Rate limiter mot leverantör | Token bucket, FIFO | `createRateLimiter` i `src/http/rateLimiter.ts` | `test/http/rateLimiter.test.ts` | ✅ |
| OAuth2-token | Cachar, förnyar före utgång, serialiserar förnyelser, roterar refresh-token via callback | `createOAuth2TokenProvider` i `src/http/oauth.ts` | `test/http/oauth.test.ts` | ✅ |

### Gränssnitt för människor

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| Läsa utbetalningar, avvikelser och förslag | Tenant-isolerat HTTP-API med paginering (`limit`, `offset`, `hasMore`) | `buildServer` i `src/api/server.ts` | `test/api/server.test.ts`, `test/app.test.ts` | ✅ |
| Stänga avvikelse | `POST /v1/exceptions/:id/resolve`, revisionsloggas atomiskt | `buildServer` | `test/api/`, `test/hardening.test.ts` | ✅ |
| Köa om dött kommando | `POST /v1/commands/:id/retry`, revisionsloggas atomiskt | `buildServer`, `requeue` | `test/app.test.ts` | ✅ |
| Administrera kunder | Skapa kund, kontoplan, läge, nycklar, kopplingar via CLI | `scripts/admin.ts` | `scripts/smoke-steps.sh` | ✅ |
| Webbgränssnitt för granskning | Enkel webbsida på `/app` där en redovisningskonsult eller handläggare loggar in med API-nyckel, granskar förslag och utbetalningar, stänger avvikelser, köar om döda kommandon och avgör osäkra anrop. Svenska, tillgängligt, mobilanpassat, ljust/mörkt läge | `web/`, `src/web/serve.ts` | `test/web.test.ts`, `test/web.e2e.test.ts` (riktig webbläsare) | ✅ |
| Granska dry_run-förslag | `GET /v1/proposals`, `GET /v1/proposals/:payoutId` och adminkommandot `list-proposals` (utan belopp) | `buildServer`, `summarizeProposal` | `test/api/extended.test.ts`, `test/retention.test.ts` | ✅ |
| Gallring (GDPR) | Torrkörning och körning av gallring enligt säkra regler. Rör aldrig öppet, dött, pågående, `audit_log` eller `payout` | `planRetention`, `applyRetention` i `src/db/retention.ts`, adminkommandona `retention-plan`/`retention-apply` | `test/retention.test.ts` | ✅ (körs manuellt) |
| Demo | Berättande genomkörning med simulerade system | `scripts/demo.ts` | körs manuellt (`npm run demo`) | ✅ |
| Rökprov | Temporär Postgres, admin, server, API, nedstängning | `scripts/smoke.sh` | körs manuellt (`npm run smoke`) | ✅ |

### Säkerhet

| Funktion | Vad den gör | Kod | Test | Status |
| --- | --- | --- | --- | --- |
| API-nycklar | Genereras en gång, lagras som HMAC, tidskonstant jämförelse, återkallning, utgång | `src/security/apiKeys.ts`, `src/db/tenants.ts` | `test/security/security.test.ts` | ✅ |
| Kryptering av åtkomsttoken | AES-256-GCM, nyckel-id i blobben, bundet till kund/koppling/fält (AAD), nyckelrotation | `src/security/crypto.ts`, `src/db/connections.ts` | `test/security/security.test.ts` | ✅ (ingen KMS) |
| Rate limiting och bodygräns i API:t | Token bucket per nyckel och per IP (misslyckad auth), 429 med Retry-After, bodygräns 64 KB | `RateLimiter` i `src/api/rateLimit.ts` | `test/api/rateLimit.test.ts`, `test/api/extended.test.ts` | ✅ (i processminne) |
| Mätvärden och hälsa | `GET /metrics` (Prometheus, bearer-token, inga kund-id) och `GET /ready` | `collectMetrics`, `renderPrometheus` i `src/db/metrics.ts` | `test/metrics.test.ts`, `test/api/extended.test.ts` | ✅ |
| Tenant-isolering | Alla frågor filtreras på kund; IDOR ger 404 | alla repositorier, `server.ts` | `test/api/server.test.ts`, `test/db/` | ✅ |
| Revisionslogg | Append-only (trigger mot update/delete/truncate), inga belopp eller referenser | `audit_log`, `createAuditLog` | `test/db/repositories.test.ts` | ✅ |
| Inga hemligheter i loggar/fel | Fasta felmeddelanden, tom logger i API, admin skriver aldrig ut indata | `server.ts`, `crypto.ts`, `admin.ts` | `scripts/smoke-steps.sh`, `test/security/` | ✅ |

### Mot omvärlden

| Funktion | Kod | Status |
| --- | --- | --- |
| Hämta utbetalningar från Mondido (`PayoutSource`) | gränssnitt i `src/ports/sources.ts`; simulerad i `src/gateways/fakeSource.ts` | 🔲 adapter saknas |
| Läsa fakturor i Fortnox (`InvoiceReader`) | gränssnitt i `src/ports/sources.ts`; simulerad i `src/gateways/fake.ts` | 🔲 adapter saknas |
| Bokföra i Fortnox (`LedgerGateway`) | gränssnitt i `src/ports/index.ts`; simulerad i `src/gateways/fake.ts` | 🔲 adapter saknas |
| Spiris, fler betalleverantörer | samma gränssnitt | 🔲 |
| Skicka larm | `createWebhookNotifier` + `createAlertDispatcher` i `src/app/notify.ts` (Slack-kompatibel webhook, dämpning). E-post och pager saknas | ✅ webhook · 🔲 e-post/pager |
| Produkt-, lager-, prissynk, order- och fakturaskapande | – | 🔲 ej påbörjat |

## 3. Kodkarta: fil för fil

Läs den som en innehållsförteckning. Interna hjälpfunktioner (ej exporterade) står i kursiv.

### `src/domain/`: typer och pengar (ingen I/O)

| Fil | Ansvar | Funktioner och typer |
| --- | --- | --- |
| `src/domain/money.ts` | Belopp som heltal i minsta enhet, aldrig flyttal | `assertMinor` kontrollerar säkert heltal · `checkedAdd` addition som kastar vid osäkert resultat · `allocate` fördelar exakt (största återstoden) · typ `Minor` |
| `src/domain/types.ts` | Normaliserat format som adaptrar översätter till | `Payout`, `PayoutLine` (payment/refund/fee), `Invoice`, `AccountMapping`, `LedgerCommand` (3 sorter), `ExceptionCode`, `ReconcileInput`, `ReconcileResult` m.fl. |

### `src/engine/`: avstämningsmotorn

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/engine/reconcile.ts` | Ren funktion: indata in, kommandon + avvikelser ut | `reconcile` · *validatePayout, validateInvoiceIds, invoiceProblem, resolveInvoice, splitCreditVat, buildVoucher* |

### `src/ports/`: gränssnitt (kontrakt mot omvärlden)

| Fil | Ansvar | Innehåll |
| --- | --- | --- |
| `src/ports/index.ts` | Skriv- och lagringsportar | `CommandRepository` (enqueue, claimDue, markSucceeded, markFailed, releaseStale, listByPayout, countDead, requeue) · `ExceptionRepository` (add, list, get, resolve) · `PayoutRepository` (record, get, list) · `AuditLog` (append, list) · `UnitOfWork` (run) · `LedgerGateway` (execute, **måste vara idempotent på nyckeln eller köras bakom skyddsgatewayen**) · `LedgerError` (`retryable`, `retryAfterMs`, `notApplied`) · `ProposalRepository` · `GatewayGuardStore` · `Clock` |
| `src/ports/sources.ts` | Läsportar och konfiguration | `PayoutSource` (listPayoutsSince, getPayout) · `InvoiceReader` (findByReferences) · `TenantConfigProvider` · `SyncStateStore` · `TenantConfig` |

### `src/service/`: användningsfall

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/service/processPayout.ts` | Avstäm en utbetalning och spara atomiskt | `processPayout` · *withConflicts, canonical, summarize* |
| `src/service/syncTenant.ts` | Hämta nya + återuppta delvis/avvisade för en kund | `syncTenant` · *count* |

### `src/executor/`: kön till bokföring

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/executor/executor.ts` | Utför köade kommandon mot gatewayen | `runDueCommands` en omgång · `drain` tills tomt · `recoverStale` släpp övergivna · `backoffDelayMs` · konstant `DEFAULT_STALE_AFTER_MS` · *retryDelay, withTimeout, describeError* |

### `src/db/`: Postgres

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/db/db.ts` | Minimalt `Db`-gränssnitt (query, exec, transaction) och PGlite-implementation för test | `createPgliteDb` |
| `src/db/pg.ts` | Riktig Postgres via `pg`-pool; bigint tolkas säkert | `createPgDb`, `parseInt8` |
| `src/db/migrations.ts` | Schemaversioner 001 till 004, körs en gång vardera | `migrate`, listan `migrations` |
| `src/db/repositories.ts` | Kö, avvikelser, utbetalningar, revisionslogg, arbetsenhet | `createCommandRepository`, `createExceptionRepository`, `createPayoutRepository`, `createAuditLog`, `createRepositories`, `createUnitOfWork` |
| `src/db/tenants.ts` | Kunder och API-nycklar | `createTenantRepository` (create, get, setStatus, setMode) · `createApiKeyRepository` (issue, revoke, list, findById, touchLastUsed) |
| `src/db/connections.ts` | Krypterade kopplingar till leverantörer | `createConnectionRepository` (upsert, list, getInfo, setStatus, getCredentialsForExecution, reencryptAll, delete) |
| `src/db/proposals.ts` | Sparade dry_run-förslag per utbetalning | `createProposalRepository` (upsert, list, get, delete) |
| `src/db/gatewayGuard.ts` | Journal över gateway-anrop (Postgres) | `createGatewayGuardStore` (begin, complete, abort, resolve, listInDoubt) |
| `src/db/metrics.ts` | Mätvärden för drift utan kund-id | `collectMetrics` · `renderPrometheus` |
| `src/db/retention.ts` | Gallring med säkra regler samt hjälpare för adminkommandon | `planRetention` · `applyRetention` · `resolveRetentionPolicy` · `DEFAULT_RETENTION_POLICY` · `RetentionPolicyError` · `parseRetentionArgs` · `formatRetentionResult` · `formatAge` · `keyFingerprint` · `parseInDoubtDecision` · `summarizeProposal` |
| `src/db/syncState.ts` | Cursor, kontoplan och kundkonfiguration för synk | `createSyncStateStore`, `setTenantAccounts`, `createTenantConfigProvider`, `listSyncableTenants`, `accountMappingSchema` |

### `src/security/`: nycklar och kryptering

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/security/apiKeys.ts` | API-nycklar: generera, hasha, verifiera, autentisera (även med nyckel-id för revisionsloggen) | `createDetailedAuthenticator`, `generateApiKey`, `hashApiKey`, `verifyApiKey`, `parseApiKeyId`, `createAuthenticator`, konstant `API_KEY_PREFIX` |
| `src/security/crypto.ts` | AES-256-GCM med AAD och nyckelrotation | `encryptSecret`, `decryptSecret`, `parseBlob`, `blobKeyId`, `StaticKeyProvider`, `CryptoError`, gränssnitt `KeyProvider` |

### `src/api/`: HTTP

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/api/server.ts` | Fastify-server med auth, validering (zod), paginering, enhetliga fel, rate limiting, bodygräns, /ready, /metrics | `buildServer` · *atomically, presentException, presentPayout, presentCommand, parse* |
| `src/api/rateLimit.ts` | Token bucket per nyckel/IP med städning och tak | `RateLimiter` (take, peek) · `defaultRateLimitConfig` · `resolveRateLimitConfig` |

### `src/web/` och `web/`: webbgränssnittet

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/web/serve.ts` | Levererar `web/` på `/app` med strikt CSP och en allowlist av fyra filer (ingen path traversal) | `registerWebUi` · `resolveWebRoot` · konstant `WEB_CSP` |
| `web/index.html` | Sidskal: landmärken, hoppa-över-länk, inga inline-skript | |
| `web/app.js` | Vyer (översikt, förslag, utbetalningar, avvikelser, osäkra anrop), inloggning, anrop mot `/v1`. All text sätts som ren text, aldrig som HTML | |
| `web/lib.js` | Ren logik: beloppsformat, åldertext, förklaring av alla avvikelsekoder, felmeddelanden, formulärvalidering | `formatAmount`, `ageText`, `describeCommand`, `voucherBalance`, `parseHash`, `apiErrorMessage`, `validateResolve`, `validateGuardResolve` |
| `web/lib.d.ts` | Typer för `lib.js` så att testerna kan importera den | |
| `web/style.css` | Utseende: ljust/mörkt, fokusmarkering, mobil | |

### `src/http/`: infrastruktur för framtida adaptrar

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/http/client.ts` | Robust HTTP-klient (timeout, storleksgräns, auth, 401-omförsök, inga hemligheter i fel) | `createHttpClient` · konstant `DEFAULT_MAX_RESPONSE_BYTES` |
| `src/http/errors.ts` | En enda klassningstabell från HTTP-utfall till `LedgerError` | `classifyHttpFailure` · `toLedgerError` · `failureToLedgerError` · `parseRetryAfter` · `errorCode` · `safePath` · klassen `HttpLedgerError` · konstant `MAX_RETRY_AFTER_MS` |
| `src/http/rateLimiter.ts` | Token bucket mot leverantörens gränser | `createRateLimiter` |
| `src/http/oauth.ts` | OAuth2-tokenhantering med serialiserad förnyelse | `createOAuth2TokenProvider` |

### `src/app/` och `src/main.ts`: sammansättning och start

| Fil | Ansvar | Funktioner |
| --- | --- | --- |
| `src/app/compose.ts` | Kopplar ihop databas, säkerhet, API och körcykel | `createApp` (inkl. `onDead`) |
| `src/app/notify.ts` | Skickar larm till en människa med dämpning | `createWebhookNotifier` · `createAlertDispatcher` · gränssnitt `Notifier` |
| `src/app/cycle.ts` | En körcykel: återhämta, synka alla kunder, kör kön, skapa larm | `runCycle`, `silentLogger` |
| `src/app/config.ts` | Läser och validerar miljövariabler utan att läcka värden | `parseEnv` |
| `src/app/notConfigured.ts` | Platshållaradaptrar som misslyckas tydligt | `notConfiguredAdapters` |
| `src/main.ts` | Startpunkt: migrera, starta server, schemalägg cykel, graciös nedstängning | (ingen export) |

### `src/gateways/` och `src/testing/`: simulerat

| Fil | Ansvar | Innehåll |
| --- | --- | --- |
| `src/gateways/guarded.ts` | **Skyddsgateway** runt varje riktig gateway: journalför, avgör osäkra utfall, skickar aldrig om på gissning | `GuardedLedgerGateway` |
| `src/gateways/fakeGuard.ts` | Journal i minnet (tester, demo) | `MemoryGatewayGuardStore` |
| `src/gateways/fake.ts` | Simulerat affärssystem, idempotent på nyckel | `FakeLedgerGateway` (failNext, failAfterApplyNext, addInvoice, invoice, executed, vouchers) |
| `src/gateways/fakeSource.ts` | Simulerad leverantör, konfiguration och synkstatus | `FakePayoutSource`, `MemoryTenantConfig`, `MemorySyncState` |
| `src/testing/memory.ts` | Minnesversioner av repositorierna (för API-tester) | `createMemoryStore`, `createMemoryCommandRepository`, `createMemoryExceptionRepository`, `createMemoryPayoutRepository`, `createMemoryProposalRepository`, `createMemoryGatewayGuardStore`. Saknar ordning per utbetalning, använd PGlite när det spelar roll |

### `scripts/` och CI

| Fil | Ansvar |
| --- | --- |
| `scripts/admin.ts` | Adminverktyg (kommandon i avsnitt 6) |
| `scripts/demo.ts` | Berättande demo med simulerade system |
| `scripts/pg-test.sh` | Startar temporär riktig Postgres och kör `test/pg` (eller `PG_RUN_CMD`) |
| `scripts/smoke.sh` | Startar `pg-test.sh` med rökprovet |
| `scripts/smoke-steps.sh` | Stegen i rökprovet: admin, server, API, nedstängning, hemlighetskontroll |
| `.github/workflows/ci.yml` | CI: `npm run check`, Postgres-jobb mot `test/pg`, och ett jobb som bygger Docker-avbilden |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, `tsconfig.build.json` | Produktionsavbild (kompilerad kod, bara produktionsberoenden, icke-root), lokal körning med Postgres och miljömall. Avbilden är **inte byggd här** (ingen Docker-demon), CI bygger den. Se [DEPLOY.md](DEPLOY.md) |

## 4. En utbetalnings väg genom systemet

```mermaid
sequenceDiagram
    autonumber
    participant M as main.ts (timer)
    participant C as runCycle
    participant S as syncTenant
    participant P as PayoutSource (Mondido)
    participant I as InvoiceReader (Fortnox)
    participant PP as processPayout
    participant E as reconcile
    participant DB as Postgres
    participant X as Utförare
    participant G as LedgerGateway (Fortnox)

    M->>C: var CYCLE_INTERVAL_MS
    C->>DB: recoverStale (släpp övergivna)
    C->>S: per aktiv kund
    S->>P: listPayoutsSince(cursor)
    loop varje utbetalning
        S->>I: findByReferences(färsk status)
        S->>PP: processPayout(live eller dry_run)
        PP->>DB: läs redan köade kommandon
        PP->>E: reconcile(settledLineIds)
        E-->>PP: kommandon + avvikelser
        PP->>DB: köa, avvikelser, status, revisionspost (1 transaktion)
    end
    S->>P: getPayout för partial/rejected (återuppta)
    S->>DB: flytta cursor (bara live, bara om inga fel)
    C->>X: drain
    X->>DB: claimDue (nästa i ordning, aktiv live-kund)
    X->>G: execute (idempotent på nyckel, med timeout)
    X->>DB: markSucceeded / markFailed (fencad på försök)
    C->>DB: countDead → kritiskt larm om något väntar på människa
```

## 5. Datamodell

```mermaid
erDiagram
    tenant ||--o{ api_key : "har"
    tenant ||--o{ connection : "har"
    tenant ||--o| sync_state : "har"
    tenant ||--o{ payout : "äger (ingen FK)"
    payout ||--o{ ledger_command : "består av (ingen FK)"
    payout ||--o{ reconcile_exception : "ger (ingen FK)"
    tenant ||--o{ audit_log : "loggas (ingen FK)"
    tenant ||--o{ gateway_guard : "journalför (ingen FK)"
    payout ||--o| dry_run_proposal : "kan ha (ingen FK)"
```

| Tabell | Migration | Innehåll | Repository |
| --- | --- | --- | --- |
| `ledger_command` | 001, 004 | Kön. `seq` ordnar kommandon per utbetalning. Nyckeln är unik per kund | `createCommandRepository` |
| `reconcile_exception` | 001 | Avvikelsekön. Öppen avvikelse unik per (kund, utbetalning, kod, rad) | `createExceptionRepository` |
| `payout` | 001 | Senaste avstämningsstatus per utbetalning (rejected/partial/complete) | `createPayoutRepository` |
| `audit_log` | 001, 004 | Append-only revisionslogg | `createAuditLog` |
| `tenant` | 002, 003 | Kund: status (active/suspended), läge (dry_run/live), kontoplan (jsonb) | `createTenantRepository`, `setTenantAccounts` |
| `api_key` | 002 | HMAC-hash, utgång, återkallning, senast använd | `createApiKeyRepository` |
| `connection` | 002 | Krypterade uppgifter per (kund, leverantör), status | `createConnectionRepository` |
| `sync_state` | 003 | Cursor per kund | `createSyncStateStore` |
| `gateway_guard` | 005 | Journal över gateway-anrop: `started` före, `done` efter. `started` som aldrig blir `done` = okänt utfall | `createGatewayGuardStore` |
| `dry_run_proposal` | 006 | Senaste dry_run-förslag per utbetalning | `createProposalRepository` |
| `schema_migrations` | (skapas av `migrate`) | Vilka migrationer som körts | `migrate` |

**Migrationer:** `001_init` (kö, avvikelser, utbetalning, revisionslogg) · `002_tenants_connections` (kunder, nycklar, kopplingar) · `003_sync_state_and_accounts` (cursor, kontoplan) · `004_command_key_per_tenant_and_audit_truncate` (nyckel per kund, skydd mot truncate) · `005_gateway_guard` (journal över gateway-anrop) · `006_dry_run_proposal` (sparade förslag).

## 6. Gränssnitt utåt

### HTTP-API (alla `/v1`-rutter kräver headern `x-api-key`; detaljer i [API.md](API.md))

| Rutt | Gör |
| --- | --- |
| `GET /health` | Öppen livstecken |
| `GET /app` | Webbgränssnittet (även `/app/app.js`, `/app/lib.js`, `/app/style.css`). Öppet, innehåller inga uppgifter, kräver API-nyckel för all data |
| `GET /v1/exceptions` | Lista avvikelser (`status`, `payoutId`) |
| `GET /v1/exceptions/:id` | En avvikelse |
| `POST /v1/exceptions/:id/resolve` | Stäng avvikelse (resolved/dismissed + anteckning). Loggas |
| `POST /v1/commands/:id/retry` | Köa om dött kommando. Loggas |
| `GET /v1/payouts` | Lista utbetalningar (`status`) |
| `GET /v1/proposals` | Lista sparade dry_run-förslag (`status`) |
| `GET /v1/proposals/:payoutId` | Ett förslag med kommandon och avvikelser |
| `GET /v1/guard/in-doubt` | Anrop till affärssystemet med okänt utfall |
| `POST /v1/guard/resolve` | Avgör ett okänt utfall (utfört/ej utfört). Loggas |
| `GET /ready` | Öppen beredskapskoll mot databasen (200/503) |
| `GET /metrics` | Prometheus-mätvärden. Bara om `METRICS_TOKEN` är satt, bearer-token |
| `GET /v1/payouts/:id` | En utbetalning med dess kommandon |

### Adminkommandon (`npm run admin -- <kommando>`)

`create-tenant` · `set-accounts` · `set-mode` · `suspend` · `activate` · `issue-key` · `revoke-key` · `set-connection` · `list-tenants` · `retention-plan` · `retention-apply` · `list-in-doubt` · `resolve-in-doubt` · `list-proposals`. Varje åtgärd skriver en revisionspost med `actor: admin-cli`.

### npm-skript

| Skript | Gör |
| --- | --- |
| `npm run check` | Typkontroll + alla tester (ingen databas behövs) |
| `npm run typecheck` | Bara typkontroll |
| `npm test` | Bara tester |
| `npm run test:pg` | Tester mot temporär riktig Postgres |
| `npm run smoke` | Rökprov av hela tjänsten |
| `npm run demo` | Berättande demo |
| `npm run admin` | Adminverktyget |
| `npm run build` | Kompilerar till JavaScript (`dist/`) med `tsconfig.build.json` |
| `npm run start:prod` | Startar den kompilerade tjänsten (`dist/src/main.js`), samma som containern |
| `npm run admin:prod` | Adminverktyget kompilerat (`dist/scripts/admin.js`), för containern |
| `npm start` | Starta tjänsten |

### Miljövariabler (läses av `parseEnv`)

`DATABASE_URL` · `API_KEY_PEPPER` (32 byte) · `MASTER_KEYS` (`id:nyckel,...`, första är aktuell) · `PORT` (3000) · `HOST` (0.0.0.0) · `CYCLE_INTERVAL_MS` (60000, 0 = bara API) · `ALERT_WEBHOOK_URL` (valfri, hemlig) · `ALERT_LABEL` (valfri) · `METRICS_TOKEN` (valfri, minst 24 tecken). Testmiljö: `PG_TEST_URL` (riktig Postgres för `test/pg`), `PG_BIN`, `PG_RUN_USER`, `PG_TEST_PORT`, `PG_RUN_CMD` (för `scripts/pg-test.sh`).

### Revisionsposter (`audit_log.action`)

`payout.processed` · `command.dead` · `exception.resolved` · `command.requeued` · `tenant.created` · `tenant.accounts_set` · `tenant.mode_set` · `tenant.active` · `tenant.suspended` · `api_key.issued` · `api_key.revoked` · `connection.set` · `guard.resolved` · `retention.applied`. Innehåller aldrig belopp, referenser eller fria anteckningar.

## 7. Koder och tillstånd

### Avvikelsekoder (`ExceptionCode`): åtgärder i [RUNBOOK.md](RUNBOOK.md)

| Kod | Betyder | Nivå |
| --- | --- | --- |
| `PAYOUT_SUM_MISMATCH` | Raderna summerar inte till utbetalt belopp | hela utbetalningen avvisas |
| `DUPLICATE_LINE_ID` | Samma rad-id två gånger | avvisas |
| `INVALID_AMOUNT` | Negativt/decimal/nollbelopp eller för stora summor | avvisas eller rad |
| `CURRENCY_MISMATCH` | Rad och utbetalning, eller rad och faktura, har olika valuta | avvisas eller rad |
| `INVALID_PAYOUT` | Tomt id, ogiltigt datum, rad utan referens, okänd radtyp | avvisas |
| `EMPTY_PAYOUT` | Utbetalning utan rader | avvisas |
| `DUPLICATE_INVOICE_ID` | Samma faktura-id två gånger i indata | avvisas |
| `NO_MATCH` | Ingen faktura med referensen | rad |
| `AMBIGUOUS_MATCH` | Flera fakturor med samma referens | rad |
| `INVOICE_NOT_OPEN` | Fakturan är redan betald/annullerad (eller obetald vid återbetalning) | rad |
| `AMOUNT_MISMATCH` | Beloppet stämmer inte exakt med fakturans obetalda | rad |
| `REFUND_EXCEEDS_INVOICE` | Återbetalning större än kvarvarande krediterbart | rad |
| `INVALID_INVOICE` | Fakturadata hänger inte ihop (t.ex. moms > total) | rad |
| `COMMAND_CONFLICT` | En redan köad rad har ändrats hos leverantören | rad (sätts av `processPayout`) |
| `INTERNAL_IMBALANCE` | Verifikatet balanserar inte (ska aldrig hända) | verifikat uteblir |

### Tillstånd

| Sak | Värden |
| --- | --- |
| Kommando (`CommandStatus`) | `pending` → `in_progress` → `succeeded`; fel: `failed` (nytt försök) eller `dead` (kräver människa, `requeue` tillbaka till `pending`) |
| Kommandosorter (`LedgerCommand.kind`) | `register_invoice_payment`, `credit_invoice`, `post_voucher` |
| Utbetalning (`PayoutStatus`) | `rejected` · `partial` · `complete` (= avstämd och köad, inte nödvändigtvis utförd) |
| Avvikelse (`ExceptionStatus`) | `open` · `resolved` · `dismissed` |
| Kund | status `active`/`suspended`; läge `dry_run`/`live` |
| Koppling | `active` · `disabled` · `needs_reauth` (bara `active` lämnar ut uppgifter) |

Tillståndsdiagram och regler: [ARCHITECTURE.md](ARCHITECTURE.md) avsnitt 4.

## 8. Testkarta

| Testfil | Täcker |
| --- | --- |
| `test/reconcile.test.ts` | Motorns grundbeteenden: lyckad, omkörning, avvisad, delvis, återbetalningar |
| `test/engine-review.test.ts` | Regression för granskningsfynd (dubbla id, ogiltiga fakturor, moms, nycklar, summor) |
| `test/money.test.ts` | `allocate` |
| `test/scenarios/golden.test.ts` | 16 verkliga e-handelsfall |
| `test/scenarios/properties.test.ts` | Egenskapstester med fast-check |
| `test/scenarios/helpers.ts` | Byggare för scenariotesterna |
| `test/db/repositories.test.ts` | Kö, avvikelser, utbetalningar, revisionslogg, arbetsenhet (PGlite) |
| `test/db/syncState.test.ts` | Cursor och kundkonfiguration |
| `test/e2e.test.ts` | Hela kedjan, felhantering i utföraren, ändrade rader |
| `test/sync.test.ts` | `syncTenant`: nya, återuppta, felisolering, dry_run |
| `test/cycle.test.ts` | `runCycle` och larm |
| `test/app.test.ts` | Hela produkten via HTTP-API, mänskliga åtgärder |
| `test/hardening.test.ts` | Fynd från oberoende granskning |
| `test/api/server.test.ts` | API: auth, isolering, validering, inga läckor |
| `test/api/memory.test.ts` | Minnesrepositorierna |
| `test/security/security.test.ts` | Kryptering, API-nycklar, kunder, kopplingar |
| `test/pg/contract.ts` | Delad kontraktssvit för databaslagret |
| `test/pg/pglite.test.ts` | Kontraktet mot PGlite |
| `test/pg/pg.test.ts` | Kontraktet + samtidighet mot riktig Postgres (kräver `PG_TEST_URL`) |
| `test/pg/features.pg.test.ts` | Gallring, mätvärden, förslag och skyddsgateway mot riktig Postgres (kräver `PG_TEST_URL`) |
| `test/pg/support.ts` | Schema per test för Postgres-sviten |
| `test/helpers.ts` | Gemensamma testhjälpare (klocka, databas, byggare) |
| `test/proposals.test.ts` | Sparade dry_run-förslag |
| `test/guarded.test.ts` | Skyddsgatewayen mot ett affärssystem utan idempotens (minne och Postgres-schema) |
| `test/guard-app.test.ts` | Skyddet genom hela produkten och API:t, inkl. mänskligt avgörande |
| `test/contracts/ports.contract.ts` | Kontraktssviter för `PayoutSource`, `InvoiceReader`, `LedgerGateway` |
| `test/contracts/fakes.test.ts` | De simulerade implementationerna och skyddsgatewayen mot kontrakten |
| `test/notify.test.ts` | Larmutskick och dämpning |
| `test/config.test.ts` | Miljökonfigurationen, inkl. att inga hemligheter läcker |
| `test/metrics.test.ts` | Mätvärden och Prometheus-format |
| `test/retention.test.ts` | Gallring, policyvalidering, adminhjälpare |
| `test/api/extended.test.ts` | Paginering, förslags- och guardrutter, /ready, /metrics, bodygräns |
| `test/api/rateLimit.test.ts` | Rate limiting i API:t |
| `test/http/client.test.ts` | HTTP-klienten mot riktig lokal server |
| `test/http/errors.test.ts` | Klassningstabellen och Retry-After |
| `test/http/oauth.test.ts` | OAuth2-tokenhantering |
| `test/http/rateLimiter.test.ts` | Rate limitern mot leverantör |
| `test/web.test.ts` | Webbgränssnittet: servering, säkerhetsheaders, allowlist, kodens säkerhetsregler (ingen HTML-injektion, inga externa adresser), och `web/lib.js` logik |
| `test/web.e2e.test.ts` | Webbgränssnittet i en **riktig webbläsare** mot en riktig server: inloggning, granskning, XSS-försök, stänga avvikelse, köa om, avgöra osäkert anrop, utloggning, mobil, tangentbord, tenant-isolering. Körs bara om Playwright finns (lokalt, inte i CI) |
| `test/docs.test.ts` | Att den här kartan och övrig dokumentation är komplett |

## 9. Hitta rätt

| Jag vill... | Gå till |
| --- | --- |
| Ändra hur en betalning matchas | `src/engine/reconcile.ts` (`resolveInvoice`) |
| Ändra hur moms fördelas vid kreditering | `splitCreditVat` i `reconcile.ts` |
| Ändra vad verifikatet innehåller | `buildVoucher` i `reconcile.ts` |
| Lägga till en avvikelsekod | `ExceptionCode` i `types.ts`, sedan RUNBOOK + den här kartan |
| Lägga till en endpoint | `server.ts`, sedan API.md + den här kartan |
| Lägga till en tabell/kolumn | ny migration sist i `migrations.ts` (ändra aldrig en körd), sedan avsnitt 5 |
| Koppla in Fortnox | implementera `LedgerGateway` + `InvoiceReader`, koppla i `createApp`-anroparen (`main.ts`). Läs först NEXT_STEPS |
| Koppla in Mondido | implementera `PayoutSource` |
| Ändra omförsök/timeout | `ExecutorOptions` i `executor.ts` |
| Förstå varför något togs bort/ändrades | [DECISIONS.md](DECISIONS.md) och [LOGG.md](LOGG.md) |
| Driftproblem | [RUNBOOK.md](RUNBOOK.md) |
