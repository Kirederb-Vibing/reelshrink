import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {config} from '../../app/config.mjs';
import {createService} from '../../app/server.mjs';

test('browser password login, passkey registration/login/removal, logout and mobile layout', {timeout: 90000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reelshrink-browser-'));
  await fs.mkdir(path.join(root, 'media'));
  const service = await createService(config({CONFIG_DIR: path.join(root, 'config'), MEDIA_ROOTS: path.join(root, 'media'),
    OUTPUT_ROOT: path.join(root, 'output'), AUTH_USERNAME: 'browser-user', AUTH_PASSWORD: 'browser-test-password'}), {background: false});
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://localhost:' + service.server.address().port;
  let browser;
  t.after(async () => {await browser?.close(); await service.close(); await fs.rm(root, {recursive: true, force: true});});
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const {authenticatorId} = await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  }});

  await page.goto(base + '/archive'); await page.waitForURL('**/login?next=*');
  await page.locator('#username').fill('browser-user'); await page.locator('#password').fill('wrong');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => document.querySelector('#login-message').textContent.includes('Forkert'));
  await page.locator('#password').fill('browser-test-password'); await page.locator('#remember').check();
  await page.locator('#login-submit').click(); await page.waitForURL(base + '/archive');
  const cookie = (await context.cookies()).find(c => c.name === 'reelshrink_session');
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict'); assert.ok(cookie.expires > Date.now() / 1000 + 29 * 86400);
  await page.getByRole('link', {name: 'Konto', exact: true}).click();
  await page.locator('#key-name').fill('Browser test key'); await page.locator('#key-password').fill('browser-test-password');
  await page.locator('#add-key').click();
  await page.waitForFunction(() => document.querySelector('#passkey-list').textContent.includes('Browser test key'));
  assert.match(await page.locator('#key-message').textContent(), /er tilføjet/);
  assert.equal((await cdp.send('WebAuthn.getCredentials', {authenticatorId})).credentials.length, 1);
  await page.getByRole('button', {name: 'Log ud', exact: true}).click(); await page.waitForURL(base + '/login');
  assert.equal((await context.request.get(base + '/api/status')).status(), 401);

  // Small screens must remain usable without sideways scrolling.
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#passkey-login').click(); await page.waitForURL(base + '/');
  await page.getByRole('link', {name: 'Konto', exact: true}).click();
  await page.getByRole('button', {name: 'Fjern Browser test key'}).click();
  await page.locator('#delete-password').fill('browser-test-password');
  await page.locator('#delete-key-form button[type=submit]').click();
  await page.waitForURL('**/login?next=*'); // Removing the current key revokes its session.
  assert.equal(service.store.get('SELECT COUNT(*) AS n FROM auth_passkeys').n, 0);
  assert.deepEqual(errors, []);
});
