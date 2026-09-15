import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import {config} from '../app/config.mjs';
import {createService} from '../app/server.mjs';
import {Auth} from '../app/auth.mjs';

const origin = 'https://reelshrink.example.test', host = new URL(origin).host;
const password = 'a-long-password-only-for-tests';
const hash = data => createHash('sha256').update(data).digest();
const b64 = data => Buffer.from(data).toString('base64url');
const encode = data => Buffer.from(isoCBOR.encode(data));

async function fixture(t, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reelshrink-auth-'));
  await fs.mkdir(path.join(root, 'media'));
  const c = config({CONFIG_DIR: path.join(root, 'config'), MEDIA_ROOTS: path.join(root, 'media'), OUTPUT_ROOT: path.join(root, 'output'),
    AUTH_USERNAME: enabled ? 'tester' : '', AUTH_PASSWORD: enabled ? password : ''});
  const service = await createService(c, {background: false});
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await service.close(); await fs.rm(root, {recursive: true, force: true});});
  let clock = Date.now(); service.auth.now = () => clock;
  function client() {
    const cookies = new Map();
    async function request(p, data, overrides = {}) {
      const method = data === undefined ? 'GET' : 'POST';
      const headers = {host, cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join(';'),
        ...(data === undefined ? {} : {'content-type': 'application/json', 'x-reelshrink': '1', origin}), ...overrides};
      for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
      const response = await new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port: service.server.address().port, path: p, method, headers}, res => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString()}));
        });
        req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
      });
      for (const value of response.headers['set-cookie'] || []) {
        const [name, token] = value.split(';')[0].split('=');
        if (token) cookies.set(name, token); else cookies.delete(name);
      }
      if (response.headers['content-type']?.includes('application/json')) response.data = JSON.parse(response.text);
      return response;
    }
    return {cookies, request, login: (remember = false) => request('/api/auth/login', {username: 'tester', password, remember})};
  }
  return {...service, c, client, advance: ms => {clock += ms;}};
}
function expect(response, status = 200) {assert.equal(response.status, status, response.text); return response.data;}

// A real software authenticator: ES256 public key in a CBOR attestation, then signed assertions.
// Verification is always performed by the production WebAuthn library, without verifier stubs.
function authenticator() {
  const {publicKey, privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'}), rawId = randomBytes(32), id = b64(rawId);
  const cose = encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  function data(rpID, flags, counter) {const count = Buffer.alloc(4); count.writeUInt32BE(counter); return Buffer.concat([hash(rpID), Buffer.from([flags]), count]);}
  return {
    id, userHandle: null,
    registration(options, changes = {}) {
      this.userHandle = options.user.id;
      const client = Buffer.from(JSON.stringify({type: 'webauthn.create', origin, challenge: options.challenge, ...changes.client}));
      const length = Buffer.alloc(2); length.writeUInt16BE(rawId.length);
      const authData = Buffer.concat([data(changes.rpID || options.rp.id, changes.flags ?? 0x45, 0), Buffer.alloc(16), length, rawId, cose]);
      return {id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: {clientDataJSON: b64(client), attestationObject: b64(encode(new Map([['fmt', 'none'], ['authData', authData], ['attStmt', new Map()]]))), transports: ['internal']}};
    },
    assertion(options, counter = 1, changes = {}) {
      const client = Buffer.from(JSON.stringify({type: 'webauthn.get', origin, challenge: options.challenge, ...changes.client}));
      const authData = data(changes.rpID || options.rpId, changes.flags ?? 5, counter);
      return {id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: b64(client), authenticatorData: b64(authData), userHandle: changes.userHandle ?? this.userHandle,
        signature: b64(sign('sha256', Buffer.concat([authData, hash(client)]), changes.privateKey || privateKey)),
      }};
    },
  };
}
async function register(client, key = authenticator()) {
  const options = expect(await client.request('/api/auth/passkeys/register/options', {label: 'Bitwarden test', password}));
  expect(await client.request('/api/auth/passkeys/register/verify', {response: key.registration(options)}), 201);
  return key;
}
async function options(client) {return expect(await client.request('/api/auth/passkeys/authenticate/options', {}));}

