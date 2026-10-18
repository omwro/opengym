/* Push delivery, end to end against a stand-in push service.
 *
 * webpush really encrypts and POSTs here; the "push service" is a local HTTP server that
 * records what it receives, and can be told to refuse. That makes three things checkable that
 * used to fail silently in production: the rest-timer push actually going out after the delay,
 * a skip or a "+15s" cancelling/replacing it, and a refusal by the push service being reported
 * instead of the app claiming success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ---------- a push service that records, or refuses ---------- */
// web-push only speaks https, so the stand-in gets a throwaway self-signed certificate.
const CERTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-push-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(CERTDIR, 'k.pem'), '-out', path.join(CERTDIR, 'c.pem')], { stdio: 'ignore' });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const received = [];
let refuseWith = 0;
const pushService = https.createServer({ key: fs.readFileSync(path.join(CERTDIR, 'k.pem')), cert: fs.readFileSync(path.join(CERTDIR, 'c.pem')) }, (req, res) => {
  const c = []; req.on('data', d => c.push(d)); req.on('end', () => {
    received.push({ at: Date.now(), headers: req.headers, bytes: Buffer.concat(c).length });
    if (refuseWith) { res.writeHead(refuseWith); return res.end('{"reason":"BadJwtToken"}'); }
    res.writeHead(201); res.end();
  });
});
await new Promise(r => pushService.listen(0, '127.0.0.1', r));
const ENDPOINT = `https://127.0.0.1:${pushService.address().port}/push/device-1`;

// A real browser key pair, so webpush can encrypt for it.
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-push-'));
const SECRET = 'p'.repeat(64);
fs.writeFileSync(path.join(DIR, 'secret'), SECRET);
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({
  users: [{ id: 'ann', name: 'Ann' }], team: null,
  subs: [{ userId: 'ann', endpoint: ENDPOINT, keys }]
}));
process.env.DATA_DIR = DIR;
process.env.PORT = '0';
delete process.env.SERVERLESS;
delete process.env.ORIGIN;
delete process.env.VAPID_SUBJECT;
const api = await import('../server.js');

const cookie = (() => { const p = `ann:${Date.now() + 86400000}:0`; return 'gymsid=' + p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); })();
async function call(route, body) {
  let out = null;
  const res = { headersSent: false, writeHead(c) { this.code = c; }, end(b) { out = { code: this.code, body: b ? JSON.parse(b) : null }; } };
  const [method, url] = route.split(' ');
  await api.routes[route]({ method, url, headers: { cookie }, body: body || {}, socket: {} }, res);
  return out;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test.after(() => { pushService.close(); api.server?.close(); });

test('the VAPID subject is never localhost — Apple refuses it, and iOS then gets nothing', async () => {
  const jwt = (await (async () => {
    received.length = 0;
    await call('POST /api/push/test');
    return received[0].headers.authorization;
  })());
  const token = jwt.replace(/^vapid t=/, '').split(',')[0];
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.doesNotMatch(claims.sub, /localhost/, 'subject was ' + claims.sub);
  assert.match(claims.sub, /^(https:\/\/|mailto:)/);
});

test('the test push reports what the push service said', async () => {
  refuseWith = 0;
  const ok = await call('POST /api/push/test');
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.results[0].ok, true);

  refuseWith = 403;
  const bad = await call('POST /api/push/test');
  assert.equal(bad.body.ok, false, 'a refused push must not be reported as sent');
  assert.equal(bad.body.results[0].status, 403);
  assert.match(bad.body.results[0].reason, /BadJwtToken/);
  refuseWith = 0;
});

test('the rest-timer push goes out after the rest, not before', async () => {
  received.length = 0;
  const r = await call('POST /api/push/rest-timer', { seconds: 1 });
  assert.equal(r.code, 200);
  await wait(500);
  assert.equal(received.length, 0, 'not early');
  await wait(900);
  assert.equal(received.length, 1, 'and it did arrive');
  assert.equal(received[0].headers.ttl, '120', 'a stale "rest over" is allowed to expire');
});

test('skipping the rest cancels the push', async () => {
  received.length = 0;
  await call('POST /api/push/rest-timer', { seconds: 1 });
  await call('POST /api/push/rest-timer/cancel');
  await wait(1400);
  assert.equal(received.length, 0);
});

test('adding time replaces the push rather than sending two', async () => {
  received.length = 0;
  await call('POST /api/push/rest-timer', { seconds: 1 });
  await call('POST /api/push/rest-timer', { seconds: 2 });     // "+15s", condensed
  await wait(1400);
  assert.equal(received.length, 0, 'the first one was superseded');
  await wait(1000);
  assert.equal(received.length, 1, 'exactly one, at the new time');
});
