# Changelog

## 0.3.0 — 2026-09-10

- Tilbageflytning som integreret side: præcist jobmatch, outputovervågning og manuel fra-/tilsammenligning af film og serieafsnit.
- Sikker kopiering med SHA-256, fuld dekodning, no-clobber-publicering og vedvarende journal.
- Originaler gemmes som `.OLD`; GUI med enkelt-/batchflytning, manuel bekræftet sletning og gendannelse.
- Returnerede videoer encodes ikke igen; ændrede originaler, tvetydige navne, målkonflikter og sidefilkonflikter blokeres.
- Dockge/Pangolin Compose til tre skrivbare mediemapper, output og ekstra fra-mappe.

## 0.2.1 — 2026-09-09

- Vælg 30, 50, 100, 200, 500 eller alle jobs i listen.
- Sidestørrelsen huskes i browseren, og sideskift tilpasses valget.
- API understøtter op til 500 jobs pr. side eller `limit=all`, med stabil sortering.

## 0.2.0 — 2026-09-09

- Fjern-knap i jobliste og detaljer samt markering/fjernelse af op til 100 jobs.
- Bevarer alle mediefiler og genkendelse af uændrede kilder efter fjernelse.
- Filtre for minimum/maksimum GB, minimum varighed og kildehøjde samt fravalg af H.265, AV1 og H.264.
- Valgfri anvendelse af filtre på eksisterende kø, med synlige årsager til overspringning.
- Automatisk databaseopgradering fra v0.1 og bagudkompatible standardindstillinger.
- Tests af grænser, migration, filbevaring, samlet fjernelse og køfiltrering.

## 0.1.0 — 2026-09-08

Første version klargjort til udgivelse.

- Dansk web-GUI til mapper, profiler, kø, historik og jobdetaljer.
- H.265/H.264 CPU-encoding til MKV med kvalitets-/opløsningsvalg.
- Valgbare indlejrede SRT-spor, sproggenkendelse og tegnsætsnormalisering.
- Bevaring af eksisterende lyd-/undertekstspor, kapitler og vedhæftninger.
- Vedvarende SQLite-kø, filstabilitetskontrol, annullering og genstartshåndtering.
- Input monteret read-only i de medfølgende Compose-filer.
- Fuld dekodningskontrol og valgfri kassering af større outputfiler.
- HDR/Dolby Vision og interlaced video springes over.
- Dockerfile, almindelig Compose, proxy-variant, lokal build-override og GHCR-workflow.
- Integrationstests med rigtige videofiler og undertekster.
