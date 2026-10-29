# Beslut till redovisningskonsult

**Till:** redovisningskonsult (eller bokföringsansvarig) hos en pilotkund. **Syfte:** vi bygger en tjänst som automatiskt bokför och stämmer av betalleverantörens utbetalningar. Innan någon kund går live behöver ni, som kan bokföring, godkänna eller ändra hur vi bokför. Vi vill att ni svarar på **konkreta exempel**, inte abstrakta frågor.

Det här är inget juridiskt eller skatterättsligt underlag. Vi har gjort antaganden nedan för att ha något att visa, och **ni avgör vad som är rätt**. Där vi är osäkra står det.

## Så fungerar det i korthet

Kunden säljer i en webbshop. Fakturan/ordern finns i affärssystemet. När betalleverantören betalar ut pengar (efter att ha dragit sina avgifter) gör vi tre saker automatiskt:

1. **Registrerar en inbetalning** på varje faktura som betalats (en per betalning).
2. **Krediterar fakturan** när en återbetalning har gjorts (hel- eller delkreditering).
3. **Bokför ett verifikat per utbetalning** som flyttar pengarna från ett *clearingkonto* till banken och bokför avgifterna.

Säkerhetsregler som alltid gäller: vi bokför bara när referens och belopp stämmer **exakt**. Allt tveksamt hamnar i en avvikelsekö för en människa, och inget gissas. Nya kunder startar i **testläge** där vi bara visar förslag och inte bokför något.

## Exempel: så här skulle vi bokföra (med nuvarande antaganden)

Konton är **exempel** (bank 1930, clearing 1580, avgifter 6570, ingående moms 2641). Belopp i kronor.

### Exempel 1: två betalningar med avgifter

Utbetalning med två betalningar: order 1001 om 1 490,00 kr (avgift 39,00 kr, varav moms 7,80 kr) och order 1002 om 599,00 kr (avgift 17,00 kr, varav moms 3,40 kr). Till banken betalas 2 033,00 kr.

| Steg | Vad vi gör |
| --- | --- |
| 1 | Registrerar inbetalning 1 490,00 kr på faktura 1001 |
| 2 | Registrerar inbetalning 599,00 kr på faktura 1002 |
| 3 | Bokför verifikatet nedan |

| Konto | Namn (exempel) | Debet | Kredit |
| --- | --- | ---: | ---: |
| 1930 | Bank | 2 033,00 | |
| 6570 | Betalningsavgifter (netto) | 44,80 | |
| 2641 | Ingående moms | 11,20 | |
| 1580 | Clearing | | 2 089,00 |

### Exempel 2: delåterbetalning

Handlaren återbetalar 500,00 kr av en betald faktura på 1 490,00 kr (moms 298,00 kr). Beloppet dras från nästa utbetalning.

| Steg | Vad vi gör |
| --- | --- |
| 1 | Krediterar fakturan med 500,00 kr: netto **400,00**, moms **100,00** (momsen fördelas proportionellt mot det som återstår att kreditera) |
| 2 | Bokför verifikatet nedan |

| Konto | Namn (exempel) | Debet | Kredit |
| --- | --- | ---: | ---: |
| 1580 | Clearing | 500,00 | |
| 1930 | Bank | | 500,00 |

### Exempel 3: betalning och återbetalning i samma utbetalning

En betalning om 250,00 kr (avgift 8,00 kr, varav moms 1,60 kr) och en återbetalning om 500,00 kr. Utbetalningen blir negativ: banken *belastas* med 258,00 kr.

| Konto | Namn (exempel) | Debet | Kredit |
| --- | --- | ---: | ---: |
| 1580 | Clearing | 250,00 | |
| 6570 | Betalningsavgifter (netto) | 6,40 | |
| 2641 | Ingående moms | 1,60 | |
| 1930 | Bank | | 258,00 |

## Besluten

För varje beslut: **fråga**, varför det spelar roll, **vårt nuvarande antagande**, alternativ, och en ruta för ert svar.

### D1. Avgiftens konton och moms

**Fråga:** Vilka konton ska betalningsavgifter bokföras på, och ska de ha moms?
**Varför det spelar roll:** exemplen ovan bokför avgiftens momsdel som ingående moms (2641). Är betalleverantörens avgifter momsfria (vi vet inte om det gäller här, det är er bedömning) ska momsraden vara noll och hela avgiften gå till kostnadskontot.
**Antagande:** avgiften levereras av betalleverantören uppdelad i netto och moms; vi bokför det som levereras.
**Alternativ:** (a) bokför moms som i exemplen, (b) momsfri avgift, allt på kostnadskonto, (c) olika per avgiftstyp.
**Era kontonummer:** avgift (netto) `____`, ingående moms `____`.
**Svar:** `__________`

### D2. Clearingkonto

**Fråga:** Vilket konto ska användas som mellankonto (clearing) för pengar som är betalda men inte utbetalda?
**Varför det spelar roll:** inbetalningen på fakturan ska debitera clearingkontot, och verifikatet nollställer det mot banken. **Om affärssystemet i stället bokför banken direkt vid inbetalning blir banken dubbelräknad** (detta provas i sandboxen, se [FORTNOX_TESTPLAN.md](FORTNOX_TESTPLAN.md) Test 2).
**Antagande:** ett särskilt clearingkonto per betalleverantör, t.ex. 1580. Saldot ska vara noll efter varje bokförd utbetalning.
**Svar (kontonummer):** `____` &nbsp; **Ett per betalleverantör?** ja / nej

