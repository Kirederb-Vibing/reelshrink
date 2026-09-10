# Security

## Deployment boundary

ReelShrink is a single-user/trusted-household service. It is not a multi-tenant transcoding platform. Mount only the input directories it needs. The standard and proxy Compose files mount media read-only; the opt-in `compose.return.yaml` mounts media read/write to return encoded files and explicitly delete selected OLD backups. Configuration and output require write access. Do not mount the Docker socket or run privileged.

Return-to-library has no automatic OLD deletion. File mutations use checksums, a persistent SQLite journal, exclusive hardlinks and file/directory fsync. The destination filesystem must support those operations. Only one ReelShrink instance may manage these paths, and external applications must not mutate the same files during replacement. Path checks and file fingerprints are repeated but do not provide an OS-level lock against unrelated writers or hostile concurrent filesystem changes. See [return and recovery documentation](docs/RETURNING.md).

The GUI has no login by default. Use a trusted LAN or an authenticated reverse proxy with HTTPS. Optional HTTP Basic credentials can be configured through environment variables or a password file. Do not place credentials in this repository. The unauthenticated health endpoint exposes only status and application version.

API writes require a custom header, JSON for POST/PUT, and reject cross-origin browser requests when an Origin header is supplied. The application does not enable CORS. Paths are restricted to configured media roots; source symlinks are excluded. FFmpeg runs without a shell and its input protocols are restricted to file/pipe. Content Security Policy prevents external scripts and embedding.

FFmpeg parses complex media formats. Keep the container and host updated. Only process media you trust to make available to this service. Run exactly one service instance per configuration/output directory.

## Reporting

If the GitHub repository enables private vulnerability reporting, use its **Security → Report a vulnerability** feature. Otherwise open an issue asking the maintainer for a private reporting channel, without exploit details, credentials or private file paths. Remove sensitive paths from FFmpeg logs before posting them publicly.

Version 0.1 is an initial release; security fixes should be applied by updating to the latest maintained version.
