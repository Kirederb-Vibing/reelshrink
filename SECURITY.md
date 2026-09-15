# Security

## Deployment boundary

ReelShrink is a single-user/trusted-household service. It is not a multi-tenant transcoding platform. Mount only the input directories it needs. The standard and proxy Compose files mount media read-only; the opt-in `compose.return.yaml` mounts media read/write to return encoded files and explicitly delete selected OLD backups. Configuration and output require write access. Do not mount the Docker socket or run privileged.

Return-to-library has no automatic OLD deletion. File mutations use checksums, a persistent SQLite journal, exclusive hardlinks and file/directory fsync. The destination filesystem must support those operations. Only one ReelShrink instance may manage these paths, and external applications must not mutate the same files during replacement. Path checks and file fingerprints are repeated but do not provide an OS-level lock against unrelated writers or hostile concurrent filesystem changes. See [return and recovery documentation](docs/RETURNING.md).

Authentication is enabled by setting both `AUTH_USERNAME` and `AUTH_PASSWORD` (or `AUTH_PASSWORD_FILE`). The browser uses a login form and opaque, server-side sessions. Without those settings the GUI remains open; use a trusted LAN or an authenticated reverse proxy. Use HTTPS for external access. Do not place credentials in this repository. Login assets and `/api/auth/session` are public; the session endpoint discloses the username only after session authentication. The public health endpoint exposes status and application version.

Session cookies are host-only, HttpOnly, SameSite=Strict and Secure when the login's validated browser Origin uses HTTPS, including behind a TLS-terminating proxy. The proxy must preserve the original Host header. Forwarded host/IP headers are not trusted. Sessions expire after 12 hours, or 30 days with Remember me, and only token hashes are stored in SQLite. Login rotates the current token; logout revokes it. Credential changes are detected at startup using a salted scrypt fingerprint and revoke all sessions and passkeys. Explicit Basic authentication remains supported for non-browser clients; it does not establish a browser session.

Passkeys use SimpleWebAuthn verification with required user verification, exact origin/RP checks, discoverable credentials, signature verification and signature counters. Registration and removal require a session and password reauthentication. Challenges are random, single-use, bound to the initiating browser and (for registration) the session, and expire after five minutes. Passkey registration requires HTTPS on a domain name, or localhost in development. Credential/session storage and outstanding challenge counts are bounded; authentication attempts are rate limited per direct peer IP. A reverse proxy shares that limit between its users. Restarting interrupts pending passkey ceremonies, but valid sessions and registered keys survive. Removing a key revokes sessions created with that key. Back up and restrict access to `/config`.

API writes require a custom header, JSON for POST/PUT, and reject cross-origin browser requests when an Origin header is supplied. The application does not enable CORS. Paths are restricted to configured media roots; source symlinks are excluded. FFmpeg runs without a shell and its input protocols are restricted to file/pipe. Content Security Policy prevents external scripts and embedding.

FFmpeg parses complex media formats. Keep the container and host updated. Only process media you trust to make available to this service. Run exactly one service instance per configuration/output directory.

## Reporting

If the GitHub repository enables private vulnerability reporting, use its **Security → Report a vulnerability** feature. Otherwise open an issue asking the maintainer for a private reporting channel, without exploit details, credentials or private file paths. Remove sensitive paths from FFmpeg logs before posting them publicly.

Version 0.1 is an initial release; security fixes should be applied by updating to the latest maintained version.
