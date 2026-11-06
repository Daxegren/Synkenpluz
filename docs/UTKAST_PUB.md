# Utkast: personuppgiftsbiträdesavtal (PUB)

> **Detta är ett utkast, inte ett färdigt avtal, och det är inte juridiskt granskat.** Det är skrivet för att en jurist ska kunna börja från något som stämmer med vad systemet faktiskt gör, i stället för från en tom mall. Allt inom [hakparenteser] är öppet. Låt en jurist granska innan det används med en kund. Det ersätter inte juridisk rådgivning.

Parterna: **[Kunden, organisationsnummer]** ("Personuppgiftsansvarig") och **[Bolaget bakom tjänsten, organisationsnummer]** ("Personuppgiftsbiträdet"). Avtalet gäller behandling av personuppgifter när biträdet tillhandahåller **[tjänstens namn]** ("Tjänsten") enligt huvudavtalet [datum].

## 1. Vad behandlingen gäller

| Punkt | Innehåll |
| --- | --- |
| Ändamål | Automatisk avstämning och bokföring av betalleverantörens utbetalningar mot fakturor i den ansvariges affärssystem (t.ex. Fortnox), samt granskning av resultatet |
| Art av behandling | Hämtning, lagring, jämförelse, strukturering, visning och radering. Ingen profilering och inget beslutsfattande som avser enskilda personer |
| Kategorier av registrerade | Den ansvariges kunder (köpare i webbshopen) |
| Typer av personuppgifter | Betalningsreferenser (t.ex. ordernummer), fakturanummer, belopp och datum. Tjänsten är konstruerad för att **inte** lagra namn, adresser, kortuppgifter eller personnummer; en referens kan ändå vara kopplad till en person hos den ansvarige. [Bekräfta mot varje ny adapter] |
| Uppgifter om användare hos den ansvarige | API-nyckelns id, roll och tidpunkt för användning samt åtgärder i revisionsloggen (vem som godkände, stängde en avvikelse osv.) |
| Varaktighet | Så länge huvudavtalet gäller, och därefter enligt punkt 9 |

## 2. Instruktioner

Biträdet behandlar personuppgifterna bara enligt den ansvariges dokumenterade instruktioner, vilka utgörs av detta avtal, huvudavtalet och den ansvariges inställningar i Tjänsten (till exempel kontoplan, läge dry_run eller live, och vem som har vilka roller). Anser biträdet att en instruktion strider mot dataskyddsreglerna ska det genast informera den ansvarige.

## 3. Sekretess

Personer hos biträdet som har åtkomst till personuppgifterna har förbundit sig att iaktta sekretess eller omfattas av lagstadgad tystnadsplikt. Åtkomsten är begränsad till dem som behöver den. [Beskriv intern åtkomstrutin för produktionsdatabasen.]

## 4. Säkerhetsåtgärder (artikel 32)

Biträdet vidtar åtminstone följande åtgärder. De motsvarar vad som är implementerat och beskrivs i detalj i SECURITY.md.

- **Isolering mellan kunder:** varje fråga och åtgärd är avgränsad till en kund. Ingen kund kan läsa en annans data.
- **Åtkomst:** personliga API-nycklar som lagras som hash, med utgångsdatum, återkallning och roller (läsare, handläggare, godkännare). Misslyckade inloggningar begränsas.
- **Kryptering:** anslutningsuppgifter till tredje part lagras krypterade (AES-256-GCM, bundna till kund och koppling, med nyckelrotation). Kommunikation sker över TLS. [Bekräfta kryptering i vila för databas och säkerhetskopior hos driftleverantören.]
- **Spårbarhet:** en oföränderlig revisionslogg över mänskliga och automatiska åtgärder, utan belopp, referenser eller personuppgifter.
- **Dataminimering och gallring:** bara det som avstämningen kräver sparas. Tekniska bokföringskommandon för klara utbetalningar gallras efter [antal] dagar [standard 400, ska bekräftas med redovisningskonsult].
- **Skydd mot dubbelbokföring och fel:** system för att aldrig bokföra på gissning och för att kunna visa vad som hänt.
- **Ingen hemlig information i loggar eller felmeddelanden:** nycklar, token och belopp loggas inte.
- [Fyll i: säkerhetskopiering, återställningsprov, övervakning, åtkomstloggning på driftsnivå.]

