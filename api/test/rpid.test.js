/* Which relying-party id and origin a passkey ceremony uses.
 *
 * Getting this wrong does not degrade gracefully: the browser refuses the ceremony with
 * "rp.id cannot be used with current origin" and nobody can sign in at all. It is also easy to
 * get wrong on a host that mints a new domain per deployment and per preview branch, where no
 * single configured value is correct for every URL the app is reachable at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-rpid-'));
fs.writeFileSync(path.join(DIR, 'secret'), 'e'.repeat(64));
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [], teams: [] }));
process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';
delete process.env.RP_ID;
delete process.env.ORIGIN;               // unconfigured: derive from the request
const api = await import('../server.js');

/** Run the registration ceremony's first step and report what the browser would be told. */
async function optionsFor(headers) {
  let body = null;
  const res = { writeHead() {}, end(b) { body = JSON.parse(b); }, headersSent: false };
  await api.routes['POST /api/register/options'](
    { method: 'POST', url: '/api/register/options', headers, body: { name: 'Ann' } }, res);
  return body.options;
}
/** The Set-Cookie a sign-in would hand back. */
async function cookieFor(headers) {
  let cookie = null;
  const res = { writeHead(c, h) { cookie = h?.['Set-Cookie']; }, end() {}, headersSent: false };
  await api.routes['POST /api/logout']({ method: 'POST', url: '/api/logout', headers, body: {} }, res);
  return cookie;
}

test('unconfigured, the id is the host the request actually arrived on', async () => {
  const o = await optionsFor({ host: 'opengym-eight-plum.vercel.app', 'x-forwarded-proto': 'https' });
  assert.equal(o.rp.id, 'opengym-eight-plum.vercel.app');
});

test("a proxy's forwarded host wins over the internal one", async () => {
  // On Vercel the function's own `host` is not the domain in the address bar.
  const o = await optionsFor({
    host: 'internal-lambda.vercel.internal',
    'x-forwarded-host': 'gym.example.com',
    'x-forwarded-proto': 'https'
  });
  assert.equal(o.rp.id, 'gym.example.com');
});

test('a forwarded chain uses the client-facing entry, not the last hop', async () => {
  const o = await optionsFor({ 'x-forwarded-host': 'gym.example.com, inner.vercel.app', 'x-forwarded-proto': 'https, http' });
  assert.equal(o.rp.id, 'gym.example.com');
});

test('a port is part of the origin but never part of the id', async () => {
  // rp.id is a domain; "localhost:5199" as an id is refused by the browser.
  const o = await optionsFor({ host: 'localhost:5199' });
  assert.equal(o.rp.id, 'localhost');
  assert.equal((await cookieFor({ host: 'localhost:5199' })).includes('Secure'), false,
    'a Secure cookie over plain http://localhost is dropped, and sign-in silently fails');
});

test('every deployment URL works, which is the point', async () => {
  for (const host of [
    'opengym-eight-plum.vercel.app',
    'opengym-git-main-omwro.vercel.app',       // a branch preview
    'opengym-abc123-omwro.vercel.app',         // a one-off deployment URL
    'gym.omererdem.dev'                        // a custom domain added later
  ]) {
    const o = await optionsFor({ host, 'x-forwarded-proto': 'https' });
    assert.equal(o.rp.id, host, `${host} must identify as itself`);
  }
});

test('https requests get a Secure cookie', async () => {
  assert.ok((await cookieFor({ host: 'gym.example.com', 'x-forwarded-proto': 'https' })).includes('Secure'));
});

test('a request with no host at all falls back rather than throwing', async () => {
  const o = await optionsFor({});
  assert.equal(o.rp.id, 'localhost', 'the documented default');
});
