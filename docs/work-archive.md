# Lokalt arbejdsarkiv (fra v0.4.0)

Arbejdsarkivet henter valgte videoer fra NAS eller et lokalt bibliotek til serverens lokale disk. Encoding, kontrol, sammenligning og tilbageflytning sker derefter lokalt. Du godkender resultatet i OLD-køen og vælger separat, hvilke emner der skal sendes tilbage. Originalen på biblioteket bliver liggende under det lokale arbejde.

## Compose og drevtyper

Brug den selvstændige [compose.archive.yaml](../compose.archive.yaml), som beholder de tre containerstier `/media/film`, `/media/film_2` og `/media/serier`, Basic Auth, ikke-root-bruger og det eksterne `proxy`-netværk uden publicerede hostporte. Brug ikke samtidig den gamle service med samme container-navn/database. Et lokalt build kan bruge `-f compose.archive.yaml -f compose.build.yaml`.

Ved en ny installation kan [archive.env.example](../archive.env.example) kopieres til `.env`. Ved opgradering skal eksisterende stier og auth-værdier bevares. Tilføj følgende variabler; tilpas `WORK_PATH` til en **lokal** disk:

```dotenv
WORK_PATH=/srv/reelshrink/work
WORK_DRIVE_TYPE=local
FILM_DRIVE_TYPE=network
FILM2_DRIVE_TYPE=network
SERIES_DRIVE_TYPE=network
```

| Variabel i `.env` | Hostmappe | Containersti | Tilladte drevtyper |
| --- | --- | --- | --- |
| `FILM_PATH`, `FILM_DRIVE_TYPE` | Første filmbibliotek | `/media/film` | `network` eller `local` |
| `FILM2_PATH`, `FILM2_DRIVE_TYPE` | Andet filmbibliotek | `/media/film_2` | `network` eller `local` |
| `SERIES_PATH`, `SERIES_DRIVE_TYPE` | Seriebibliotek | `/media/serier` | `network` eller `local` |
| `WORK_PATH`, `WORK_DRIVE_TYPE` | Lokal arbejdsdisk | `/work` | Kun `local` |

`network` beskriver et allerede monteret netværksdrev. ReelShrink monterer ikke SMB/NFS og skal ikke have NAS-login i `.env`. Monter drevene på værten før containerstart. `local` beskriver et bibliotek på lokal disk. Begge bibliotekstyper bruger samme eksplicit valgte hente-/sendeforløb; ingen type bliver automatisk sendt tilbage.

Compose omsætter drevtyperne til `MEDIA_DRIVE_TYPES=network:network:network` med samme rækkefølge som `MEDIA_ROOTS`. Tilføjer/fjerner du mounts, skal begge lister opdateres. Ugyldige typer eller forkert antal afvises ved start.

Opret arbejds- og konfigurationsmapper før opstart, og giv den eksisterende `PUID:PGID` adgang. Biblioteksmapperne skal kunne læses og skrives af samme bruger, da afsendelse skal kunne oprette, omdøbe og slette filer. `read_only: true` må ikke bruges på biblioteksdrevet, hvis du vil sende tilbage. Bevar eksisterende NAS-ACL'er; ændr ikke rekursivt ejerskab på hele biblioteket som en del af denne opgradering. Fedora/SELinux kan også begrænse containeradgang; brug værtens eksisterende regler for NAS-mounts og containerdata.

`WORK_DRIVE_TYPE=local` er en erklæring; vælg reelt en lokal disk. Tjenesten afviser kendte NFS/SMB-filsystemtyper på arbejdsmapperne, men kan ikke identificere alle lagdelte/netværksbaserede filsystemer. Biblioteks-, arbejds- og konfigurationsmapper skal være adskilte, og symlinks er ikke tilladt i overførselsstier.

## Opgradering fra eksisterende ReelShrink

1. Sæt encoding-køen på pause, slå automatisk tilbageflytning fra, og lad aktive operationer afslutte. Gennemgå eksisterende tilbageflytninger og OLD-filer, **før** arbejdsarkivet aktiveres.
2. Stop containeren. Tag en konsistent backup af hele konfigurationsmappen med SQLite-databasen, mens tjenesten er stoppet. Bevar gamle output- og mediefiler.
3. Opret en lokal `WORK_PATH`. Bevar `CONFIG_PATH`, `FILM_PATH`, `FILM2_PATH`, `SERIES_PATH`, `PUID`, `PGID`, `AUTH_USERNAME` og `AUTH_PASSWORD`. Tilføj drevtyperne og skift til archive-Compose. Del ikke auth-værdierne.
4. Hent og start den nye version med din valgte Compose-fil:

   ```bash
   sudo docker compose --env-file .env -f compose.archive.yaml config --quiet
   sudo docker compose --env-file .env -f compose.archive.yaml pull
   sudo docker compose --env-file .env -f compose.archive.yaml up -d
   sudo docker compose --env-file .env -f compose.archive.yaml logs --tail=100 reelshrink
   ```

   Hvis du har erstattet indholdet af din normale `compose.yaml` i Dockge, kan du bruge de almindelige pull/recreate-knapper og udelade `-f compose.archive.yaml` i kommandoerne.
