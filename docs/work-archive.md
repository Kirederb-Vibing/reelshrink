# Work-workflow fra v0.7

## Opsætning

Brug `compose.archive.yaml` med `archive.env.example`. Eksisterende v0.4/v0.5 Work-installationer bruger samme Compose og .env:
- `WORK_ROOT=/work`, `WORK_DRIVE_TYPE=local`.
- Hostens `WORK_PATH` er en lokal disk, eksempelvis `/home/fkl/reelshrink/work`.
- `MEDIA_ROOTS` indeholder bibliotekerne; `MEDIA_DRIVE_TYPES` angiver `network` eller `local` i samme rækkefølge.
- Bibliotekerne skal være skrivbare ved tilbageførsel. Auth og proxy-netværk bevares.
- Browseruploads går gennem din proxy; dens størrelses- og timeoutgrænser skal tillade den ønskede videostørrelse.

## Daglig brug

1. Scan biblioteker, sæt filtre, vælg videoer og tryk **Hent til Work Library**. NAS og lokale drev bruger samme kopieringsforløb. Status viser bytes og procent.
2. Alternativt upload én videofil fra browseren. Angiv eventuelt en eksisterende destinationsmappe på et konfigureret biblioteksdrev. Browseren sender ikke sin oprindelige filsti. Uden destination kan resultatet downloades fra Work.
3. Encoding bruger kun Work Library. Profilen ændres på Encoding-sidens automatisk oprettede Work-overvågning.
4. Fuld dekodning og kontrol af varighed, spor, opløsning og checksum gennemføres. Først derefter slettes Work-originalvideoen. Hvis kun-mindre er valgt, beholdes originalen, når resultatet ikke er mindre.
5. Resultatet står **Klar til tilbageførsel**. Vælg selv de emner som skal sendes, og bekræft med **SEND OG ERSTAT**.
6. Resultatet kopieres til en midlertidig fil i den oprindelige mappe, synkroniseres og checksumkontrolleres. Originalen kontrolleres mod importregistreringen, og den nye fil installeres før en original med anden filendelse slettes. Samme filendelse erstattes ved atomisk rename.
7. Vælg **Fjern fra Work**, når den lokale kopi ikke længere skal gemmes. Dette sletter det valgte emnes lokale filer og historik; NAS/lokalt bibliotek røres ikke.

Grundig/Hurtig har ingen OLD-kø. SPEEDY RISKY er et særskilt tilvalg med lokale WORK_OLD-kopier, som beskrevet nedenfor. NFO, SRT, billeder og andre afsnit på originalplaceringen bevares. SRT indlejres fortsat som valgbare spor; indstillingen for sidefiler styrer den ekstra lokale kopi.

## Filstyring

- **Stop alle hentninger** standser ventende og aktive bibliotekshentninger. Afbrudte emner kan genprøves eller fjernes fra Work.
- Browserupload har sin egen stopknap. En afbrudt browserupload skal fjernes og uploades igen.
- **Fjern valgte fra Work** fjerner også afbrudte downloadrester. Aktive operationer skal være afsluttet; uafsluttede servertilbageførsler blokeres.
- **Omdøb Work-mappe** ændrer den lokale titel uden at ændre originalplaceringen. Sæt encoding på pause, og gør det før encoding.
- **Genfind filer i Work** rydder annullerede/oversprungne/fejlede jobregistreringer og genstarter scanning. Uændrede filtre kan springe filen over igen. Manuelt tilføjede videoer får egne mapper og kan få en destination valgt.
- **Download resultat** henter det kontrollerede resultat til browseren.
- **Vælg destination** kan bruges for browseruploads; eksisterende destinationsfiler overskrives ikke.

## Mapper

```text
/work/library/Film.2026/Film.2026.mp4
/work/encoded/Film.2026/Film.2026.mkv
```

Ved navnesammenfald bruges `Film.2026 (2)`. UUID'er er fortsat interne identifikatorer og bruges til midlertidige filer; nye brugerrettede emnemapper bruger titler. Gamle mapper omdøbes ikke automatisk. Work-originalvideoen forsvinder efter godkendt encoding; eventuelle lokale sidefiler bliver til emnet fjernes.

## HDR og Atmos

Profilen har separate valg for **Tillad HDR/Dolby Vision** og **Tillad tab af Atmos**. Valget om at anvende filtre på ventende jobs anvender også disse to flag. Aktive jobs ændres ikke.

Klik på et job → **HDR / Atmos for denne fil** for at ændre flagene før encoding eller før genstart af et oversprunget job. Filens flag bruges ved genstart. HDR-override garanterer ikke korrekt HDR/Dolby Vision eller bevarelse af dynamiske metadata og udfører ikke tone mapping til SDR. Farvesignalering beholdes, men visuel kontrol anbefales før afsendelse.

Ved lydkopiering bevares Atmos-bitstrømmen. Ved AAC-stereo kræves tilvalg for TrueHD/E-AC-3, også hvor FFprobe ikke sikkert kan afgøre, om Atmos er til stede. Interlaced video springes fortsat over.

