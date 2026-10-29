# Byggloggen

Kronologisk logg över vad som byggts, hur och vad granskningarna hittade. Lägg till en rad längst ned för varje ny arbetsomgång (se dokumentationsregeln i [INDEX.md](INDEX.md)). Beslut och motiveringar finns i [DECISIONS.md](DECISIONS.md).

## 2026-10-28: första bygget (en natts arbete)

**Bakgrund:** Mondido får dagligen frågan om en koppling mot Synka+ (en befintlig integrationstjänst mellan webbshop och affärssystem). Synka+ verkar långsamt på nya kopplingar. Beslut: bygga en egen, fristående tjänst (eget varumärke, inte Mondido-branding). Första skivan: automatisk avstämning av Mondido-utbetalningar mot fakturor i Fortnox.

### Tidslinje (commits på `claude/synkaplus-platform-lp94d7`)

| Commit | Vad |
| --- | --- |
| `cb0b99a`, `fc59a0a` | README med produktbeskrivning, kopplingar och priser från Synka+-webbplatsen |
| `9608eff` | Teknisk specifikation (`docs/SPEC.md`) |
| `d250201` | Avstämningsmotorn (`reconcile`) med 33 tester |
| `06180d1` | Portar (kö, avvikelser, utbetalningar, affärssystem) |
| `7713322` | Persistens (Postgres-schema, PGlite i test), utförare, tjänstelager, HTTP-API, scenario- och egenskapstester. Motorn härdad efter första granskningen |
| `e2fd7a0` | Synk-orkestrering (`syncTenant`), körcykel med larm, simulerade källor |
| `95337ed` | Kontrollpunkt (WIP) av pågående agentarbete |
| `2688f91` | Appsammansättning (`createApp`), kundkonfiguration, säkerhetslager (kryptering, API-nycklar), dokumentation, CI |
| `972d930` | Dokumentation synkad med ändrad cursor och återköa-endpoint |
| `417f838` | Fynd från riktig Postgres: nyckel unik per kund, fencing av sena arbetare, skydd mot TRUNCATE. Postgres-adapter + samtidighetstester |
| `2d51d79` | Körbar tjänst (`main.ts`), adminverktyg, demo, rökprov, pool-felhanterare |
| `9ddf33f` | `NEXT_STEPS.md` |
| `111e1e8` | Hårdning efter andra oberoende granskningen |

### Hjälpagenter som användes

| Roll | Uppdrag | Resultat |
| --- | --- | --- |
| Granskare 1 | Adversariell granskning av motorn | 8 bekräftade fynd, alla åtgärdade (se nedan) |
| Verifierare | Egenskaps- och scenariotester | 30 tester, hittade ett momsfel som redan var åtgärdat |
| API-byggare | HTTP-API och minnesrepositorier | 45 tester |
| Säkerhetsbyggare | Kryptering, API-nycklar, kunder, kopplingar | 14 tester |
| Postgres-agent | Riktig Postgres-adapter, samtidighetstester mot riktig databas | 46 tester, fyra verkliga fynd |
| Dokumentationsagent | Arkitektur, driftinstruktion, säkerhet, API, beslut, CI | Sju dokument och en lista över kända luckor |
| Granskare 2 | Oberoende granskning av kö, tjänster, säkerhet, API, drift | 9 bekräftade fynd, alla åtgärdade |

### Fynd från granskningarna och vad som gjordes

**Granskning 1 (motorn):** omkörning efter delvis avstämning gav falska avvikelser (→ `settledLineIds`) · dubbla faktura-id matchade fel faktura (→ avvisas) · ogiltiga fakturor kunde krascha motorn eller ge negativ moms (→ `invoiceProblem`) · moms fördelad på totaler gav negativt netto (→ fördelning på kvarvarande) · nyckelkrock via kolon i id (→ kodning) · tyst avrundning nära 2^53 (→ `checkedAdd`) · tom utbetalning blev `complete` (→ `EMPTY_PAYOUT`) · radordning påverkade utfall (→ id-ordning).

