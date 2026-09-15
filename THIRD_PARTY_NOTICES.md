# Third-party components

The MIT license in this repository covers ReelShrink's own application code. It does not relicense the software distributed in the base container image.

- **Node.js** is provided by the official `node:24-bookworm-slim` image. Node.js and its bundled dependencies have their own notices: https://github.com/nodejs/node/blob/main/LICENSE
- **FFmpeg, libx264 and libx265** are installed from Debian packages. Their applicable GPL/LGPL notices and dependency copyright files remain under `/usr/share/doc` in the image. ReelShrink invokes FFmpeg/FFprobe as separate executables. FFmpeg licensing information: https://ffmpeg.org/legal.html
- **Debian packages** retain their individual licenses. Exact binary package versions can be listed using `dpkg-query -W` inside the image; the GHCR workflow also generates an SBOM. Corresponding Debian source packages and packaging are available through Debian's source repositories and https://sources.debian.org/ . If redistributing binaries, retain applicable notices and satisfy the corresponding source-distribution obligations for those exact packages.

- **SimpleWebAuthn** (`@simplewebauthn/server` and `@simplewebauthn/browser`, MIT) implements WebAuthn/passkeys. Its licenses and the licenses of its transitive npm dependencies are retained in `/app/node_modules`. Exact versions and integrity hashes are pinned in `package-lock.json`. Project: https://github.com/MasterKale/SimpleWebAuthn

Browser scripts are served by ReelShrink itself; no remote frontend CDN is used.
