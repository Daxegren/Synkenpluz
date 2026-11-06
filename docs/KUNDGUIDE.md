# Kom igång: guide för e-handlare

> Utkast att skicka till en ny kund. Ersätt [hakparenteser] med era uppgifter. Texten beskriver hur tjänsten fungerar i dag; kopplingarna mot Mondido och Fortnox är ännu inte byggda, så avsnitt 3 och 4 beskriver hur det blir när de finns, och avsnitt 2 är det som går att göra redan nu.

Tjänsten stämmer automatiskt av utbetalningarna från er betalleverantör mot fakturorna i ert affärssystem. Det här är hur ni kommer igång, vad ni ser och vad ni bestämmer. **Inget bokförs i ert affärssystem förrän ni själva godkänt det.**

## 1. Vad som händer, i korthet

1. Ni provkör med två filer och ser hur stor del som går att stämma av automatiskt (ingen koppling, inget sparas).
2. Ni kopplar betalleverantör och affärssystem.
3. Tjänsten hämtar utbetalningar i **testläge**: den räknar ut vad som *skulle* bokföras, men bokför ingenting.
4. Ni och er redovisningskonsult granskar förslagen.
5. Ni godkänner, och därefter bokförs varje ny utbetalning automatiskt. Det som inte går att stämma av säkert blir en avvikelse till er, aldrig en gissning.

## 2. Provkör med era egna filer (ingen koppling behövs)

Ni behöver två filer, båda som CSV:

- **Utbetalningsfil** från betalleverantören: en rad per transaktion, med utbetalningens id, datum, nettobelopp, radens id, typ (betalning, återbetalning eller avgift), referens, belopp och avgift.
- **Fakturafil** från affärssystemet: en rad per faktura, med id, referens, valuta, totalbelopp, moms och obetalt belopp.

Logga in, välj *Provkör med filer* och ladda upp dem. Ni ser direkt hur stor andel av raderna som matchats säkert, vilka avvikelser som är vanligast och om något i filerna behöver rättas. **Filerna sparas inte** och inget bokförs. Exakta kolumner och exempel finns i PROVKORNING.md; har era filer andra rubriker hjälper vi er att ange dem.

## 3. Koppla era system

Ni ger tjänsten åtkomst till [betalleverantör] och [affärssystem] genom att godkänna kopplingen hos respektive leverantör. Vi ber om så små rättigheter som möjligt. [Fortnox ger behörighet per resurs med både läs och skriv, så ni ser exakt vad ni godkänner i godkännandedialogen.] Era inloggningsuppgifter lagras krypterade och används bara för er avstämning.

Vi behöver också veta vilka konton ni vill använda: bankkonto, clearingkonto för betalleverantören, konto för avgifter och konto för ingående moms på avgifter. [Er redovisningskonsult kan bekräfta dem; vi föreslår vanliga BAS-konton.] Säljer ni i andra valutor anger ni konton för varje valuta.

## 4. Testläge och granskning

I testläge hämtas era utbetalningar och förslag sparas, men **ingenting bokförs**. Under *Förslag* ser ni för varje utbetalning vad som skulle bokföras: vilka fakturor som får en inbetalning, eventuella krediteringar vid återbetalning, och verifikatet för avgifterna. Verifikatet visar att det balanserar, och ni kan ladda ner underlaget som CSV till er redovisningskonsult.

Under *Kom igång* ser ni en checklista över vad som återstår och träffsäkerheten hittills. Rader som inte går att stämma av säkert (referensen saknas, beloppet stämmer inte, flera fakturor har samma referens) syns som avvikelser med en förklaring av vad det betyder och vad ni kan göra.

## 5. Godkänn och gå live

När förslagen stämmer godkänner en person med rollen **godkännare**. Allt ni granskat bokförs då på riktigt, och därefter varje ny utbetalning. Godkännandet loggas med vem som gjorde det. Ni kan inte ångra det härifrån: är ni osäkra, avstå och fråga er redovisningskonsult.

## 6. Dagligt arbete

- **Avvikelser** kräver en människa. Ni ser vad som hände, gör rätt i affärssystemet (till exempel skapar en saknad faktura) och stänger avvikelsen med en anteckning. Tjänsten försöker själv igen vid nästa körning och stänger avvikelser som lösts.
- **Osäkra anrop:** om ett bokföringsanrop avbröts så att ingen vet om det gick igenom skickar tjänsten **aldrig om det på gissning**, eftersom det kunde ge dubbelbokföring. Ni kontrollerar i affärssystemet och svarar ja eller nej.
- Varje person får en **egen nyckel** med en roll: *läsare* kan titta, *handläggare* kan även hantera avvikelser och osäkra anrop, *godkännare* kan även godkänna go-live. Vi rekommenderar nycklar med utgångsdatum.

## 7. Vad vi aldrig gör

- Bokför på gissning. Bara exakt referens och exakt belopp stäms av automatiskt.
- Bokför något som inte balanserar. Stämmer utbetalningens summa inte avvisas hela utbetalningen.
- Skickar om ett osäkert bokföringsanrop utan att ni avgjort det.
- Sparar kortuppgifter, namn eller adresser.

## 8. Era uppgifter

Ni är personuppgiftsansvariga och vi är ert personuppgiftsbiträde. Ett personuppgiftsbiträdesavtal [bifogas / tecknas före första körning]. Filerna i provkörningen sparas inte. I övrigt lagrar vi bara det avstämningen kräver: utbetalnings- och fakturareferenser, belopp och status, samt en logg över åtgärder utan belopp eller personuppgifter.

## 9. Frågor

[Kontaktuppgifter och svarstid.] Vid fel eller osäkerhet: ändra ingenting i affärssystemet på egen hand; kontakta oss först.