**Postgres-agenten (riktig databas):** idempotensnyckeln var globalt unik och blockerade andra kunder (→ migration 004) · försenad arbetare kunde skriva över senare försöks utfall (→ fencing på försöksnummer) · `TRUNCATE audit_log` gick igenom (→ trigger) · `releaseStale` kan släppa kommando som körs (→ dokumenterat, kräver idempotent gateway).

**Granskning 2:** avstängd kund fick köade kommandon utförda · dött kommando efter klar utbetalning syntes aldrig · ogiltigt/noll `Retry-After` brände försök eller låste resten av omgången · två arbetare kunde köra samma kommando vid långsam omgång (→ timeout per anrop, stale 30 min) · dry_run och cursor (→ cursor står kvar, ingen revisionspost) · avvisade utbetalningar återupptogs aldrig · adminverktyget skrev ut delar av hemligheter vid felaktig JSON · mänsklig åtgärd och revisionspost var inte atomiska · inaktiva kopplingar lämnade ut uppgifter.

**Fynd i rökprovet (egen körning):** `pg`-poolen saknade felhanterare så en tappad anslutning kraschade hela processen (→ `pool.on('error')`).

### Läget efter första natten

- 229 tester mot PGlite, 50 mot riktig Postgres 16, rökprov och demo gröna.
- **Inget talar med riktiga Mondido eller Fortnox.** Adaptrar saknas (blockerat av API-dokumentation, konton och nätverksåtkomst).
- Två risker att verifiera först mot Fortnox: dubbelräknad bank via clearingverifikatet, och gatewayens idempotens. Se [NEXT_STEPS.md](NEXT_STEPS.md).

## 2026-10-29: dokumentation och karta

- `docs/FUNKTIONSKARTA.md`: komplett karta över funktioner, filer, diagram, tabeller, rutter, koder, tester.
- `docs/INDEX.md`: index, läsordning och dokumentationsregel.
- `docs/LOGG.md`: den här loggen.
- `docs/karta-system.png`: färdigrenderad systemkarta (ögonblicksbild av första diagrammet).
- `test/docs.test.ts`: underkänner bygget om dokumentationen blir ofullständig (kodfiler, exporter, rutter, avvikelsekoder, tabeller, migrationer, skript, adminkommandon, miljövariabler, revisionsposter, testfiler, trasiga länkar). Verifierat genom att lägga till en odokumenterad fil: testet slog larm med exakt namn.
- Alla sex mermaid-diagram renderades i headless Chromium för att säkerställa giltig syntax. En första fristående SVG visade sig vara trasig utanför webbläsare och ersattes av PNG.
- Föråldrade påståenden i `ARCHITECTURE.md` rättade.

## 2026-10-29: bygget som inte kräver Mondido eller Fortnox

**Mål:** bygga allt som går utan riktiga API:er, för att göra den dag adaptrarna skrivs så liten och riskfri som möjligt.

| Del | Vad |
| --- | --- |
| Skyddsgateway | `GuardedLedgerGateway` + journal (`gateway_guard`, migration 005). På som standard. Bevisat mot ett affärssystem utan idempotens |
| Sparade dry_run-förslag | `dry_run_proposal` (migration 006), API och CLI |
| Kontraktssviter | `test/contracts/`: färdiga tester för `PayoutSource`, `InvoiceReader`, `LedgerGateway`. Negativt verifierade (ett naivt affärssystem faller) |
| Larmutskick | Webhook (Slack-kompatibel) med dämpning, `ALERT_WEBHOOK_URL` |
| HTTP-infrastruktur | `src/http/`: klient, felklassning, rate limiter, OAuth2 (agent) |
| API-hårdning | Paginering, rate limiting, bodygräns, `/ready`, `/metrics`, nyckel-id i revisionslogg, guard- och förslagsrutter (agent) |
| Gallring | `src/db/retention.ts` + adminkommandon (agent) |
| Konfiguration | Tester för `parseEnv`, nya variabler |

