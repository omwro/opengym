/* The other half of rpid.test.js: when RP_ID and ORIGIN are set, they win.
 * Separate file because both are read once, at import — node:test gives each file its own
 * process, which is the only way to cover both paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-rpid-cfg-'));
fs.writeFileSync(path.join(DIR, 'secret'), 'f'.repeat(64));
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [], teams: [] }));
process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';
process.env.RP_ID = 'gym.example.com';
process.env.ORIGIN = 'https://gym.example.com';
const api = await import('../server.js');

async function optionsFor(headers) {
  let body = null;
  const res = { writeHead() {}, end(b) { body = JSON.parse(b); }, headersSent: false };
  await api.routes['POST /api/register/options'](
    { method: 'POST', url: '/api/register/options', headers, body: { name: 'Ann' } }, res);
  return body.options;
}

test('a configured id is used regardless of what the request claims', async () => {
  assert.equal((await optionsFor({ host: 'gym.example.com' })).rp.id, 'gym.example.com');
  // Pinning it is the point: behind a domain you control, a spoofed Host must not change the
  // relying party the server commits to.
  assert.equal((await optionsFor({ host: 'attacker.example', 'x-forwarded-host': 'attacker.example' })).rp.id,
    'gym.example.com', 'configuration wins over the request, always');
});

test('the cookie follows the configured origin', async () => {
  let cookie = null;
  const res = { writeHead(c, h) { cookie = h?.['Set-Cookie']; }, end() {}, headersSent: false };
  await api.routes['POST /api/logout']({ method: 'POST', url: '/api/logout', headers: { host: 'gym.example.com' }, body: {} }, res);
  assert.ok(cookie.includes('Secure'), 'an https origin means a Secure cookie');
});
