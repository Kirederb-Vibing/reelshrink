# Contributing

ReelShrink uses Node.js 24 built-ins, SQLite, FFmpeg and plain HTML/CSS/JavaScript. No npm install or UI build step is required.

1. Create a branch from `main`.
2. Keep user-facing strings in Danish; code/comments may be English.
3. Run `npm run check` and `npm test` with FFmpeg/libx264/libx265 available.
4. For encoding changes, add a focused test using small generated fixtures. Never commit copyrighted film samples, personal media, `.env` or SQLite databases.
5. Update README/CHANGELOG for user-visible behavior.
6. Open a pull request explaining the problem, resulting behavior and test evidence.

Preserve read-only input handling, optional subtitle tracks, unique output revisions and the rule that originals are never deleted or overwritten. Database schema changes need an explicit migration; do not replace a user's existing database. Test on actual hardware before claiming support for a new hardware encoder or HDR format.

CI builds and starts the Docker container. GHCR publication runs only after CI succeeds on `main` or version tags. See `docs/PUBLISHING.md`.