5. Kontrollér fanen **Arbejdsarkiv**. Den nye overvågning **Arbejdsarkiv** findes i Encoding; indstil codec/filtre og genoptag køen, når du er klar. Start med ét emne.

`WORK_ROOT=/work` aktiverer tilstanden. Det omdirigerer alle nye encoding-input til `/work/library`, output til `/work/encoded` og ekstra sammenligningsinput til `/work/incoming`. `OUTPUT_ROOT` og `RETURN_INPUT_ROOTS` bruges ikke i denne tilstand. Dit tidligere `OUTPUT_PATH` og `/output` indgår derfor ikke i den nye Compose-fil.

Eksisterende jobhistorik bevares. Gamle overvågninger uden for arbejdsarkivet deaktiveres, og deres ventende/aktive jobs annulleres ved aktivering. API'et tillader ikke, at de genaktiveres eller genstartes til direkte NAS-behandling i arbejdsarkivtilstanden. En gammel fra-/tilmapping uden for arbejdsmapperne nulstilles. Tidligere færdige filer i `/output` bliver **ikke** automatisk importeret eller slettet; afslut dem inden skiftet, eller behold dem til særskilt manuel håndtering. En eventuel eksisterende køpause bevares.

Et image-pull uden `WORK_ROOT` ændrer ikke den hidtidige arbejdsgang. Slå ikke tilstanden til/fra midt i en overførsel, og slet ikke databasen for at nulstille en fejl: den indeholder stier, godkendelser og journaler.

## Daglig arbejdsgang

1. **Arbejdsarkiv → Hent fra server til arbejdsarkiv:** Åbn drev og undermapper. Vælg videoer eller alle viste videoer, op til 100 pr. handling. Tryk **Hent valgte**. Statusbaren viser overførte bytes, procent og hastighed. Filoversigten omfatter den valgte video og tilhørende SRT, NFO og billeder efter ReelShrinks eksisterende bundleregler. Mapper og ukendte filer kan gennemgås på serveren; de slettes ikke som en del af videooverførslen.
2. **Encoding:** Filen bliver synlig for den lokale overvågning, når hele hentningen er kontrolleret. Den normale stabilitetsperiode gælder fortsat. Justér encoding-profilen på overvågningen **Arbejdsarkiv**. Der læses ikke videodata fra NAS'en under encoding eller validering.
3. **Tilbageflytning & OLD-kø:** Flyt den færdige lokale encoding tilbage over den lokale original. Den lokale original bliver `.OLD`. Automatisk tilbageflytning kan bruges her; den arbejder fortsat kun lokalt og sender aldrig til biblioteket.
4. Afspil/kontrollér resultatet lokalt. Godkend ved at vælge **Slet valgte OLD-filer** i OLD-køen. Originalen på NAS'en er stadig bevaret. ReelShrink kræver denne registrerede godkendelse; sletning af `.OLD` uden om appen gør ikke automatisk emnet sendeklart.
5. **Arbejdsarkiv → Send valgte til server:** Vælg de godkendte emner, gennemgå originalstierne og bekræft med `SEND OG ERSTAT`. Kun disse ID'er sættes i sendekø. Statusbaren viser overførsel, efterfulgt af særskilte kontrol- og installationsfaser. 100 % kopieret betyder ikke færdig, før status er **Afsendt**.
6. Den lokale erstatning bevares efter afsendelse. Under **Alle inkl. afsendte** kan **Frigør lokal plads** kontrollere serverkopien igen og slette det valgte emnes lokale mappe og tilhørende encoding-output. Historik og registrerede originalstier bevares.

Der kører højst én biblioteksoverførsel ad gangen. Encoding kan arbejde på et tidligere hentet emne, mens et andet hentes. Afsendelse kræver, at igangværende lokal encoding/tilbageflytning er afsluttet; en ny lokal operation kan give en tydelig ventefejl, som genprøves manuelt. Afsendte emner og emner med en uafsluttet sendetransaktion genencodes ikke automatisk.

## Filhåndtering, plads og netværkstrafik

Hvert emne får en unik lokal mappe og en vedvarende registrering af drev, originalmappe, præcis originalsti, relative sidefilstier, størrelser, ændringstider og SHA-256-kontrolsummer. Film med ens navne fra forskellige drev holdes adskilt. Det er denne registrering, der bestemmer tilbageførsel; der foretages ikke et nyt gæt ud fra filnavnet.

