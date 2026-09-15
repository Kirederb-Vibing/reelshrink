import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const SESSION = 'reelshrink_session', CHALLENGE = 'reelshrink_challenge';
const DAY = 86400000, CHALLENGE_TTL = 300000;
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }
function cookie(req, name) {
  const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
function setCookie(res, name, value, secure, maxAge) {
  const previous = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : [previous]),
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${maxAge === undefined ? '' : '; Max-Age=' + maxAge}`]);
}

// Keep the existing same-host proxy contract; never trust forwarded host headers.
export function requestOrigin(req, required = false) {
  if (!req.headers.origin) {
    if (required) fail('Origin mangler. Åbn ReelShrink i browseren og prøv igen.', 403);
    return null;
  }
  let origin;
  try { origin = new URL(req.headers.origin); } catch { fail('Ugyldig origin.', 403); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== req.headers.origin || origin.host !== req.headers.host)
    fail('Forespørgsler fra andre websites er ikke tilladt. Proxyen skal bevare Host-headeren.', 403);
  return origin;
}
export function checkWrite(req) {
  if (['GET', 'HEAD'].includes(req.method)) return;
  if (req.headers['x-reelshrink'] !== '1') fail('Sikkerhedsheader mangler.', 403);
  requestOrigin(req);
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Forespørgsler fra andre websites er ikke tilladt.', 403);
}

export class Auth {
  constructor(c, store, {now = Date.now} = {}) {
    this.c = c; this.store = store; this.now = now;
    this.challenges = new Map(); this.attempts = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_account (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, fingerprint TEXT NOT NULL, user_handle TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, credential_id TEXT, rp_id TEXT);
      CREATE TABLE IF NOT EXISTS auth_passkeys (id TEXT NOT NULL, rp_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, label TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER, PRIMARY KEY(rp_id,id));
    `);
    const old = store.get('SELECT * FROM auth_account WHERE id=1');
    const salt = old?.salt || random();
    // A slow, salted fingerprint detects changed env credentials without storing them.
    const fingerprint = scryptSync(JSON.stringify([c.username, c.password]), salt, 32).toString('hex');
    if (!old || !equal(old.fingerprint, fingerprint)) {
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.exec('DELETE FROM auth_sessions; DELETE FROM auth_passkeys;');
        store.run('INSERT OR REPLACE INTO auth_account VALUES (1,?,?,?)', salt, fingerprint, random());
        store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    }
    this.userHandle = store.get('SELECT user_handle FROM auth_account WHERE id=1').user_handle;
    store.run('DELETE FROM auth_sessions WHERE expires<=?', this.now());
  }

  session(req) {
    const token = cookie(req, SESSION);
    if (!this.c.username || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.store.get('SELECT * FROM auth_sessions WHERE token_hash=? AND host=? AND expires>?', digest(token), req.headers.host || '', this.now()) || null;
  }
  authenticated(req) {
    if (!this.c.username || this.session(req)) return true;
    // Explicit Basic auth remains available to API clients. Browser navigation uses the form.
    if (req.headers['sec-fetch-dest'] !== undefined) return false;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) return false;
    const token = Buffer.from(auth.slice(6), 'base64').toString();
    this.limit(req, 'basic', 10);
    const valid = equal(token, this.c.username + ':' + this.c.password);
    if (valid) this.attempts.delete(`basic:${req.socket.remoteAddress}`);
    return valid;
  }
  limit(req, bucket = 'requests', maximum = 60) {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const key = `${bucket}:${req.socket.remoteAddress}`;
    const value = this.attempts.get(key) || {count: 0, until: now + 60000};
    if (value.count >= maximum || (!this.attempts.has(key) && this.attempts.size >= 1024))
      fail('For mange loginforsøg. Vent et minut og prøv igen.', 429);
    value.count++; this.attempts.set(key, value);
  }
  password(req, password, username = this.c.username) {
    this.limit(req, 'password', 10);
    if (typeof password !== 'string' || typeof username !== 'string' || !equal(JSON.stringify([username, password]), JSON.stringify([this.c.username, this.c.password])))
      fail('Forkert brugernavn eller adgangskode.', 401);
  }
  issue(req, res, remember, credential = null) {
    const origin = requestOrigin(req, true), now = this.now();
    this.store.run('DELETE FROM auth_sessions WHERE token_hash=? OR expires<=?', digest(cookie(req, SESSION)), now);
    // Bound persistent storage even when many successful logins are made.
    this.store.run('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions ORDER BY created DESC LIMIT -1 OFFSET 63)');
    const token = random(), lifetime = remember ? 30 * DAY : DAY / 2;
    this.store.run('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?)', digest(token), origin.host, now + lifetime, now, credential?.id || null, credential?.rp_id || null);
    setCookie(res, SESSION, token, origin.protocol === 'https:', remember ? lifetime / 1000 : undefined);
  }
  passkeyOrigin(req) {
    const origin = requestOrigin(req, true);
    if ((origin.protocol !== 'https:' && origin.hostname !== 'localhost') || isIP(origin.hostname.replace(/^\[|\]$/g, '')))
      fail('Passkeys kræver HTTPS på et domænenavn (eller localhost). Brug adgangskoden på en lokal IP-adresse.');
    return origin;
  }
  challenge(req, res, data) {
    const now = this.now();
    for (const [id, value] of this.challenges) if (value.expires <= now) this.challenges.delete(id);
    this.challenges.delete(digest(cookie(req, CHALLENGE)));
    if (this.challenges.size >= 256) fail('For mange igangværende loginforsøg. Prøv igen om lidt.', 429);
    const token = random();
    this.challenges.set(digest(token), {...data, expires: now + CHALLENGE_TTL});
    setCookie(res, CHALLENGE, token, data.origin.startsWith('https:'), CHALLENGE_TTL / 1000);
  }
  takeChallenge(req, res, purpose) {
    const origin = this.passkeyOrigin(req), id = digest(cookie(req, CHALLENGE));
    const value = this.challenges.get(id); this.challenges.delete(id);
    setCookie(res, CHALLENGE, '', origin.protocol === 'https:', 0);
    if (!value || value.expires <= this.now() || value.purpose !== purpose || value.origin !== origin.origin ||
        (purpose === 'register' && value.session !== this.session(req)?.token_hash))
      fail('Loginforsøget er udløbet eller allerede brugt. Prøv igen.');
    return value;
  }

  async handle(req, res, p, method, body, json) {
    const session = this.session(req);
    if (p === '/api/auth/session' && method === 'GET') {
      json(res, 200, {enabled: Boolean(this.c.username), authenticated: Boolean(session), username: session ? this.c.username : undefined}); return;
    }
    checkWrite(req);
    if (!this.c.username) fail('Login er ikke aktiveret. Angiv AUTH_USERNAME og AUTH_PASSWORD.', 409);
    if (p === '/api/auth/passkeys' && method === 'GET') {
      if (!session) fail('Log ind for at fortsætte.', 401);
      json(res, 200, this.store.all('SELECT id,rp_id,label,created,last_used FROM auth_passkeys ORDER BY created')); return;
    }
    if (method !== 'POST') fail('Siden findes ikke.', 404);
    const origin = requestOrigin(req, true);
    this.limit(req);
    const data = await body(req);
    if (p === '/api/auth/login') {
      if (typeof data.username !== 'string') fail('Forkert brugernavn eller adgangskode.', 401);
      this.password(req, data.password, data.username);
      this.issue(req, res, data.remember === true); json(res, 200, {ok: true}); return;
    }
    if (p === '/api/auth/logout') {
      this.store.run('DELETE FROM auth_sessions WHERE token_hash=?', digest(cookie(req, SESSION)));
      this.challenges.delete(digest(cookie(req, CHALLENGE)));
      setCookie(res, SESSION, '', origin.protocol === 'https:', 0);
      setCookie(res, CHALLENGE, '', origin.protocol === 'https:', 0);
      json(res, 200, {ok: true}); return;
    }
    if (p === '/api/auth/passkeys/register/options') {
      if (!session) fail('Log ind før du tilføjer en passkey.', 401);
      this.password(req, data.password);
      const rp = this.passkeyOrigin(req), label = typeof data.label === 'string' ? data.label.trim() : '';
      if (!label || label.length > 80) fail('Giv nøglen et navn på 1–80 tegn.');
      if (this.store.get('SELECT COUNT(*) AS n FROM auth_passkeys').n >= 20) fail('Du kan gemme højst 20 passkeys. Fjern en gammel nøgle først.');
      const existing = this.store.all('SELECT id,transports FROM auth_passkeys WHERE rp_id=?', rp.hostname);
      const options = await generateRegistrationOptions({
        rpName: 'ReelShrink', rpID: rp.hostname, userName: this.c.username,
        userID: new Uint8Array(Buffer.from(this.userHandle, 'base64url')), attestationType: 'none',
        authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
        supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: existing.map(k => ({id: k.id, transports: JSON.parse(k.transports)})),
      });
      this.challenge(req, res, {purpose: 'register', origin: rp.origin, rpID: rp.hostname, challenge: options.challenge, label, session: session.token_hash});
      json(res, 200, options); return;
    }
    if (p === '/api/auth/passkeys/register/verify') {
      if (!session) fail('Log ind før du tilføjer en passkey.', 401);
      const challenge = this.takeChallenge(req, res, 'register');
      let result;
      try {
        result = await verifyRegistrationResponse({response: data.response, expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin, expectedRPID: challenge.rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257]});
      } catch { fail('Nøglen kunne ikke bekræftes. Prøv at oprette den igen.'); }
      if (!result.verified || !this.session(req)) fail('Nøglen kunne ikke bekræftes. Log ind og prøv igen.');
      if (this.store.get('SELECT COUNT(*) AS n FROM auth_passkeys').n >= 20) fail('Der er allerede gemt 20 passkeys.');
      const key = result.registrationInfo.credential;
      const inserted = this.store.run('INSERT OR IGNORE INTO auth_passkeys VALUES (?,?,?,?,?,?,?,NULL)',
        key.id, challenge.rpID, key.publicKey, key.counter, JSON.stringify(key.transports || []), challenge.label, this.now());
      if (!inserted.changes) fail('Nøglen er allerede tilføjet.');
      json(res, 201, {ok: true}); return;
    }
    if (p === '/api/auth/passkeys/authenticate/options') {
      const rp = this.passkeyOrigin(req);
      const options = await generateAuthenticationOptions({rpID: rp.hostname, userVerification: 'required'});
      this.challenge(req, res, {purpose: 'login', origin: rp.origin, rpID: rp.hostname, challenge: options.challenge, remember: data.remember === true});
      json(res, 200, options); return;
    }
    if (p === '/api/auth/passkeys/authenticate/verify') {
      const challenge = this.takeChallenge(req, res, 'login'), response = data.response;
      const key = typeof response?.id === 'string' ? this.store.get('SELECT * FROM auth_passkeys WHERE id=? AND rp_id=?', response.id, challenge.rpID) : null;
      if (!key || response.response?.userHandle !== this.userHandle) fail('Nøglen er ikke registreret til denne ReelShrink.', 401);
      let result;
      try {
        result = await verifyAuthenticationResponse({response, expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin, expectedRPID: challenge.rpID, requireUserVerification: true,
          credential: {id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports)}});
      } catch { fail('Login med nøglen kunne ikke bekræftes. Prøv igen eller brug adgangskoden.', 401); }
      if (!result.verified) fail('Login med nøglen kunne ikke bekræftes.', 401);
      // A concurrently deleted/reused credential must not create a session.
      const updated = this.store.run('UPDATE auth_passkeys SET counter=?,last_used=? WHERE id=? AND rp_id=? AND counter=?',
        result.authenticationInfo.newCounter, this.now(), key.id, key.rp_id, key.counter);
      if (!updated.changes) fail('Nøglen blev ændret. Prøv at logge ind igen.', 401);
      this.issue(req, res, challenge.remember, key); json(res, 200, {ok: true}); return;
    }
    if (p === '/api/auth/passkeys/remove') {
      if (!session) fail('Log ind for at fjerne en passkey.', 401);
      this.password(req, data.password);
      if (typeof data.id !== 'string' || typeof data.rpID !== 'string') fail('Vælg en nøgle.');
      this.store.run('DELETE FROM auth_passkeys WHERE id=? AND rp_id=?', data.id, data.rpID);
      this.store.run('DELETE FROM auth_sessions WHERE credential_id=? AND rp_id=?', data.id, data.rpID);
      json(res, 200, {ok: true}); return;
    }
    fail('Siden findes ikke.', 404);
  }
}