### D3. Hur återbetalningar bokförs

**Fråga:** Ska en återbetalning bokföras som **kreditfaktura** kopplad till originalfakturan, eller som en **korrigerad inbetalning**?
**Varför det spelar roll:** påverkar moms (utgående moms ska minska vid kreditering), kundreskontra och revisionsspår.
**Antagande:** kreditfaktura med moms fördelad proportionellt (exempel 2).
**Alternativ:** (a) kreditfaktura (antagandet), (b) korrigera inbetalningen, (c) beroende på om återbetalningen avser hel faktura eller del.
**Svar:** `__________`

### D4. Delbetalningar och avvikande belopp

**Fråga:** Vad ska hända när en betalning inte exakt motsvarar fakturans obetalda belopp (för lite, för mycket)?
**Varför det spelar roll:** idag **bokför vi ingenting automatiskt** i det fallet. Det går till avvikelsekön för manuell hantering. Det är säkrast men kan ge mycket manuellt arbete om det är vanligt.
**Antagande:** exakt belopp krävs. Allt annat blir avvikelse.
**Alternativ:** (a) behåll (säkrast), (b) tillåt delbetalning som lämnar fakturan delvis betald, (c) tillåt små differenser (öresavrundning) upp till `____` kr.
**Svar:** `__________`

### D5. Verifikatserie och underlag

**Fråga:** Vilken verifikatserie ska vi använda, och vilket underlag/vilken text ska stå på verifikatet?
**Varför det spelar roll:** spårbarhet vid revision. Idag står "Utbetalning <id>" som text och ingen serie anges.
**Antagande:** en egen serie för automatiska utbetalningsverifikat.
**Serie:** `____` &nbsp; **Önskad text/referens:** `__________`

### D6. Hur länge sparas data (gallring)

**Fråga:** Hur länge ska vi spara de tekniska bokföringskommandona (inbetalningar, krediteringar, verifikat) i vårt system innan de raderas?
**Varför det spelar roll:** GDPR kräver att personuppgifter inte sparas längre än nödvändigt, men bokföringslagen kräver att räkenskapsinformation sparas länge. Själva bokföringen finns i affärssystemet, men vi vill inte radera vårt spårbarhetsunderlag för tidigt. Vår revisionslogg raderas aldrig.
**Antagande:** 400 dagar, och aldrig mindre än 30. Vår bedömning är att räkenskapsinformation normalt ska sparas i sju år efter räkenskapsårets slut, men **det avgör ni**.
**Svar (antal dagar eller regel):** `__________`

### D7. Valuta

**Fråga:** Förekommer utbetalningar eller fakturor i annan valuta än SEK hos kunden?
**Varför det spelar roll:** vi **avvisar** idag utbetalningar med flera valutor och stödjer inte växling. Behövs det byggs det, och då måste vi veta hur kursdifferenser ska bokföras.
**Svar:** `__________`

### D8. Perioder, stängda år och spärrar

**Fråga:** Vad ska hända om en utbetalning avser en period som är låst eller ett stängt räkenskapsår?
**Antagande:** systemet stoppar, lyfter ett larm till en människa och bokför inget.
**Alternativ:** (a) stoppa (antagandet), (b) bokför på första öppna dag.
**Svar:** `__________`

### D9. Vem granskar och godkänner innan kunden går live

**Fråga:** Under testläget visar vi förslag på vad som *skulle* bokföras. Vem hos kunden eller hos er ska granska dem, hur många utbetalningar ska granskas, och vad krävs för att godkänna?
**Varför det spelar roll:** när kunden går live bokförs **allt som granskats på en gång**. Det är den enda grinden mot felbokning.
**Förslag:** minst `____` utbetalningar eller `____` veckor i testläge utan anmärkning, granskade av `__________`.
**Svar:** `__________`

### D10. Avvikelser som människor hanterar

**Fråga:** Vem hos kunden ska få larm och hantera avvikelser (okänd referens, avvikande belopp, osäkra utfall), och hur snabbt?
**Förslag på nivåer:** kritiskt (kommando kan inte utföras, osäkert utfall) inom `____`, varning (avvikelse som kräver granskning) inom `____`.
**Svar:** `__________`

## Kontrollera även

- [ ] Stämmer **avrundningen** av moms på delkrediteringar med er praxis? (Vi fördelar exakt så att summan av alla delkrediteringar blir fakturans moms, aldrig mer eller mindre.)
- [ ] Är det rätt att **negativa utbetalningar** (återbetalningar och avgifter större än betalningar) bokförs som i exempel 3?
- [ ] Vill ni ha **ett verifikat per utbetalning** (antagandet), eller ett per dag eller per betalning?
- [ ] Finns särskilda krav från **revisorn** på underlag eller spårbarhet vi bör känna till?

## Efter era svar

Svaren styr tre saker: kundens **kontoplan** i tjänsten (`set-accounts`, idag fyra konton), eventuella **ändringar i hur verifikatet byggs**, och **gallringsreglerna**. Vi lägger även in era beslut i [DECISIONS.md](DECISIONS.md) så att de inte glöms bort.
