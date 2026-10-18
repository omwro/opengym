/* The production bug: on Vercel the function is frozen as soon as it responds, so a rest timer
 * kept in a setTimeout never fired. The fix hands the wait to the platform via the request
 * context's waitUntil. This file plays the platform: it supplies that context and checks the
 * pending push is registered with it — and that without it, the server says so rather than
 * pretending it scheduled something. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-pushsl-'));
const SECRET = 'q'.repeat(64);
fs.writeFileSync(path.join(DIR, 'secret'), SECRET);
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({ users: [{ id: 'ann', name: 'Ann' }], subs: [], team: null }));
process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';

// What Vercel's runtime provides: a request context carrying waitUntil.
const waited = [];
let context = { waitUntil: p => waited.push(p) };
globalThis[Symbol.for('@vercel/request-context')] = { get: () => context };

const handler = (await import('../index.js')).default;
const cookie = (() => { const p = `ann:${Date.now() + 86400000}:0`; return 'gymsid=' + p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); })();
async function call(route, body) {
  const [method, p] = route.split(' ');
  const out = {};
  const res = { statusCode: 200, setHeader() {}, writeHead(c) { out.code = c; }, end(b) { out.body = b ? JSON.parse(b) : null; } };
  await handler({ method, url: '/api/index.js?__p=' + p.replace('/api/', ''), headers: { cookie }, body }, res);
  return out;
}

test('a rest timer is handed to the platform, so the function is kept alive for it', async () => {
  const r = await call('POST /api/push/rest-timer', { seconds: 1 });
  assert.equal(r.code, 200);
  assert.equal(r.body.delivery, 'platform', 'it must use waitUntil, not a bare setTimeout');
  assert.equal(waited.length, 1, 'one pending push registered with the platform');
  // The registered promise is the whole wait-then-send; it settles once the rest is over.
  const t0 = Date.now();
  await waited[0];
  assert.ok(Date.now() - t0 >= 900, 'it waits out the rest before sending');
});

test('without the platform hook it says delivery is unsupported instead of faking it', async () => {
  context = {};          // no waitUntil available
  const r = await call('POST /api/push/rest-timer', { seconds: 1 });
  assert.equal(r.body.delivery, 'unsupported');
});