## 5. Underbiträden

Den ansvarige ger biträdet ett [allmänt / särskilt] godkännande att anlita underbiträden. Biträdet för en förteckning och informerar om planerade ändringar [antal] dagar i förväg så att den ansvarige kan invända. Biträdet säkerställer att underbiträden åläggs samma skyldigheter som i detta avtal och ansvarar för deras fullgörande.

| Underbiträde | Tjänst | Plats | Överföring utanför EU/EES |
| --- | --- | --- | --- |
| [Driftleverantör] | Hosting av applikation | [Land] | [Nej / Ja, med skyddsåtgärd] |
| [Databasleverantör] | Databas och säkerhetskopior | [Land] | [Nej / Ja, med skyddsåtgärd] |
| [Övervakning/larm] | Driftlarm (utan personuppgifter) | [Land] | [..] |

Affärssystemet (t.ex. Fortnox) och betalleverantören (t.ex. Mondido) är den ansvariges **egna** leverantörer, inte biträdets underbiträden. Biträdet kopplar bara upp sig mot dem på den ansvariges uppdrag och med den ansvariges åtkomst. [Bekräfta med jurist.]

## 6. Överföring till tredje land

Biträdet överför inte personuppgifter utanför EU/EES [utan den ansvariges godkännande och en giltig överföringsgrund enligt kapitel V i dataskyddsförordningen]. [Bekräfta mot driftleverantörens platser.]

## 7. Stöd till den ansvarige

Biträdet hjälper, med hänsyn till behandlingens art, den ansvarige att besvara begäranden från registrerade (tillgång, rättelse, radering med mera), och att uppfylla skyldigheterna om säkerhet, incidentanmälan, konsekvensbedömning och förhandssamråd. Begäranden från registrerade som kommer direkt till biträdet vidarebefordras utan dröjsmål.

## 8. Personuppgiftsincident

Biträdet underrättar den ansvarige **utan onödigt dröjsmål och senast inom [24] timmar** efter att ha fått kännedom om en personuppgiftsincident, med den information som behövs för att den ansvarige ska kunna anmäla till Integritetsskyddsmyndigheten inom 72 timmar när det krävs. [Beskriv kontaktväg och beredskap.]

## 9. Radering och återlämnande

När Tjänsten upphör raderar biträdet personuppgifterna eller lämnar tillbaka dem enligt den ansvariges val, och raderar befintliga kopior, **om inte lagen kräver fortsatt lagring**. Revisionsloggen innehåller inga personuppgifter och sparas [så länge som krävs för spårbarhet]. Radering sker senast [antal] dagar efter avtalets upphörande. [Beskriv hur radering kontrolleras och bekräftas.]

Obs! Bokföringslagen kräver att räkenskapsinformation sparas länge. Den ansvariges **bokföring finns i affärssystemet**, inte hos biträdet; biträdet sparar bara tekniskt underlag för spårbarhet. [Låt redovisningskonsult och jurist bekräfta fördelningen.]

## 10. Revision och tillsyn

Biträdet ger den ansvarige den information som krävs för att visa att skyldigheterna fullgjorts, och medger och bidrar till granskningar, inklusive inspektioner, som utförs av den ansvarige eller en revisor som denne utsett. [Ange förfarande, framförhållning och kostnadsfördelning.]

## 11. Ansvar och tillämplig lag

[Ansvarsbegränsning, tillämplig lag (svensk rätt) och tvistlösning. Låt jurist avgöra.]

## Öppna frågor till jurist och driftsansvarig

1. Är rollfördelningen rätt (kunden som ansvarig, vi som biträde)? Påverkas den av att tjänsten väljer hur avstämningen sker?
2. Räknas Fortnox och betalleverantören som den ansvariges leverantörer eller som våra underbiträden?
3. Vilka lagringstider ska gälla, och hur förhåller de sig till bokföringslagen?
4. Vilken hosting väljs, var ligger data, och finns överföring utanför EU/EES?
5. Vilken incidentberedskap och jour kan vi faktiskt lova (24 timmar)?
6. Behövs en konsekvensbedömning (DPIA)? Behandlingen är begränsad till betalreferenser och belopp, men en jurist bör avgöra.
