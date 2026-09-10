# JSON-API

Samme origin og port som GUI'en. JSON-svar. HTTP Basic gælder alle endpoints undtagen `GET /api/health`, hvis login er aktiveret. Alle skrivende kald skal sende headeren `X-ReelShrink: 1`. POST/PUT kræver desuden `Content-Type: application/json`. En medsendt `Origin` skal have samme host/port som forespørgslens `Host`.

| Metode | Endpoint | Funktion |
| --- | --- | --- |
| GET | `/api/health` | Status/version uden login |
| GET | `/api/config` | Offentlig runtime-konfiguration, aldrig adgangskode |
| GET | `/api/status` | Pause, jobantal, størrelsesforskel, ledig plads og aktivt job |
| GET | `/api/browse` | Tilladte mediarødder |
| GET | `/api/browse?path=/media/movies` | Undermapper inden for tilladte rødder |
| GET | `/api/watches` | Alle overvågningsmapper |
| POST | `/api/watches` | Tilføj mappe, se eksempel nedenfor |
| PUT | `/api/watches/{id}` | Opdater `name`, `enabled` og/eller `settings`; sti ændres ikke |
| DELETE | `/api/watches/{id}` | Fjern mappe og historik; afvises ved ventende/aktive jobs |
| POST | `/api/scan` | Bed om scanning; body `{}`; svar 202 |
| POST | `/api/queue` | Body `{"paused": true}` eller `false` |
| GET | `/api/jobs` | Søg/filtrér/paginér jobs |
| GET | `/api/jobs/{id}` | Detaljer inklusive begrænset FFmpeg-log |
| DELETE | `/api/jobs/{id}` | Fjern posten; mediefiler og kildegenkendelse bevares |
| POST | `/api/jobs/remove` | Fjern 1–100 poster samlet; body `{"ids":["uuid", "uuid"]}` |
| POST | `/api/jobs/{id}/cancel` | Annullér; body `{}` |
| POST | `/api/jobs/{id}/retry` | Genstart med mappens nuværende profil; body `{}` |
| GET | `/api/returns` | Indstillinger, scanning, aktiv flytning og match-/OLD-historik |
| PUT | `/api/returns/settings` | `{"automatic":false,"from":"/incoming","to":"/media"}`; tomme fra/til bruger kun jobforbindelser |
| POST | `/api/returns/scan` | Start scanning; `{}`; svar 202 |
| POST | `/api/returns/move` | `{"ids":["uuid"]}`; 1–100 klare poster sættes i kø; svar 202 |
| POST | `/api/returns/{id}/choose` | `{"original":"/media/…"}`; vælg en foreslået kandidat |
| POST | `/api/returns/{id}/retry` | `{}`; genkontrollér en fejlet flytning uden filændringer |
| POST | `/api/returns/{id}/restore` | `{}`; gendan original, bevar øvrige kopier |
| POST | `/api/returns/delete-old` | `{"ids":["uuid"],"confirmation":"SLET OLD"}`; permanent sletning efter checksumkontrol |

Jobliste-parametre: `state=all|active|completed|failed|skipped|cancelled`, `q=<tekst>`, `offset=0`, `limit=30` (1–500 eller `all`). Svaret er `{items,total,limit,offset}`. `active` omfatter kø, encoding og igangværende annullering. `settings` og `bundle` i et job er snapshots fra oprettelsen.

Eksempel:

```bash
curl -X POST http://localhost:8080/api/watches \
  -H 'Content-Type: application/json' \
  -H 'X-ReelShrink: 1' \
  --data '{"name":"Film","path":"/media/movies","settings":{"codec":"hevc","quality":"balanced","preset":"medium","maxHeight":0,"audio":"copy","onlySmaller":true,"copySidecars":true}}'
```

Ved aktiveret Basic-login kan curl spørge om password med `-u BRUGERNAVN`, så password ikke skrives i shell-historikken.

Fejl svarer med `{"error":"beskrivelse"}`. API'et tilbyder ikke fil-upload, mediedownload, vilkårlige FFmpeg-argumenter eller shell-kørsel. Den komplette schema-/API-kontrakt er endnu ikke versionsopdelt i v0.1; se kildekoden ved integrationer.


## Filtre (v0.2)

`settings` understøtter `minSizeGB`, `maxSizeGB`, `minDurationMinutes`, `minSourceHeight` (tal; standard 0) og `skipCodecs` (liste af `hevc`, `av1`, `h264`; standard tom). 0 slår en grænse fra. GB er decimal, ikke GiB. Negative/ikke-numeriske værdier, maksimum under minimum og ukendte codecs afvises. Minimumhøjde skal være et helt tal.

`PUT /api/watches/{id}` accepterer delvise settings og `applyFiltersToQueued` (boolean, standard true). Kun filterfelter anvendes på eksisterende ventende jobs; deres øvrige encoding-indstillinger bevares. Aktive og allerede afsluttede jobs ændres ikke. Størrelsesfiltre anvendes straks; metadatafiltre evalueres ved jobstart. Ved false gælder ændringen nye/genstartede jobs.

## Fjernelse (v0.2)

Fjernelse skjuler jobbet, stopper et ventende job og bevarer kilde-signaturen som beskyttelse mod genoprettelse ved scanning. Ingen input-/outputfiler slettes. Skjulte jobs udelades fra lister/statistik og giver 404 ved detailopslag. `/retry` genopliver dem ikke.

En batch afvises uden ændringer, hvis et ID mangler (404), et job kører/annulleres (409), eller input er ugyldigt (400). Dubletter tælles kun én gang. Succes: `{"removed":2}`. Samme login-/CSRF-beskyttelse som andre skrivende endpoints.

Ved `limit=all` returneres alle matchende, synlige jobs, og `offset` sættes til 0. Svarets `limit` er da strengen `all`; ellers er den et tal. Søge-/statusfiltre gælder også for Alle. Ugyldige sideparametre giver 400. Fjernelse er fortsat begrænset til 100 jobs pr. kald.