## Opgradering og afbrydelser

Ingen nulstilling er nødvendig. Stop containeren før en databasebackup. Kopiér hele config-mappen; der er normalt ikke behov for en ekstra kopi af hele Work-disken.

Nye operationer opretter ingen OLD-filer. Den gamle tilbageflytningsside omdirigeres til Work. Eksisterende OLD-filer og gamle overførselsjournaler slettes ikke automatisk. Emner med gammel tilbageflytningshistorik viser en besked om manuel gennemgang; en påbegyndt gammel afsendelse genoptages ikke med den nye algoritme. Bevar deres Work-filer og database indtil afklaret.

En afbrudt ny servertilbageførsel markeres til gennemgang. **Prøv igen** bruger journalen og verificerer installeret eller midlertidigt indhold. Ændrede kilder, ukendte mål eller korrupte resultater stopper forløbet. Brug ikke andre programmer til at omorganisere de samme filer under afsendelse.

Netværkstrafik omfatter import, afsendelse og checksumlæsninger. Den store original genlæses ved ændringskontrollen før erstatning, men encoding og dekodningskontrol foregår lokalt. Der kræves hardlinks ved ændring af filendelse; manglende understøttelse stopper før originalen slettes. Testene bruger lokale filsystemer, ikke din konkrete NAS.

## Kontrolniveau, buffer og SPEEDY RISKY

På Work-siden vælges Grundig, Hurtig eller SPEEDY RISKY samt 1–5 film (standard 3). Indstillingerne gemmes i databasen, ikke .env. Grundig er standard ved opgradering. Mode-skift kræver afsluttede/fjernede aktuelle Work-emner; en aktiv risky-batch skal godkendes først.

**Grundig** udfører fortsat fuld lokal dekodning. **Hurtig** kontrollerer metadata, spor og 10 sekunder fra start, midte og slut; videoer på højst 30 sekunder kontrolleres hele. Hurtig undgår en ekstra fuld lokal genlæsning efter import og sammenligner NAS-originalens filmetadata i stedet for at hashe hele originalen igen. Den nye destinationskopi checksumkontrolleres én gang før installation. Uændrede lokale resultater genbruger den registrerede checksum; overførselsstrømmen hashes uden ekstra diskpassage.

**SPEEDY RISKY** bruger samme lokale udsnitskontrol, men ingen indholdsgenlæsning/checksumkontrol på NAS. Sti-, mount-, filtype- og kollisionskontrol samt synkronisering af writes bevares. Den registrerede originalvideo erstattes, også hvis indholdet er ændret siden import. Ukendte filer på en anden destinationssti overskrives ikke. Den store Work-original omdøbes til `Fil.mp4.WORK_OLD` i stedet for at blive slettet.

En risky-batch indeholder højst det valgte antal (maks. fem). Den er vedvarende og fyldes ikke op igen, bare fordi en fil bliver færdig, afsendt, stoppet eller fjernet. Du kan have op til 100 valgte importer i kø; kun næste batch hentes. Ved fejl genprøves emnet; ubehandlede emner uden WORK_OLD kan fjernes. Efter alle tilbageværende emner er afsendt, kan batchen godkendes med `SLET WORK_OLD`. Godkendelsen kontrollerer kun lokale filer og sletter batchens lokale originaler. Der foretages ingen ny NAS-indholdskontrol. Resultaterne på Work beholdes, så de kan fjernes særskilt. Næste batch åbnes først efter den registrerede godkendelse, også efter en genstart eller afbrudt godkendelse.

I risky-tilstand er browserupload og manuel genfinding slået fra; vælg videoer fra de konfigurerede lokale/NAS-biblioteker. Disse funktioner er fortsat tilgængelige i Grundig/Hurtig. En afbrudt afslutning med færdig encoding kan genprøves fra Work uden at encode igen.

**Automatisk tilbageførsel** er et særskilt, bekræftet tilvalg, slået fra som standard. Det betyder, at valgte importer må erstatte deres registrerede originaler, når den lokale kontrol er færdig. Det sletter aldrig WORK_OLD automatisk. Uden tilvalget skal du fortsat vælge Send tilbage.

I Grundig/Hurtig frigiver afsendelse en plads i bufferen; indtil da tæller en hentet/encodet fil stadig med. Afsendte resultatkopier kan fortsat optage plads på Work. MIN_FREE_GB kontrolleres stadig; ingen film bliver slettet for at overholde buffergrænsen ved en opgradering. Manuelt eksisterende filer er ikke automatisk omfattet af importgrænsen.

Hentning og afsendelse kan arbejde samtidig med encoding, men der er én biblioteksoverførsel ad gangen. Afsluttede importer markeres klar via deres lokale signatur og springer stabilitetsventetiden over. Hvis filen ændres, bruges den normale ventetid. Work-listen viser separat hentetid, encodingtid, kontroltid og afsendelsestid.