**Agenter:** HTTP-infrastruktur, API-hårdning och gallring byggdes av tre parallella agenter med disjunkta filer. Alla körde samma modell som huvudsessionen (`claude-sonnet-5-5`, medium effort); det blev ungefär 1,4 miljoner tokens totalt för tio agenter under hela bygget. Beslut att dra ner: inga fler agenter för småsaker, billigare modell och låg effort för mekaniskt arbete, riktade testkörningar, och ny session efter större etapper (huvudkontexten var över 535 000 tokens, vilket är det som driver kostnaden mest).

**Fynd och lärdomar:** agenternas rapporter pekade på att `guard.resolve` och revisionspost inte var atomiska (löst: `guard` ingår nu i `Repositories`), att paginering av förslag och osäkra anrop sker i minnet, och att rate limiter-tillstånd ligger i processminne. Fake-gatewayens definitiva avvisningar markerades `notApplied` så att skyddet kan skilja dem från okänt utfall. Demon byttes till ett 429-liknande fel av samma skäl.

## 2026-10-29: underlag och driftsättning

| Del | Vad |
| --- | --- |
| Datakontrakt för Mondido | `docs/MONDIDO_DATAKONTRAKT.md`: fält, regler, 15 frågor, testdata, acceptans via kontraktssviten |
| Testplan för Fortnox | `docs/FORTNOX_TESTPLAN.md`: tio tester i ordning, hypoteser tydligt märkta som overifierade, resultattabeller, koppling till kodändringar |
| Beslut till redovisningskonsult | `docs/BESLUT_REDOVISNING.md`: tio beslut, exempelverifikat hämtade direkt från motorn |
| Driftsättning | `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/DEPLOY.md`, produktionsbygge (`npm run build`), CI-jobb som bygger avbilden |

**Verifierat:** kompilerat bygge klarar rökprovet (`SMOKE_PROD=1`), och en simulerad produktionsinstallation (`npm ci --omit=dev`, utan utvecklingsberoenden) laddar alla importer och ger ett tydligt konfigurationsfel utan hemligheter. **Inte verifierat:** själva Docker-avbilden och compose-filen, eftersom ingen Docker-demon finns i utvecklingsmiljön. CI-jobbet `docker` bygger den vid nästa push; verifiera lokalt första gången.

## 2026-10-29: webbgränssnitt för granskning

| Del | Vad |
| --- | --- |
| Gränssnittet | `web/` (HTML, CSS, JavaScript utan byggsteg och utan beroenden), levereras på `/app` av `src/web/serve.ts` |
| Vyer | Översikt, förslag (med verifikat som visar att det balanserar), utbetalningar (köa om), avvikelser (förklaring + stängning med anteckning), osäkra anrop (avgörande med varningar) |
| Säkerhet | Strikt CSP, allowlist av fyra filer, all text som ren text, nyckel bara i `sessionStorage`, bekräftelsedialoger |
| Tester | `test/web.test.ts` (servering, kodens säkerhetsregler, logik) och `test/web.e2e.test.ts` (riktig Chromium mot riktig server) |

**Vad webbläsartestet hittade som ingen annan test hade fångat:** ett 401 vid inloggning ritade om formuläret så att felmeddelandet hamnade på ett borttaget element (användaren såg inget fel); webbläsarens egen validering (`required`) blockerade våra tillgängliga felmeddelanden (löst med `novalidate`); nästlade listor och `null` skrevs ut som text (`[object HTMLDivElement]null`, `null` längst ned i listor); och `parseHash` behöll ett id för en okänd sida. Skärmbilder granskades för både skrivbord och mobil.

**Verifierat:** 23 tester för gränssnittet gröna, inklusive ett XSS-försök via en skadlig referens som visas som text och inte körs, att inga skriptfel eller CSP-överträdelser sker, att nyckeln aldrig hamnar i `localStorage` eller cookies, att en annan kunds nyckel inte ser något, mobilbredd utan horisontell scroll och tangentbordsnavigering. Webbläsartestet körs lokalt (kräver Playwright) och hoppas över i CI.
