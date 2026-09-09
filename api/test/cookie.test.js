/* The session cookie's Secure flag.
 *
 * All that is left of the old relying-party machinery. It matters because getting it wrong
 * fails silently in the worst way: a Secure cookie sent over plain http is dropped by the
 * browser, so sign-in appears to succeed and the next request is anonymous again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cookie-'));
fs.writeFileSync(path.join(DIR, 'secret'), 'b'.repeat(64));
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({ users: [{ id: 'ann', name: 'Ann' }], subs: [], team: null }));
process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';
process.env.APP_PASSWORD = 'shoarmasate';
delete process.env.ORIGIN;
const api = await import('../server.js');

async function cookieFor(headers) {
  let cookie = null;
  const res = { headersSent: false, writeHead(c, h) { cookie = h?.['Set-Cookie']; }, end() {} };
  await api.routes['POST /api/login'](
    { method: 'POST', url: '/api/login', headers, body: { id: 'ann', password: 'shoarmasate' }, socket: {} }, res);
  return cookie;
}

test('a proxied https request gets a Secure cookie', async () => {
  assert.match(await cookieFor({ 'x-forwarded-proto': 'https' }), /Secure/);
});

test('plain http does not, or the browser would silently drop it', async () => {
  assert.doesNotMatch(await cookieFor({ 'x-forwarded-proto': 'http' }), /Secure/);
});

test('a forwarded chain is read from the client-facing entry', async () => {
  assert.match(await cookieFor({ 'x-forwarded-proto': 'https, http' }), /Secure/);
});

test('with no proxy header it falls back to the configured origin', async () => {
  assert.doesNotMatch(await cookieFor({}), /Secure/);   // ORIGIN defaults to http://localhost:8080
});

test('the cookie is HttpOnly and same-site regardless', async () => {
  const c = await cookieFor({ 'x-forwarded-proto': 'https' });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
});
