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
| POST | `/api/jobs/{id}/cancel` | Annullér; body `{}` |
| POST | `/api/jobs/{id}/retry` | Genstart med mappens nuværende profil; body `{}` |

Jobliste-parametre: `state=all|active|completed|failed|skipped|cancelled`, `q=<tekst>`, `offset=0`, `limit=30` (maks. 100). Svaret er `{items,total,limit,offset}`. `active` omfatter kø, encoding og igangværende annullering. `settings` og `bundle` i et job er snapshots fra oprettelsen.

Eksempel:

```bash
curl -X POST http://localhost:8080/api/watches \
  -H 'Content-Type: application/json' \
  -H 'X-ReelShrink: 1' \
  --data '{"name":"Film","path":"/media/movies","settings":{"codec":"hevc","quality":"balanced","preset":"medium","maxHeight":0,"audio":"copy","onlySmaller":true,"copySidecars":true}}'
```

Ved aktiveret Basic-login kan curl spørge om password med `-u BRUGERNAVN`, så password ikke skrives i shell-historikken.

Fejl svarer med `{"error":"beskrivelse"}`. API'et tilbyder ikke fil-upload, mediedownload, vilkårlige FFmpeg-argumenter eller shell-kørsel. Den komplette schema-/API-kontrakt er endnu ikke versionsopdelt i v0.1; se kildekoden ved integrationer.
