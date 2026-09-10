# ReelShrink

En lille, selvhostet tjeneste til at komprimere film og serier med en dansk web-GUI, automatisk mappeovervågning og **valgbare undertekster**.

ReelShrink læser dine originaler, encoder med FFmpeg og lægger kontrollerede MKV-filer i en separat outputmappe. Valgfri tilbageflytning sætter resultatet tilbage i biblioteket og gemmer originalen som `.OLD` til manuel sletning. Video, lyd, scanning, database og GUI kører i én Docker-container.

**Version:** 0.4.0 · **Webport:** 8080/TCP · **Runtime:** Node.js 24 + FFmpeg · **Database:** SQLite · **Licens:** MIT for applikationskoden.

> Første udgivelse. [GitHub-repository](https://github.com/Kirederb-Vibing/reelshrink) · [Buildstatus](https://github.com/Kirederb-Vibing/reelshrink/actions/workflows/publish.yml). Image: `ghcr.io/kirederb-vibing/reelshrink:latest`. Imaget er tilgængeligt, når publiceringsworkflowet er grønt; kontroller pakkens adgang ved første installation.

## Funktioner

- Dansk, responsiv GUI med mappevælger, jobkø, søgning, filtrering, fremdrift, hastighed, estimeret resterende tid og historik.
- Rekursiv scanning af flere mapper med forskellige encoding-profiler.
- H.265/HEVC som standard; H.264 kan vælges for bredere afspillerkompatibilitet.
- Bevar original opløsning, eller begræns højden til 1080p/720p uden opskalering.
- Tre kvalitetsprofiler og tre hastighedsvalg.
- Bevar alle lydspor uændret, eller konvertér dem til AAC stereo.
- Eksterne SRT-filer indlejres som separate, valgbare MKV-spor. Undertekster brændes aldrig ind i billedet.
- Eksisterende undertekstspor, kapitler, metadata og vedhæftninger bevares; relevante tekstformater konverteres til SRT ved behov.
- Valgfri kopiering af tilhørende SRT, NFO og billeder til output.
- Pause køen, annullér jobs og genstart fejlede/annullerede/oversprungne jobs.
- Fjern enkeltjobs eller markér op til 100 jobs på tværs af sider og fjern dem samlet.
- Filtre pr. mappe: minimum/maksimum filstørrelse, minimum varighed/kildehøjde og fravalg af eksisterende codecs.
- Vedvarende kø, kontrol af filstabilitet, versionsgenkendelse og oprydning af midlertidige resultater.
- Gem som standard kun resultatet, hvis videofilen er mindre end originalen.
- Fuld dekodningskontrol af færdig video og lyd før publicering i outputmappen.
- Image-opskrift og GHCR-workflow for `linux/amd64` og `linux/arm64`.

## Lokalt arbejdsarkiv til NAS og lokale biblioteker (v0.4)

Fanen **Arbejdsarkiv** henter valgte film/afsnit til en lokal arbejdsdisk og viser fremdrift i bytes og procent. Når arbejdsarkivet er aktiveret, bruger **encoding og tilbageflytning kun lokale arbejdsmapper**. Efter lokal tilbageflytning og godkendelse i OLD-køen kan du vælge **Send valgte til server** med en separat statusbar. Intet sendes automatisk til NAS'en.

Hvert emne husker sit drev, originalmappe, præcise filstier og tilhørende filer. Nye filer kopieres og checksumkontrolleres før erstatning; uændrede sidefiler og andre emner i samme mappe bevares. Afbrudte overførsler kan genoptages. Efter afsendelse kan du frigøre den lokale plads manuelt.

Brug **[compose.archive.yaml](compose.archive.yaml)** og **[archive.env.example](archive.env.example)**. Drevet erklæres som `network` eller `local` pr. mount i `.env`. Læs **[opsætning, opgradering, arbejdsgang og fejlhåndtering](docs/work-archive.md)**. Eksisterende opsætninger fortsætter i deres hidtidige tilstand, indtil `WORK_ROOT` sættes.

## Tilbageflytning & OLD-kø (v0.3)

ReelShrink kan nu overvåge sit output, føre færdige videoer tilbage til deres præcise originalmappe og gemme originalerne med `.OLD` til manuel gennemgang og sletning. Andre fra-/tilmapper kan sammenlignes efter filmtitel/år eller serie/sæson/episode. Tvetydige matches kræver dit valg.

Åbn **Tilbageflytning & OLD-kø** i GUI’en. Automatisk tilbageflytning er slået fra ved opgradering. Funktionen kræver skrivbare mediemounts; brug den nye **[compose.return.yaml](compose.return.yaml)** og **[return.env.example](return.env.example)** til Dockge/Pangolin med tre mediemapper og ingen hostporte. Bevar eksisterende database og containerstier.

Læs **[opsætning, matchregler, sikker filhåndtering og gendannelse](docs/RETURNING.md)** før aktivering.

## Hurtig installation med Docker Compose

Krav: Linux med Docker Engine og Docker Compose v2 eller nyere. Et 64-bit x86- eller ARM-system, mindst ca. 2 GB ledig RAM til almindelig HD-encoding og tilstrækkelig outputplads anbefales som udgangspunkt; behovet stiger med opløsning og encoding-profil. Der kræves ikke en GPU.

1. Hent eller klon projektet, og gå ind i mappen `reelshrink`.
2. Opret konfiguration og mapper:

   ```bash
   sudo cp .env.example .env
   sudo mkdir -p config output media/movies media/series
   sudo chown "$(id -u):$(id -g)" config output
   id -u
   id -g
   sudo nano .env
   ```

   Sæt `PUID` og `PGID` til de viste tal. Ret `REELSHRINK_IMAGE` til imaget fra GitHub Packages, og sæt `MOVIES_PATH` og `SERIES_PATH` til dine eksisterende film-/seriemapper. `CONFIG_PATH` og `OUTPUT_PATH` skal være skrivbare for containerens UID/GID; mediemapper kræver læseadgang og søgeadgang på mapperne. Kør kun `chown` på ReelShrinks egne konfigurations-/outputmapper, ikke på et eksisterende mediebibliotek.

3. Start den publicerede version:

   ```bash
   sudo docker compose pull
   sudo docker compose up -d
   sudo docker compose ps
   ```

4. Åbn `http://DIN-SERVER-IP:8080` i browseren. Vælg **Tilføj mappe**, og vælg `/media/movies` eller `/media/series`.
5. Start med **H.265**, **Balanceret**, **Bevar original opløsning** og **Bevar alle lydspor**. Tjenesten begynder automatisk, når filerne er stabile.

Hvis du kun bruger én mediemappe, kan den anden monteres som en tom mappe. Scanner kun de mapper, du aktiverer i GUI'en; hele `/media` bliver ikke automatisk tilføjet ved opstart.

### Byg lokalt, også før der findes et GHCR-image

Efter trin 1–2 kan du bygge og starte direkte fra kildekoden:

```bash
sudo docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Brug de samme `-f`-argumenter ved efterfølgende `ps`, `logs` og `down`. `compose.build.yaml` erstatter det eksterne image med `reelshrink:local`.

## Pangolin / Newt / Traefik uden host-port

`compose.proxy.yaml` er en **selvstændig alternativ Compose-fil**. Den offentliggør ingen host-port og tilslutter tjenesten til et eksisterende Docker-netværk ved navn `proxy`.

```bash
sudo docker network inspect proxy
sudo docker compose -f compose.proxy.yaml pull
sudo docker compose -f compose.proxy.yaml up -d
```

Hvis netværket ikke allerede findes, kan det oprettes med `sudo docker network create proxy`.

Sæt proxyens interne destination til **`http://reelshrink:8080`**. Den lokale Newt-/proxy-container skal være på det samme Docker-netværk for at kunne bruge navnet `reelshrink`. Brug et dedikeret subdomæne; drift under et URL-underkatalog understøttes ikke. Bevar den oprindelige HTTP `Host`-header. HTTPS afsluttes ved proxyen.

Lokal build i den samme opsætning:

```bash
sudo docker compose -f compose.proxy.yaml -f compose.build.yaml up -d --build
```

Til Dockge kan indholdet af `compose.proxy.yaml` bruges direkte sammen med værdierne fra `.env`.

## Mapper og porte

| Containersti/port | Funktion | Adgang |
| --- | --- | --- |
| `/config` | SQLite-database med indstillinger og jobhistorik | Læs/skriv; persistent, lokal disk |
| `/media/movies` | Film på værten | Kun læsning |
| `/media/series` | Serier på værten | Kun læsning |
| `/output` | Færdige filer og midlertidig encoding | Læs/skriv; persistent |
| `8080/TCP` | GUI, JSON-API og healthcheck | HTTP |

Stier i GUI'en er **containerstier**, ikke værtens stier. Eksempel: En host-mappe `/srv/films` monteret på `/media/movies` vælges som `/media/movies` i GUI'en.

Input og output må aldrig være identiske eller ligge inde i hinanden. Kildesymlinks følges ikke. Overlappende overvågningsmapper afvises for at undgå dubletter. Kør kun **én ReelShrink-instans pr. `/config` og `/output`**. Databasen bør ikke placeres på et NFS-/SMB-share.

Output organiseres sådan:

```text
/output/<mappe-id>/<relative-undermapper>/<filnavn>--<job-id>/<filnavn>.mkv
```

Den korte ID-del adskiller revisioner og filer med samme navn. Den præcise destination fremgår af jobdetaljerne. Sidefiler bevarer deres navne og eventuelle `Subs`-/`Subtitles`-undermapper. `reelshrink.json` beskriver den anvendte profil og størrelser. Først efter afsluttet encoding og kontrol flyttes hele resultatmappen til den endelige placering; igangværende filer ligger under `/output/.reelshrink-tmp`.

## Undertekster og tilhørende filer

Følgende navne genkendes, hvis videoen fx hedder `Movie.2026.mkv`:

```text
Movie.2026.mkv
Movie.2026.da.srt
Movie.2026.en.srt
Movie.2026.en.forced.srt
Movie.2026.nfo
poster.jpg
Subs/Movie.2026.de.srt
```

- Ved flere videoer i samme mappe skal SRT-filens navn matche videoens navn uden filendelse, efterfulgt af fx punktum, mellemrum, bindestreg eller underscore. Den længste matchende videostamme vinder, så undertekster fra én episode ikke tilføjes til en anden.
- Ved **præcis én video** i mappen kan andre `.srt`-filer i samme mappe eller direkte i `Subs`/`Subtitles` også tilknyttes, fx `English.srt`. Fjern uvedkommende SRT-filer fra sådanne mapper.
- Sprog identificeres fra navnet, bl.a. `da/dan`, `en/eng`, `sv/swe`, `no/nor`, `de/deu/ger`, `fr/fra`, `es/spa`. Ukendt sprog får `und`, men sporet er stadig valgbart.
- UTF-8 og BOM-markeret UTF-16 understøttes. Hvis filen ikke er gyldig UTF-8, forsøges Windows-1252. Andre tegnsæt skal konverteres først. Maksimal størrelse pr. ekstern SRT er 16 MiB.
- Undertekster får hverken `default`- eller `forced`-flag i output, også hvis originalen eller filnavnet havde dem. Afspilleren kan stadig vælge et spor ud fra dine egne sprogindstillinger.
- Eksisterende tekst- og billedbaserede undertekstspor kopieres, hvis MKV understøtter deres codec. `mov_text`, WebVTT, text og TTML forsøges konverteret til SRT. Et inkompatibelt spor får jobbet til at fejle med en log; det fjernes ikke lydløst.
- Eksterne ASS/SSA, VobSub, PGS og løse lydspor importeres ikke i v0.1. Indlejrede spor håndteres som beskrevet ovenfor.
- NFO, JPG, JPEG, PNG og WebP kopieres, når de matcher videotitlen. Ved én video medtages også generiske navne som `poster.jpg`, `fanart.jpg` og `movie.nfo`. Sidefiler bruges ikke til automatisk at gætte encoding-kvalitet.
- En sent ankommet eller ændret SRT-/sidefil ændrer kildens signatur og opretter en ny encoding-revision efter stabilitetsperioden. En tidligere færdig revision bevares.

## Kvalitet, størrelse og begrænsninger

| Profil | H.265 CRF | H.264 CRF | Typisk valg |
| --- | --- | --- | --- |
| Høj kvalitet | 21 | 18 | Prioritér detaljer; større resultat |
| Balanceret | 24 | 21 | Udgangspunkt til film og serier |
| Mindre fil | 27 | 24 | Prioritér plads; større risiko for synlige artefakter |

CRF er kvalitetsstyring, ikke en målstørrelse. Tallene er ikke direkte sammenlignelige mellem H.264 og H.265. Lavere CRF giver normalt højere kvalitet og større filer. Langsom preset bruger mere tid for bedre komprimering. Alle profiler er lossy: uændret opløsning betyder ikke uændret billedkvalitet. Film med korn, mørke scener eller meget bevægelse kan have behov for profilen **Høj kvalitet**. Prøv en repræsentativ film, og se resultatet på din normale afspiller.

**Denne version:**

- CPU-encoding med libx265/libx264. Ingen NVENC, Quick Sync, VAAPI eller AV1-encoding.
- HDR10/HLG/Dolby Vision og genkendt interlaced video springes over. Der foretages ikke automatisk tone mapping eller deinterlacing. Det vises i jobdetaljerne.
- Ét encoding-job ad gangen. Pause af kø eller mappe lader et aktivt job afslutte; **Annullér** afbryder selve jobbet.
- Opløsning bevares eller nedskaleres i højden. Sideforhold bevares ved nedskalering; almindelig SDR med mere end 8 bit forsøges bevaret som 10-bit 4:2:0.
- Containeren spiller ikke videoer af og henter ikke undertekster eller metadata fra internettet.
- Komprimerer videofiler, ikke DVD-/Blu-ray-diskstrukturer, ISO-filer, arkiver eller DRM-beskyttet video.
- Outputkontrollen undersøger varighed, codec, opløsning, antal lyd-/undertekst-/vedhæftningsspor og undertekstflag og dekoder hele videoen og lyden. Den måler ikke subjektiv billedkvalitet.
- Sammenligningen **Plads sparet** er forskellen mellem original video og komprimeret video. Fordi originalerne bevares, bliver den faktiske diskplads ikke frigivet automatisk. Sidefiler tælles ikke med i denne besparelse.

## Konfiguration

### Filtre og oprydning i køen (fra v0.2)

Åbn **Overvågede mapper → Indstillinger → Filtre**. Alle filtre er slået fra som standard, også efter opgradering fra v0.1.

| Filter | Eksempel | Adfærd |
| --- | --- | --- |
| Minimum filstørrelse | `5` GB | Spring filer under 5 GB over |
| Maksimum filstørrelse | `50` GB | Spring filer over 50 GB over |
| Minimum varighed | `10` minutter | Spring fx korte klip/trailere over |
| Minimum kildehøjde | `720` pixels | Spring lavere kilder over; ændrer ikke opløsningen |
| Fravalgte videoformater | H.265/HEVC og AV1 | Spring allerede komprimerede kilder med disse codecs over |

GB i filtrene er decimal: **1 GB = 1.000.000.000 bytes**. Størrelsesvisningen i joblisten bruger GiB (1.073.741.824 bytes). En fil på præcis minimum/maksimum accepteres. `0` deaktiverer grænsen. Filen springes over, hvis ét filter udelukker den; årsagen vises i listen og jobdetaljerne. Codec alene siger ikke noget sikkert om kvalitet eller mulig besparelse.

Størrelse kontrolleres efter filstabilitet ved scanning og igen før encoding. Varighed, højde og codec kontrolleres med FFprobe, når jobbet når frem i køen, før encoding starter. **Anvend filtrene på ventende jobs** er slået til som standard ved redigering: størrelsesfiltre anvendes straks, mens metadatafiltre kontrolleres ved jobstart. Ventende jobs beholder deres øvrige encoding-profil. Aktive jobs ændres ikke. Slå valget fra for kun at ændre filtre på fremtidige jobs. Allerede oversprungne jobs kan genstartes med **Prøv igen**, når filtrene er rettet.

**Vis pr. side** over joblisten giver valgene 30, 50, 100, 200, 500 og Alle. Valget huskes i din browser. Alle viser alle jobs, som matcher den aktuelle søgning og status; meget store lister kan være langsommere. Grænsen for fjernelse er fortsat 100 valgte jobs ad gangen.

**Fjern** og **Fjern valgte** rydder poster fra kø/historik, og ventende jobs tages ud af køen. Originaler, SRT og færdige outputfiler bevares. Aktive/annullerende jobs kan først fjernes, når de er stoppet. Vælg alle på den synlige side, eller markér enkelte jobs på tværs af sider (maks. 100 ad gangen). Ændring af søgning eller statusfilter nulstiller markeringen. En batch fjernes enten samlet eller slet ikke.

ReelShrink gemmer registreringen af fjernede jobs, så samme uændrede kilde ikke dukker op igen ved næste scanning/genstart. Ændringer i video eller tilhørende filer kan oprette en ny revision. Fjernede poster er ikke længere med i den viste statistik. Der er ingen fortryd-knap. Hvis en uændret fil skal behandles på ny, kan du lægge en kopi i en anden overvåget kildeplacering; fjernelse og gentilføjelse af hele overvågningsmappen nulstiller også dens historik.

Profiler vælges pr. mappe i GUI'en. De gemmes i SQLite. Jobs tager en kopi af profilen, når de sættes i kø; senere profilændringer gælder nye jobs og jobs, du aktivt genstarter. Filtre kan desuden anvendes på den eksisterende ventende kø som beskrevet ovenfor. Tabellen nedenfor viser miljøvariabler til selve tjenesten.

| Variabel | Standard | Betydning |
| --- | --- | --- |
| `PORT` | `8080` | Intern HTTP-port; tilpas også portmapping/proxy ved ændring |
| `HOST` | `0.0.0.0` | Intern bind-adresse |
| `CONFIG_DIR` | `/config` | Database og persistent konfiguration |
| `MEDIA_ROOTS` | `/media` | Tilladte rødder, adskilt med kolon |
| `OUTPUT_ROOT` | `/output` | Rod for færdige og midlertidige resultater |
| `SCAN_INTERVAL` | `30` | Sekunder mellem scanninger; mindst 5 |
| `STABLE_SECONDS` | `60` | Minimumstid med uændrede filstørrelser og ændringstider; mindst 5 |
| `ENCODE_THREADS` | `2` | Ønsket antal FFmpeg/encoder-tråde; 1–128 |
| `MIN_FREE_GB` | `2` | Minimum ledig outputplads før start, i GiB |
| `AUTH_USERNAME` | Tom | Brugernavn til valgfri HTTP Basic-login |
| `AUTH_PASSWORD` | Tom | Adgangskode; kræver også brugernavn |
| `AUTH_PASSWORD_FILE` | Tom | Fil med adgangskode; prioriteres over `AUTH_PASSWORD` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Alternative binærstier |

`PUID`, `PGID`, `WEB_BIND`, `WEB_PORT`, `REELSHRINK_IMAGE` og `*_PATH` i `.env.example` bruges af Compose. Der findes ingen root-entrypoint, som ændrer ejerskab; `PUID`/`PGID` sættes via Compose-feltet `user`. `TZ` indstiller containerens tidszone; GUI'en viser tider i browserens lokale tidszone.

Før et job startes, kræves mindst den største af `MIN_FREE_GB` og 110 % af originalens størrelse som ledig outputplads. Det er en startkontrol, ikke en pladsreservation eller en garanti. Hvis encodingen løber tør for plads, fejler jobbet og den midlertidige fil ryddes op. `ENCODE_THREADS` er ikke en hård CPU-kvote; brug eventuelt Compose-feltet `cpus` for at begrænse containeren yderligere.

### Login og netværk

Standardinstallationen har ikke login. Brug den på et betroet netværk, eller sæt adgangskontrol i din reverse proxy. Skal den eksponeres eksternt, skal proxyen bruge HTTPS og passende login. Den indbyggede Basic-login kan aktiveres ved at udfylde både `AUTH_USERNAME` og `AUTH_PASSWORD` og genoprette containeren. Adgangskoder kan alternativt monteres som en secret og angives via `AUTH_PASSWORD_FILE`.

Ingen telemetri, cloud-konto eller Docker-socket kræves. Applikationen uploader ikke dine mediefiler. Se [SECURITY.md](SECURITY.md).

### Fedora og SELinux

På Fedora kan bind mounts kræve SELinux-labels ud over almindelige UNIX-rettigheder. Til dedikerede, lokale `config`-/`output`-mapper kan du anvende Compose-mounts som `./config:/config:Z` og `./output:/output:Z`. Til lokale medier, der deles med andre containere, anvendes typisk `:ro,z`. Brug ikke privat `:Z` på mediemapper, som andre containere også læser.

NFS/SMB kan kræve særskilte mount-/SELinux-indstillinger og understøtter ikke nødvendigvis relabeling. Kontroller hostens opsætning frem for at køre containeren privilegeret. Se [Docker-dokumentationen om SELinux-labels](https://docs.docker.com/engine/storage/bind-mounts/#configure-the-selinux-label).

## Opdatering, backup og fejlfinding

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker compose logs --tail=100 -f
```

Brug `-f compose.proxy.yaml`, hvis det er den valgte installation. Pin gerne `REELSHRINK_IMAGE` til en udgivet version eller digest frem for `latest`.

- **Backup:** Stop tjenesten, og tag kopi af hele `/config` samt de outputfiler, du vil bevare. Start derefter tjenesten igen. Kopiering af kun `.sqlite` under drift kan udelade aktive WAL-transaktioner.
- **Genstart:** Et afbrudt encoding-job starter fra begyndelsen; FFmpeg kan ikke fortsætte midt i den midlertidige fil. Kø, mapper og pauseindstilling bevares.
- **Fejlet job:** Åbn jobbet, læs fejl/log, ret problemet, og vælg **Prøv igen**. Fejlede jobs genstartes ikke uendeligt af sig selv.
- **Ingen filer:** Kontroller containerstien, læserettigheder, mappens status og stabilitetsperioden. Første scanning sætter ikke straks filer i kø. Skjulte filer/mapper og symlinks springes over.
- **Langsomme kopieringer:** En kopiering, der står stille længere end stabilitetsperioden, kan ikke skelnes perfekt fra en færdig fil. Flyt helst færdige downloads atomisk ind i den overvågede mappe, og øg `STABLE_SECONDS` ved behov. Kildens signatur kontrolleres også før og efter encoding.
- **NAS utilgængelig:** Scanningsfejlen vises ud for mappen. De næste scanninger forsøger igen. Et allerede fejlet job kræver **Prøv igen**, når NAS'en er tilbage.
- **En fil er allerede behandlet:** Uændret sti, størrelse og ændringstid for video og tilhørende filer genkendes på tværs af genstarter. En filændring, som bevidst bevarer både størrelse og nanosekund-præcis ændringstid, registreres ikke.
- **Healthcheck:** `GET /api/health` returnerer status og version uden login. Healthcheck bruger den medfølgende Node-runtime og afhænger ikke af `curl`/`wget`.
- **Fjern overvågning:** Stop/annullér mappens jobs først. **Fjern** sletter kun overvågning og dens historik, aldrig input-/outputfiler. Hvis mappen tilføjes igen, kan de samme kilder behandles igen.

## GitHub og automatisk image-udgivelse

Se [docs/PUBLISHING.md](docs/PUBLISHING.md) for første udgivelse. Workflowet `publish.yml`:

1. Kører integrationstests med rigtig FFmpeg, validerer Compose og tester den byggede container.
2. Bygger `linux/amd64` og `linux/arm64`.
3. Udgiver til `ghcr.io/<ejer>/<repo>` med GitHubs egen `GITHUB_TOKEN`; der skal ikke gemmes en personlig token i kildekoden.
4. Ved push til `main`: `latest` og `sha-…`. Ved tag `v0.2.0`: `0.2.0`, `0.1` og `sha-…`.
5. Vedhæfter OCI-metadata, provenance og SBOM.

Et offentligt repository gør ikke nødvendigvis den tilhørende GHCR-pakke offentlig automatisk. Kontroller pakkens synlighed under GitHub Packages, hvis imaget skal kunne hentes uden login.

## Udvikling og test

Installer Node.js 24 samt FFmpeg med libx265/libx264. Der er ingen tredjeparts-npm-afhængigheder og intet frontend-buildtrin.

```bash
node --test --test-concurrency=1 tests/*.test.mjs
```

Lokal opstart med egne, separate mapper:

```bash
mkdir -p dev-config dev-output dev-media
CONFIG_DIR="$PWD/dev-config" OUTPUT_ROOT="$PWD/dev-output" MEDIA_ROOTS="$PWD/dev-media" node app/server.mjs
```

Hold lokale medier og databasefiler ude af Git. De almindelige `config`, `output` og `media` er ignoreret; øvrige lokale arbejdsmapper skal også ignoreres, hvis de oprettes i repoet.

Se [docs/API.md](docs/API.md), [docs/TESTING.md](docs/TESTING.md), [CONTRIBUTING.md](CONTRIBUTING.md) og [CHANGELOG.md](CHANGELOG.md).

## Teknisk grundlag

- [FFmpeg: stream mapping, codecs, metadata, progress og dispositions](https://ffmpeg.org/ffmpeg.html)
- [GitHub: publicering af Docker-images til Container Registry](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [Node.js 24: SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Tredjepartslicenser](THIRD_PARTY_NOTICES.md)
