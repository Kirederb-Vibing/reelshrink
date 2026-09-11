# Tilbageflytning og manuel OLD-kø (v0.3)

Funktionen er en del af ReelShrink og findes under **Tilbageflytning & OLD-kø** (`/returns`). Den bruger samme container, login og database. Der skal ikke installeres et separat plugin.

## Kom i gang på din server / Dockge

1. Brug version 0.3 eller nyere. Den bliver først tilgængelig som `latest`, når ændringen er merged til `main`, og GitHubs publiceringsworkflow er grønt.
2. Bevar din nuværende **config-mappe/database, outputmappe og containerstier**. Jobhistorikken indeholder den præcise originalsti; ændres `/media/film` fx til `/media/movies`, kan gamle jobs ikke findes på deres oprindelige stier. `MOVIES_CONTAINER_PATH`, `MOVIES_2_CONTAINER_PATH` og `SERIES_CONTAINER_PATH` i `return.env.example` skal svare til dine nuværende mounts (alle under `/media`). Brug også din eksisterende `CONFIG_PATH`, hvis den fx er en `userdata`-mappe.
3. `compose.return.yaml` er en selvstændig Compose-fil klar til Dockge, med alle tre hostmapper `/srv/media/movies`, `/srv/media/movies_2` og `/srv/media/series`, output `/srv/reelshrink/encoded`, netværket `proxy` og **ingen hostporte**. Indsæt filen i den eksisterende ReelShrink-stack, og brug `return.env.example` som udgangspunkt for dens `.env`. Kør ikke en ekstra instans med samme database.
4. Mediebiblioteket skal nu være monteret **læs/skriv**, og containerens UID/GID skal have lov til at oprette/omdøbe/slette filer i de relevante mapper. De oprindelige `compose.yaml` og `compose.proxy.yaml` beholder read-only mediemounts til dem, der kun ønsker encoding. På lokale SELinux-mounts kan delt `:z` være relevant; brug ikke privat `:Z` på biblioteker, andre containere benytter. NAS-rettigheder skal tillade filoperationerne for din UID/GID.
5. Opret kun den nye ekstra fra-mappe, hvis den mangler:

   ```bash
   sudo mkdir -p /srv/reelshrink/incoming
   sudo chown 1000:1000 /srv/reelshrink/incoming
   ```

   Tilpas tallene til dine `PUID`/`PGID`. Eksisterende config, output og mediemapper skal allerede være til stede; Compose opretter ikke tomme mapper, hvis et mount mangler.

6. Efter udgivelse: **Pull** og **Update** i Dockge. Alternativt fra repoet, med tilpasset `.env`:

   ```bash
   sudo docker compose -f compose.return.yaml pull
   sudo docker compose -f compose.return.yaml up -d
   ```

7. Proxy-destinationen er fortsat `http://reelshrink:8080`. Åbn **Tilbageflytning**, vent på stabilitet (standard 60 sekunder), og prøv **Flyt** på én fil. Kontrollér afspilning, lyd og undertekster. Derefter kan **Flyt automatisk færdige Reelshrink-filer** aktiveres.

## Matchning

**ReelShrink-output:** Den færdige outputsti matches med den eksisterende database, også hvis jobbet er skjult fra encoding-listen. Kildens tidligere signatur kontrolleres igen; ændret video/SRT/metadata blokerer tilbageflytningen. Nye encodes gemmer desuden SHA-256 i databasen og `reelshrink.json`. Ældre afsluttede jobs kan bruges med deres eksisterende kilde-signatur, outputstørrelse og en ny mediekontrol. Manifestet alene er ikke autoritet til at erstatte en vilkårlig fil.

**Andre filer:** Vælg en **fra-mappe** under `/incoming` eller `/output` og en **til-mappe** under `/media`. Begge scannes rekursivt. `/media` kan samle film, film_2 og serier i samme sammenligning. Kun ét ekstra mappepar gemmes i denne version; vælg et andet par efter behov. `RETURN_INPUT_ROOTS` kan angive flere separat monterede fra-rødder, adskilt med kolon.

- Film: normaliseret titel + årstal skal være ens. Punktummer, mellemrum og typiske separatorer normaliseres. Fx `The.Matrix.1999.1080p.mkv` matcher `The Matrix (1999).mp4`.
- Serier: normaliseret serietitel + sæson + episodenummer skal være ens. `Show.S01E02.mkv` matcher `Show 1x02.mp4`.
- Titler uden år, kombinerede/range-episoder, samples og trailere får intet sikkert match. Ret filnavnet og scan igen.
- Kendte editionsbetegnelser som Extended, Director's Cut, IMAX og Unrated adskilles. Filnavne kan ikke bevise, at to udgaver er identiske; gennemgå derfor alle generiske matches manuelt. Appen henter ikke oplysninger fra TMDB/TVDB eller internettet.
- Flere mulige originaler vises som **Vælg original**. Du skal vælge en af de foreslåede filer. Et ukendt eller tvetydigt match flyttes aldrig automatisk.
- Generiske navnematches kræver altid **Flyt** / **Flyt valgte**, også når automatisk ReelShrink-tilbageflytning er slået til.

Fra- og tilmapper må ikke overlappe. Symlinks og skjulte filer/mapper springes over. Mapperne skal være synlige **inde i containeren**.

## Sådan erstattes filen

