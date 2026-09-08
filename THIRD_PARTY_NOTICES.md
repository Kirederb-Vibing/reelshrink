# Third-party components

The MIT license in this repository covers ReelShrink's own application code. It does not relicense the software distributed in the base container image.

- **Node.js** is provided by the official `node:24-bookworm-slim` image. Node.js and its bundled dependencies have their own notices: https://github.com/nodejs/node/blob/main/LICENSE
- **FFmpeg, libx264 and libx265** are installed from Debian packages. Their applicable GPL/LGPL notices and dependency copyright files remain under `/usr/share/doc` in the image. ReelShrink invokes FFmpeg/FFprobe as separate executables. FFmpeg licensing information: https://ffmpeg.org/legal.html
- **Debian packages** retain their individual licenses. Exact binary package versions can be listed using `dpkg-query -W` inside the image; the GHCR workflow also generates an SBOM. Corresponding Debian source packages and packaging are available through Debian's source repositories and https://sources.debian.org/ . If redistributing binaries, retain applicable notices and satisfy the corresponding source-distribution obligations for those exact packages.

There are no third-party npm runtime packages or remote frontend CDNs in this application.
