# Konkurrentanalys: Synka+ och marknaden för avstämning mot Fortnox och Spiris

Status per 2026-10-31. **Metod och begränsning:** underlaget kommer från webbsökningar. Varken `synkaplus.se` eller `fortnox.se` gick att läsa direkt från byggmiljön (namnen löses inte upp: domänerna är inte tillåtna i sessionens nätverk), så uppgifter om Synka+ kommer från sökresultat, Fortnox och Spiris marknadsplatser och det du själv klistrade in. Det är inte en fullständig genomgång. Varje uppgift är märkt **[källa]** (sett i sökresultat), **[du]** (från din egen text) eller **[hypotes]** (min tolkning, inte verifierad). Prisuppgifter ska kontrolleras mot respektive webbplats innan de används externt.

## 1. Viktigaste fyndet: Mondido har redan en koppling till Fortnox

**[källa]** På Fortnox marknadsplats finns *Mondido Basic* från **Automatisera Mera**. Den beskrivs så: kopplingen skannar dagligen bolagets Mondido- och Fortnox-konto, matchar Mondido-inbetalningar mot befintliga kundfakturor eller ordrar med matchningsalgoritmer, betalmarkerar dem och konterar Mondidos transaktionsavgifter. Den stöder krediter och alla valutor, och förutsätter att kunden har en koppling från webbshopen till Fortnox som skapar kundfakturor eller ordrar. Något pris hittades inte.

**Vad det betyder [hypotes]:**
- Vi är inte först med Mondido till Fortnox. Det du får frågor om varje dag är alltså sannolikt *Synka+ som helhet* (webbshop till Fortnox) och inte själva avstämningen.
- Vår modell (matcha mot fakturor som webbshopskopplingen redan skapat) är **samma förutsättning** som Mondido Basic har. Skillnaden måste ligga i annat än själva matchningen: onboarding, insyn, tillförlitlighet och pris.
- Det är värt att veta exakt vad Mondido Basic gör idag och var kunderna är missnöjda, innan vi bygger vidare på just den delen. Du kan fråga Mondidos kundtjänst, som sannolikt har sett återkommande ärenden.

## 2. Synka+ (KodAkuten AB)

| Uppgift | Källa |
| --- | --- |
| Finns på Fortnox marknadsplats för **Shopify**, **WooCommerce**, **Magento 2** och en produkt kallad *SYNKA+ Avtalat*. Finns även på Spiris partnersida (Shopify). Ingen KodAkuten-sida för PrestaShop hittades, trots att den står i din prislista | [källa], [du] |
| Shopify: pris- och lagersynk, OSS (One Stop Shop), automatisk avstämning mot Shopify Payments-utbetalningar, returer och delreturer | [källa] |
| WooCommerce: pris- och lagersynk, retur skapar kreditfaktura, avstämning mot betallösningar som Svea Checkout och Klarna Checkout, OSS utan extra kostnad | [källa] |
| Magento 2: automatiserar kunder, kundfakturor och ordrar, kreditfaktura vid retur, synk av äldre ordrar | [källa] |
| Betyg på Fortnox marknadsplats: WooCommerce **5,0 från 8 betyg**, 0–25 företag använder den. Shopify: ett omdöme (positivt), KodAkuten svarade i mars 2025 | [källa] |
| Att komma igång sker genom att **kontakta Synka+ per e-post eller telefon** (Spiris-sidan). Ingen självbetjäning är synlig | [källa] |
| Priser: grundpaket 499–1 400 kr/mån beroende på webbshop och affärssystem, betalleverantör som tillägg för 150–250 kr/mån, AutoPrint 199 kr/mån | [du] |
| Betalleverantörer enligt din lista: Klarna, Mollie, Nets Easy, PayPal, Ledyer, Dintero, Qliro samt CDON. **Mondido står inte med** | [du] |
| Kundcase på Fortnox: "integrationen dubblade omsättningen". Det är marknadsföring, inte ett oberoende omdöme | [källa] |

**Vad som inte gick att fastställa:** hur snabbt Synka+ svarar i praktiken, hur ofta avstämningar går fel, antal kunder, och vad som sker vid fel. Din bild av att de är långsamma är en rimlig hypotes men jag har **inget underlag för eller emot** den. Betygen ovan är mycket små stickprov och talar snarare för nöjda kunder än tvärtom.

## 3. Övriga som gör avstämning av utbetalningar