test('login redirects pages without a Basic popup; forms/assets, API auth, logout and CSRF', async t => {
  const e = await fixture(t), a = e.client();
  const redirect = await a.request('/archive?filter=local'); expect(redirect, 302);
  assert.equal(redirect.headers.location, '/login?next=%2Farchive%3Ffilter%3Dlocal');
  assert.equal(redirect.headers['www-authenticate'], undefined);
  for (const p of ['/login', '/login.js', '/auth-ui.js', '/webauthn.js', '/style.css', '/favicon.svg', '/api/health']) expect(await a.request(p));
  const html = (await a.request('/login')).text;
  assert.match(html, /autocomplete="username"/); assert.match(html, /autocomplete="current-password"/);
  expect(await a.request('/api/status'), 401);
  expect(await a.request('/api/jobs/remove', {}), 401);
  expect(await a.request('/api/auth/login', {username: 'tester', password}, {'x-reelshrink': null}), 403);
  expect(await a.request('/api/auth/login', {username: 'tester', password}, {origin: 'https://evil.example.test'}), 403);
  expect(await a.request('/api/auth/login', {username: 'tester', password}, {origin: null}), 403);
  expect(await a.request('/api/auth/login', {username: 'tester', password: 'wrong'}), 401);
  expect(await a.login(true));
  const token = a.cookies.get('reelshrink_session');
  const session = expect(await a.request('/api/auth/session')); assert.equal(session.username, 'tester');
  expect(await a.request('/account')); expect(await a.request('/api/status'));
  expect(await a.request('/api/control/stop', {}), 202);
  expect(await a.request('/api/auth/passkeys'));
  expect(await a.request('/api/auth/logout', {}));
  expect(await a.request('/api/status'), 401);
  expect(await a.request('/api/status', undefined, {cookie: 'reelshrink_session=' + token}), 401);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM auth_sessions').n, 0);
  expect(await a.login()); // Global stop never blocks login/logout.
  const basic = 'Basic ' + Buffer.from('tester:' + password).toString('base64');
  expect(await e.client().request('/api/status', undefined, {authorization: basic}));
  expect(await e.client().request('/api/status', undefined, {authorization: basic, 'sec-fetch-dest': 'empty'}), 401);
});

test('sessions use protected cookies, hash tokens, rotate, expire and invalidate on credential changes', async t => {
  const e = await fixture(t), a = e.client();
  const response = await a.login(true); expect(response);
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Secure; Max-Age=2592000/);
  const old = a.cookies.get('reelshrink_session'), saved = e.store.get('SELECT * FROM auth_sessions');
  assert.notEqual(saved.token_hash, old); assert.equal(saved.token_hash, hash(old).toString('hex'));
  assert.equal(new Auth(e.c, e.store).session({headers: {cookie: 'reelshrink_session=' + old, host}})?.token_hash, saved.token_hash);
  expect(await a.login());
  expect(await a.request('/api/status', undefined, {cookie: 'reelshrink_session=' + old}), 401);
  expect(await a.request('/api/status', undefined, {host: 'other.example.test'}), 401);
  expect(await a.request('/api/status', undefined, {cookie: [...a.cookies].map(([k,v]) => `${k}=${v}; ${k}=${v}`).join(';')}), 401);
  e.advance(12 * 3600000 + 1); expect(await a.request('/api/status'), 401);
  expect(await a.login());
  await register(a);
  new Auth({...e.c, password: 'changed-env-password'}, e.store);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM auth_sessions').n, 0);
  assert.equal(e.store.get('SELECT COUNT(*) AS n FROM auth_passkeys').n, 0);
});

test('password login remains available on LAN HTTP and auth stays optional', async t => {
  const e = await fixture(t), a = e.client();
  const response = await a.request('/api/auth/login', {username: 'tester', password}, {host: '192.0.2.4:8080', origin: 'http://192.0.2.4:8080'});
  expect(response); assert.doesNotMatch(response.headers['set-cookie'][0], /Secure|Max-Age/);
  expect(await a.request('/api/auth/passkeys/authenticate/options', {}, {host: '192.0.2.4:8080', origin: 'http://192.0.2.4:8080'}), 400);
  const open = await fixture(t, false), b = open.client();
  expect(await b.request('/')); expect(await b.request('/api/status'));
  assert.deepEqual(expect(await b.request('/api/auth/session')), {enabled: false, authenticated: false});
  expect(await b.request('/api/auth/login', {username: '', password: ''}), 409);
});

