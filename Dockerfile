FROM node:26-bookworm-slim

ARG VERSION=0.7.0
ARG REVISION=unknown
ARG SOURCE_URL
LABEL org.opencontainers.image.title="ReelShrink" \
      org.opencontainers.image.description="Video compression with folder watching and selectable subtitles" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /config /output /media /incoming \
    && chown -R node:node /app /config /output
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node app ./app
COPY LICENSE THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production PORT=8080 CONFIG_DIR=/config MEDIA_ROOTS=/media OUTPUT_ROOT=/output
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "app/healthcheck.mjs"]
CMD ["node", "app/server.mjs"]