| Aktör | Vad de gör | Pris | Källa |
| --- | --- | --- | --- |
| **Automatisera Mera** (Fortnox-marknadsplatsen) | En "Basic"-koppling per betalleverantör: Klarna (Basic/Plus/Pro), Svea, Dintero, Avarda, Qliro, Worldline, CDON Pay, Mollie, Shopify Pay, **Mondido**, PrestaShop. Klarna Basic beskrivs som den mest träffsäkra och kräver webbshopskoppling som skapar fakturor. Klarna Pro skapar en samlingsverifikation per dag eller vecka för hög volym | Ej funnet | [källa] |
| **Junipeer** | Utbetalningar från Klarna, Mollie, Adyen, Svea, Qliro m.fl. synkas till Fortnox och Spiris i nära realtid, med statusspårning och felvarningar. Varje betalleverantör är en egen prenumeration | Ej publikt ("kontakta") | [källa] |
| **Sharespine** | Webbshopskopplingar (Shopify, WooCommerce, PrestaShop, Magento m.fl.) med automatiserad bokföring och avstämning av betalsätt, samt betalkopplingar mot Spiris. En recension kritiserar priset, en annan (maj 2026) beskriver problem med importerad data | Shopify från **590 kr/mån**, plattformen från 195 kr/mån | [källa] |
| **Linkbase** | Klarna till Fortnox: en verifikation per utbetalning med underlag som visar vilka transaktioner den täcker, konton per momssats och land | Ej funnet | [källa] |
| **Cloudify**, **Uniwin**, **E-Connector** | Shopify till Fortnox (order, produkter, kunder, lager), Cloudify med omkörning av misslyckade synkar | Uniwin 20 USD/mån, Sharespine-appen 29 USD/mån, E-Connector från 59 USD/mån | [källa] |
| **Fortnox egen** Shopify- och WooCommerce-koppling | Shopify: bokföring och dagsavslut, mer orderdata planeras. WooCommerce: bokför försäljning och returer, OSS | Ingår | [källa] |
| **APIcenter**, **BjornTech**, **Wetail** | Allmänna integrationer (80+ system), WooCommerce-plugin med verifikat för utbetalningar, WooCommerce (3,7 från 15 betyg) | Ej funnet | [källa] |

## 4. Fortnox API: fakta som påverkar oss

Från Apidecks genomgång och Fortnox API-dokumentation i sökresultaten **[källa]** (ska bekräftas mot Fortnox egen utvecklarportal innan adaptern byggs):

- Gräns: **25 anrop per 5 sekunder per åtkomsttoken**, annars `429`. Sidindelning `limit` (högst 500) och `offset`.
- OAuth 2.0 (authorization code). Den gamla fasta åtkomsttoken avvecklades helt 2025-04-30.
- Behörigheter ges **per resurs med både läs och skriv**, ingen enbart-läs-variant. Utökas behörigheterna måste kunden aktivera om kopplingen.
- Som partner krävs ett aktivt utvecklarkonto och en publicerad integration som köps via Fortnox, samt **svenskt person- eller organisationsnummer** vid registrering.

**Konsekvenser:** (1) bolaget bakom varumärket måste finnas (organisationsnummer) innan utvecklarkontot går att få, så beslutet om bolagsform blockerar mer än jag tidigare noterat. (2) `src/http/rateLimiter.ts` ska konfigureras till 25 per 5 sekunder per kund. (3) Vi kan inte be om "läsbehörighet först" och utöka senare utan att kunden aktiverar om, så onboardingen ska begära rätt behörigheter direkt. (4) Eftersom skrivbehörighet beviljas per resurs är det extra viktigt att vi i dry_run aldrig skriver, vilket redan gäller.

## 5. Var vi kan bli bättre

Allt här är **[hypotes]**: det bygger på vad som är synligt hos konkurrenterna, inte på att jag sett hur de fungerar internt.

| Möjlighet | Varför | Status hos oss |
| --- | --- | --- |
| **Självbetjäning med förhandsvisning före betalning** | Synka+ kräver kontakt per e-post eller telefon, Junipeer visar "kontakta". En kund som kan koppla på sig, se vad som *skulle* bokföras och hur stor andel som matchar utan att köpa något sänker tröskeln | Checklista och godkännande finns. **Sammanställning av träffsäkerhet byggs nu** |
| **Underlag en revisor kan lita på** | Linkbase lyfter fram verifikat med underlag per utbetalning. Bokföringslagen kräver spårbarhet | Verifikat och revisionslogg finns. **Export av underlag byggs nu** |
| **Aldrig gissa, aldrig dubbelbokföra, och visa varför** | Få av konkurrenterna beskriver vad som händer vid fel. Våra avvikelsekoder förklarar varje fall och skyddsgatewayen förhindrar dubbelbokning | Finns och är testat |
| **Rätt behörigheter** | Granskning och godkännande av go-live bör inte vara samma person som alla med en nyckel | **Byggs nu** (roller) |
| **Pris per betalleverantör är en tröskel** | Synka+ tar 150–250 kr/mån extra per betalleverantör, Junipeer en prenumeration per leverantör. Ett pris som inte straffar flera betalsätt kan vara ett skäl att byta | Ej bestämt. Ditt beslut |
| **Neutralitet** | Du är VD på Mondido. En tjänst som tar *alla* betalleverantörer (inte bara Mondido) är mer trovärdig för kunder som använder flera | Arkitekturen stöder det (`PayoutSource`). Ditt beslut |

## 6. Vad jag inte vet och hur vi får reda på det

1. **Hur Synka+ fungerar och presterar i verkligheten.** Bästa källan är en kund som använder dem: be 2–3 Mondido-handlare som har Synka+ visa vad de ser. Det är värt mer än all webbsökning.
2. **Vad Mondido Basic kostar och var det brister.** Fråga Mondidos kundtjänst.
3. **Synka+ egen webbplats.** `synkaplus.se` och `fortnox.se` behöver tillåtas i sessionens nätverk (inställningar för miljön) för att jag ska kunna läsa dem direkt. Då kan jag gå igenom alla undersidor, villkor, FAQ och marknadsplatsens fulla recensioner.
4. **Marknadsandelar och kundantal.** Inget i sökresultaten.
