# Work-workflow fra v0.6

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

Der er ingen OLD-kø eller usikker bypass i dette workflow. NFO, SRT, billeder og andre afsnit på originalplaceringen bevares. SRT indlejres fortsat som valgbare spor; indstillingen for sidefiler styrer den ekstra lokale kopi.

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
