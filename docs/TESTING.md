# Verifikation af v0.2.0

9. september 2026: **20 tests bestået, 0 fejlet**, inklusive 3 undertests for metadatafiltre. Dækker også v0.1-databasemigration, eksakte GB-grænser, samlet fjernelse med rollback, filbevaring, genkendelse efter genstart, opdatering af ventende jobs og opt-out. Den eksisterende encoding-testpakke er genkørt.

## Tidligere verifikation

### v0.1.0

Udført 8. september 2026 på Linux amd64 med Node.js **24.19.0** og FFmpeg **6.1.1-3ubuntu5**, inklusive libx265 og libx264.

## Resultat

**11 integrationstests bestået, 0 fejlet, 0 sprunget over.** Testene genererer deres egne små videofiler og anvender faktiske FFmpeg-processer. Ingen brugerfilm eller downloads indgår.

| Test | Resultat |
| --- | --- |
| H.265-encoding med uændret opløsning, to lydspor, kapitler og vedhæftning | Bestået |
| Tre valgbare undertekstspor, danske tegn og Windows-1252-normalisering | Bestået som del af encoding-testen |
| Eksisterende lyddata og originalfil bevares byte-for-byte | Bestået som del af encoding-testen |
| Episode-match og udelukkelse af symlinks | Bestået |
| Ændrede filer nulstiller stabilitetsperioden | Bestået |
| HDR springes over uden at ændre originalen | Bestået |
| Større resultat kasseres ved `onlySmaller` | Bestået |
| H.264, eksplicit AAC stereo og ingen opskalering | Bestået |
| Reel nedskalering til 720p med bevaret sideforhold; ingen lyd nødvendig | Bestået |
| MP4-undertekster i mov_text konverteres til valgbare MKV/SubRip-spor | Bestået |
| Ændret kilde efter kølægning og utilstrækkelig outputplads afvises | Bestået |
| Pause, annullering og genstartshåndtering | Bestået |
| HTTP-login, CSRF-header/origin, stibegrænsning og levering af GUI-filer | Bestået |

Flere kontroller indgår i samme test, derfor har tabellen flere rækker end antallet af tests.

Den primære genererede testvideo gik fra **972.693 bytes** til **242.243 bytes**, svarende til ca. **75 %** mindre videofil. Den beholdt **480 × 270**, to lydspor, tre undertekstspor, et kapitel og en vedhæftning. Det er en teknisk fixture, ikke et benchmark for filmkvalitet eller et løfte om pladsbesparelse på en virkelig filmsamling.

Derudover er applikationens JavaScript-syntaks, YAML-syntaks, statiske GUI-referencer, dokumentationslinks, read-only input-mounts og den portfrie proxy-variant kontrolleret.

## Ikke verificeret i forberedelsesmiljøet

- **Docker:** Ikke tilgængelig lokalt. GitHub Actions bygger containeren og tester opstart/healthcheck som UID 1000. v0.1 bestod dette gate 8. september 2026; nye versioner bruger samme gate.
- **GHCR:** v0.1 blev publiceret 8. september 2026, og det offentlige manifest blev verificeret uden login for amd64/arm64. Nye versioner publiceres kun efter et grønt verifikationsjob.
- **ARM64-kørsel:** Workflowet indeholder cross-build, men ingen test på fysisk ARM-hardware er udført.
- **Visuel browser-QA:** GUI-filer, referencer og API er kontrolleret. Det interaktive browsertestforsøg for v0.2 blev blokeret af browsermiljøet (`ERR_BLOCKED_BY_CLIENT` til den lokale testside); ingen interaktiv browsertest er gennemført.
- **Lange film, NAS-afbrydelser, subjektiv billedkvalitet og afspillerkompatibilitet:** Prøv en repræsentativ film på målserveren og din normale afspiller før et stort bibliotek sættes i gang.

## Gentag testene

```bash
node --test --test-concurrency=1 tests/*.test.mjs
```

Testene bruger midlertidige mapper og rydder op efter sig. Hele `tests/service.test.mjs` skal bestå før release. Ændringer til codecs, subtitles, filflytning eller genstartshåndtering bør følges af en relevant test, som demonstrerer den ønskede adfærd.
