# Første udgivelse på GitHub / GHCR

Denne vejledning er til projektets ejer. Det inkluderede workflow publicerer et image, når koden pushes til `main` eller et versionstag. Det kræver et GitHub-repository og tilladelse til at køre Actions og skrive Packages.

## Opret repository

Opret et nyt repository med navnet `reelshrink` på din GitHub-konto. Undlad automatisk README/gitignore/licens ved oprettelsen, da filerne allerede er med. Vælg selv repository-synlighed; brug public, hvis projektet skal være frit tilgængeligt.

Fra den udpakkede projektmappe:

```bash
git init -b main
git add .
git commit -m "Initial ReelShrink service"
git remote add origin https://github.com/Kirederb-Vibing/reelshrink.git
git push -u origin main
```

Autentificér via din almindelige GitHub/Git-opsætning. Gem ikke tokens i remote-URL, README, `.env.example` eller workflows. Brug GitHub CLI `gh auth login`, hvis den allerede er installeret. Ved HTTPS-push skal en eventuel token kunne oprette/ændre workflow-filer.

## Kontroller build og adgang

1. Åbn repoets **Actions** og workflowet **Publish GHCR image**.
2. Begge jobs, `verify` og `publish`, skal være grønne. Workflowet bruger `packages: write` til udgivelsen. En organisationspolitik kan begrænse dette.
3. Åbn pakken under kontoens/repoets **Packages**. Kontroller, at både `linux/amd64` og `linux/arm64` findes.
4. Hvis imaget skal være offentligt: vælg **Package settings → Change visibility → Public**. GHCR-pakkens synlighed skal kontrolleres separat fra repoets.
5. Sæt i din lokale `.env`:

   ```dotenv
   REELSHRINK_IMAGE=ghcr.io/kirederb-vibing/reelshrink:latest
   ```

6. Test et pull fra serveren og start den valgte Compose-fil:

   ```bash
   sudo docker compose pull
   sudo docker compose up -d
   ```

For en privat pakke skal Docker først logges ind på `ghcr.io` med passende læseadgang. Login og pull skal bruge samme Docker-brugerkontekst, når du anvender `sudo`.

## Versioner og releases

Opdater versionen i `package.json`, `app/config.mjs`, `Dockerfile` og `CHANGELOG.md`, og commit ændringen. Ved første release er disse allerede sat til `0.1.0`.

```bash
git tag v0.1.0
git push origin v0.1.0
```

Tag-push udgiver `:0.1.0` og `:0.1`. `:latest` følger `main`. En GitHub Release kan derefter oprettes fra samme tag med indholdet fra CHANGELOG; selve imaget kræver ikke en GitHub Release.

## Hvad CI verificerer

- JavaScript-syntaks og faktiske video-/underteksttests på en x86-runner.
- Begge Compose-varianter og lokal build-override.
- Docker-build, opstart, indbygget healthcheck og drift som UID 1000.
- Cross-build af amd64 og arm64 med Buildx/QEMU før push.

ARM64-imaget cross-bygges, men integrationstests kører på amd64. Lav en afspilnings-/encodingtest på din konkrete ARM-enhed før et stort bibliotek køres igennem. Workflowet publicerer ikke, hvis verifikationsjobbet fejler.

Officielt grundlag: [GitHubs GHCR-workflow-vejledning](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) og [pakkers synlighed og adgang](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