Originalen hentes én gang pr. gennemført hentning. Kopiens hash beregnes under læsningen, og den lokale kopi genlæses lokalt til kontrol. Alle encodeforsøg og fuld videokontrol sker lokalt. Ved afsendelse overføres den nye video og ændrede/nye sidefiler. Uændrede, allerede registrerede sidefiler bevares på serveren uden ny overførsel.

Der er **én ekstra netværkslæsning af de nye overførte data** til checksumkontrol på destinationen. Genoptagelse og senere lokal oprydning kan også genlæse serverkopien. Det er ikke en garanti om præcis én læsning i hele forløbet; det fjerner de gentagne NAS-læsninger under encoding og lokal tilbageflytning. Hentefejl starter den pågældende hentning fra begyndelsen; afbrudt afsendelse før installation kopierer sendefilerne igen.

Før originaler berøres, kopieres alle ændringer til `.reelshrink-archive-<id>` i originalmappen, synkroniseres og hashkontrolleres. Derefter flyttes kun de registrerede originalfiler, der skal erstattes, til transaktionsmappen på samme disk; de nye filer publiceres med eksklusive hardlinks. Originalkopier slettes først, når alle erstatninger er installeret og kontrolleret. Transaktionen bevares ved fejl. Filsystemet skal understøtte hardlinks og fil-/mappesynkronisering; manglende hardlink-understøttelse testes før originalerne flyttes og stopper afsendelsen uden at fjerne originalen.

**Der slettes aldrig rekursivt en biblioteksmappe.** Andre afsnit, ukendte filer og filer tilføjet efter hentningen bevares. Uændrede sidefiler bevares også. Det er nødvendigt, fordi flere emner kan dele en mappe og metadata. En ny fil på den tiltænkte destinationssti blokerer, så den ikke overskrives. Overførslen er journalført pr. fil; biblioteket kan kortvarigt vise en delvis mappe under installation, og ved en afbrudt installation kan en original ligge i den skjulte transaktionsmappe indtil genoptagelse. Stop andre programmer fra at omorganisere/ændre de samme filer under afsendelse.

Sæt ikke hele biblioteket i hentekø, hvis arbejdsdisken er lille. Der kontrolleres plads før hentning, encoding, lokal tilbageflytning og afsendelse, men der reserveres ikke diskplads mod andre programmer. Arbejdsdisken skal have plads til originaler, resultater og midlertidige kopier; destinationsdrevet skal midlertidigt kunne rumme både den gamle og den nye version. Frigør lokal plads mellem batches.

## Fejl og genoptagelse

- **Hentning fejler:** Originalerne er uændrede. Ret plads/rettigheder/mount og vælg **Prøv igen / genoptag**. Hvis kilden har ændret sig siden registreringen, afvises den gamle overførsel; ændr ikke journalen eller filmetadata for at omgå kontrollen.
- **Afsendelse fejler:** Åbn filoversigten og læs fejlen. Ret årsagen og vælg **Prøv igen / genoptag**. Journalen genkender allerede flyttede originaler og installerede erstatninger. En overførsel afbrudt af genstart markeres til gennemgang og genoptages ikke automatisk; endnu ikke startede, tidligere valgte køemner kan fortsætte.
- **Original eller destination ændret:** Ingen konfliktfil overskrives. Bevar arbejdsarkiv, database og transaktionsmappe, og gennemgå de nævnte stier manuelt.
- **Manglende NAS-mount:** Drevets og originalmappens identitet kontrolleres. Et erstattet mount eller en tom erstatningsmappe stopper operationen. Monter den samme oprindelige mappe igen; et NAS-system, der skifter filidentiteter ved remount, kan kræve manuel gennemgang.
- **Rettighedsfejl:** Kontrollér skrivbar Compose-mount samt UID/GID, NAS-rettigheder og eventuelle værtsregler. Undlad at slette `.reelshrink-archive-*` eller flytte filer ud af den under en uafsluttet transaktion.

## Test

`npm run check` og `npm test` omfatter reel FFmpeg-encoding, lokal OLD-godkendelse, selektiv afsendelse, bevarelse af andre afsnit/sidefiler, plads- og rettighedsrelaterede fejl, manglende hardlinks, symlinks, ændrede originaler, afbrudt installation/oprydning, genoptagelse, gammel kømigrering samt auth/CSRF. CI validerer archive-Compose og containeren. Testene bruger lokale filsystemer; konkret SMB/NFS- og NAS-durabilitet afhænger af værtsmontering og NAS og skal afprøves med ét emne på din installation.