test('passkeys require session and password to register; signed login works and deletion revokes sessions', async t => {
  const e = await fixture(t), a = e.client(), b = e.client();
  expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password}), 401);
  expect(await a.login());
  expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password: 'wrong'}), 401);
  const key = await register(a);
  const list = expect(await a.request('/api/auth/passkeys')); assert.equal(list[0].label, 'Bitwarden test'); assert.equal(list[0].rp_id, host);
  assert.equal(list[0].public_key, undefined);
  const response = key.assertion(await options(b));
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response}));
  expect(await b.request('/api/status'));
  assert.equal(e.store.get('SELECT counter FROM auth_passkeys').counter, 1);
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response}), 400);
  expect(await a.request('/api/auth/passkeys/remove', {id: key.id, rpID: host, password: 'wrong'}), 401);
  expect(await a.request('/api/auth/passkeys/remove', {id: key.id, rpID: host, password}));
  expect(await b.request('/api/status'), 401);
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(await options(b), 2)}), 401);
});

test('registration challenges bind browser, session, origin and expiry and cannot be replayed', async t => {
  const e = await fixture(t), a = e.client(), b = e.client(), key = authenticator();
  expect(await a.login()); expect(await b.login());
  let opts = expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password}));
  let response = key.registration(opts);
  expect(await b.request('/api/auth/passkeys/register/verify', {response}), 400);
  expect(await a.request('/api/auth/passkeys/register/verify', {response}), 201);
  expect(await a.request('/api/auth/passkeys/register/verify', {response}), 400);
  for (const changes of [{client: {origin: 'https://evil.example.test'}}, {rpID: 'evil.example.test'}, {flags: 0x41}, {client: {challenge: 'fake'}}]) {
    opts = expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password}));
    expect(await a.request('/api/auth/passkeys/register/verify', {response: authenticator().registration(opts, changes)}), 400);
  }
  opts = expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password}));
  e.advance(300001);
  expect(await a.request('/api/auth/passkeys/register/verify', {response: authenticator().registration(opts)}), 400);
  opts = expect(await a.request('/api/auth/passkeys/register/options', {label: 'Test', password}));
  const stolen = a.cookies.get('reelshrink_challenge');
  expect(await a.request('/api/auth/logout', {})); expect(await a.login());
  a.cookies.set('reelshrink_challenge', stolen);
  expect(await a.request('/api/auth/passkeys/register/verify', {response: authenticator().registration(opts)}), 400);
});

test('assertion rejects bad signature, wrong origin/RP/user, missing verification, expired and reused counters', async t => {
  const e = await fixture(t), a = e.client(), b = e.client();
  expect(await a.login()); const key = await register(a);
  const otherPrivateKey = generateKeyPairSync('ec', {namedCurve: 'prime256v1'}).privateKey;
  for (const change of [{privateKey: otherPrivateKey}, {client: {origin: 'https://evil.example.test'}}, {rpID: 'evil.example.test'}, {userHandle: 'wrong'}, {flags: 1}, {client: {challenge: 'fake'}}]) {
    expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(await options(b), 1, change)}), 401);
    assert.equal(expect(await b.request('/api/auth/session')).authenticated, false);
  }
  const expired = key.assertion(await options(b)); e.advance(300001);
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: expired}), 400);
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(await options(b))}));
  expect(await b.request('/api/auth/logout', {}));
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(await options(b))}), 401);
  expect(await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(await options(b), 2)}));
});

test('password attempts are rate limited; forged forwarding headers cannot bypass limits', async t => {
  const e = await fixture(t), a = e.client();
  for (let i = 0; i < 10; i++) expect(await a.request('/api/auth/login', {username: 'tester', password: 'wrong'}, {'x-forwarded-for': '192.0.2.' + i}), 401);
  expect(await a.login(), 429);
  e.advance(60001); expect(await a.login());
});

test('synced passkeys can keep a zero counter and remember-me applies to passkey login', async t => {
  const e = await fixture(t), a = e.client(), b = e.client();
  expect(await a.login()); const key = await register(a);
  for (let i = 0; i < 2; i++) {
    const opts = expect(await b.request('/api/auth/passkeys/authenticate/options', {remember: true}));
    const result = await b.request('/api/auth/passkeys/authenticate/verify', {response: key.assertion(opts, 0)});
    expect(result); assert.match(result.headers['set-cookie'].join(';'), /Max-Age=2592000/);
    expect(await b.request('/api/auth/logout', {}));
  }
  assert.equal(e.store.get('SELECT counter FROM auth_passkeys').counter, 0);
});