1. Frafilen skal have været uændret i `STABLE_SECONDS`. Stier og kilde-signatur genkontrolleres.
2. FFprobe sammenligner varigheden (højst 1 % eller 2 sekunders afvigelse, den største grænse gælder). Hele den nye video og lyd dekodes med FFmpeg. Det er en integritetskontrol, ikke en måling af subjektiv billedkvalitet.
3. Der skal være plads på destinationsdisken til den nye video og nye sidefiler plus `MIN_FREE_GB`. Videoen kopieres til en skjult midlertidig fil på **samme disk som originalen**. SHA-256 og flush til disk kontrolleres, før originalstien ændres.
4. Originalen får endelsen `.OLD`, fx `Film.mp4.OLD`. Den nye fil får originalens navn med den nye containerendelse, fx `Film.mkv`. Eksisterende mål- eller OLD-filer overskrives aldrig.
5. Eksisterende SRT/NFO/billeder beholdes. Nye tilhørende sidefiler kopieres med den relevante navnestamme og undermappe. Forskelligt indhold under samme sidefilnavn blokerer hele flytningen før ændring af originalen. Indlejrede, valgbare undertekster følger videoen.
6. Efter checksumkontrol af den installerede video fjernes **kun fra-videoen**. Sidefiler og manifest i output beholdes som dokumentation; mapper slettes aldrig rekursivt.
7. Originalen vises i **OLD-køen**. Returnerede videoer registreres ved sti og filfingeraftryk, så encoding-scanneren ikke komprimerer dem igen, heller ikke efter genstart. Ændres selve videofilen senere, kan den opdages som en ny revision. Sidefilændringer alene starter ikke ny encoding af en returneret video.

Flytninger udføres én ad gangen. Scanning bruger `SCAN_INTERVAL`. Fjern fluebenet ved automatisk flytning og gem for at stoppe nye automatiske flytninger og tage ventende automatiske jobs ud af køen; den aktuelle flytning færdiggøres. Encoding-køens pause er separat. Fejlede flytninger gentages ikke automatisk; ret problemet og vælg **Prøv igen**.

## OLD-kø og gendannelse

Vælg én eller op til 100 OLD-filer, vælg **Slet valgte OLD-filer**, gennemgå de viste stier, og skriv **SLET OLD**. Både OLD og den nye video skal stadig have samme fingeraftryk og SHA-256 som efter flytningen. Er erstatningen ændret, manglende eller et symlink, blokeres sletning. Der er ingen tidsbaseret automatisk sletning.

Batchen kontrolleres først samlet og derefter fil for fil. Hvis NAS/filoperationer fejler midt i sletningen, kan tidligere valgte OLD-filer allerede være slettet; listen viser den gennemførte historik. Permanent sletning kan ikke fortrydes.

**Gendan original** sætter originalen tilbage. Den nye video gemmes om nødvendigt med endelsen `.RETURNED-<id>`, så den ikke scannes som video. OLD, midlertidige kopier og tilføjede sidefiler bevares til manuel gennemgang. Kun normale afsluttede flytninger har OLD-filer, som kan slettes gennem køen; rester fra gendannelse ryddes manuelt efter kontrol.

## Usikker flytning

Et færdigt ReelShrink-job kan markeres **Usikker flytning** pr. fil. Valget er også tilgængeligt for et blokeret eller fejlet præcist jobmatch. ReelShrink kopierer og checksumkontrollerer filen, men springer varighedssammenligning, fuld dekodning, ændringskontrol og OLD-kø over. Den registrerede originalvideo slettes, og inputvideoen fjernes efter installation. Sidefiler ændres ikke. Funktionen accepterer ikke navnematch uden ReelShrink-jobhistorik.

## Afbrydelse, NAS og begrænsninger

- En SQLite-journal skrives før filændringer. En afbrudt flytning markeres **Kræver gendannelse** efter genstart og genstartes ikke automatisk. Journalen viser original, mål, OLD og midlertidig fil. Brug **Gendan original** efter gennemgang.
- No-clobber-publicering bruger hardlinks **inden for samme destinationsmappe/filsystem**, efter kopiering fra output. NAS'en skal understøtte hardlinks og fsync. Hvis den ikke gør, stopper flytningen før fjernelse af originalen; den nye midlertidige kopi kan ligge tilbage. Ingen usikker overwrite-fallback bruges.
- Kør kun én ReelShrink-instans mod databasen. Lad ikke andre programmer flytte/ændre de samme filer under en tilbageflytning. Appen genkontrollerer filer, men kan ikke låse eksterne downloadere, Sonarr/Radarr eller NAS-administration ude.
- Stabilitet er ikke bevis på, at en langsom kopiering er afsluttet. Flyt færdige eksterne filer atomisk ind i fra-mappen, eller øg stabilitetstiden. ReelShrinks eget output publiceres først efter fuldført encoding.
- Checksums, dekodning og sikker kopiering giver ekstra disk-I/O og CPU-forbrug. Gamle filers fulde størrelse frigives først, når OLD slettes.
- Et utilgængeligt mount giver synlig scannings-/flyttefejl. Manglende mapper oprettes ikke automatisk som tomme biblioteker.
- Brugerfladen viser 30, 50, 100, 200, 500 eller alle matches pr. side. API'et henter historikken samlet i denne første version; meget store biblioteker kan derfor kræve senere serverpaginering.

## Før merge: lokal build uden nyt GHCR-image

Med tilpasset `.env`, eksisterende mapper og denne branches kildekode:

```bash
sudo docker compose -f compose.return.yaml -f compose.build.yaml up -d --build
```

Den almindelige `latest` indeholder først funktionen efter merge og vellykket publicering.
