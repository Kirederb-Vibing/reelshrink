# Verifikation af v0.6.0

12. september 2026: **84 tests bestået, 0 fejlet** med Node.js 24.19.0 og FFmpeg. `npm run check` og `git diff --check` er bestået.

13 nye testcases dækker det samlede Work-workflow: NAS/lokal import, rigtig encoding og automatisk Work-oprydning, valgt tilbageførsel uden OLD, samme/ændret filendelse, ændret kilde/resultat, journalgenoptagelse efter afbrudt publicering, målkonflikt, stop af kø, fjernelse/genimport, omdøbning/genfinding, isolerede afsnit, streamet browserupload, destination og auth/CSRF på HTTP-ruter samt separate HDR/Atmos-valg.

De 71 eksisterende tests bevares, herunder legacy-returner og legacy-archive via eksplicit injektion af den tidligere Archive-klasse i dens testfixtures. Produktionsstandard i Work-tilstand er WorkArchive.

Browserupload er kontrolleret gennem HTTP med rå bytes; en interaktiv browsertest kunne ikke køres, fordi Chromium ikke er installeret i arbejdsmiljøet. Testene anvender lokale filsystemer; konkret SMB/NFS-adfærd og HDR/Atmos-afspilningskvalitet er ikke verificeret på brugerens NAS/afspiller.
