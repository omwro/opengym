/* The serverless entry point, driven the way Vercel drives it.
 *
 * Two things here are easy to get wrong and impossible to notice locally: the request path has
 * to survive the rewrite onto a single function (`__p`, per vercel.json), and the body may have
 * been parsed and the stream consumed before the handler ever sees it. Both are exercised.
 *
 * The fs backend stands in for the store — what is under test is the entry point, not Supabase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-serverless-'));
const SECRET = 'a'.repeat(64);
fs.writeFileSync(path.join(DIR, 'secret'), SECRET);
fs.writeFileSync(path.join(DIR, 'db.json'), JSON.stringify({
  users: [{ id: 'ann', name: 'Ann' }, { id: 'ben', name: 'Ben' }], subs: [], team: null
}));
fs.writeFileSync(path.join(DIR, 'state-ann.json'), JSON.stringify({
  unit: 'kg', workouts: [{ id: 'w1', d: '2026-09-02', name: 'Push', vol: 5000, prs: [], entries: [] }], bodyweight: [], routines: []
}));

process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';
process.env.RP_ID = 'localhost';
process.env.ORIGIN = 'http://localhost:5199';
const handler = (await import('../index.js')).default;

const cookieFor = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return 'gymsid=' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

/** Call the handler with the URL shape vercel.json's rewrite actually produces. */
async function call(method, apiPath, { cookie, body } = {}) {
  const [, p, qs] = apiPath.match(/^\/api\/([^?]*)(?:\?(.*))?$/);
  const url = '/api/index.js?__p=' + p + (qs ? '&' + qs : '');
  const req = { method, url, headers: cookie ? { cookie } : {} };
  if (body !== undefined) req.body = body;          // the platform parsed it for us
  const out = { status: 0, headers: {}, body: '' };
  const res = {
    statusCode: 200, headersSent: false,
    setHeader(k, v) { out.headers[k] = v; },
    writeHead(c, h) { out.status = c; Object.assign(out.headers, h || {}); res.headersSent = true; },
    end(b) { out.body = b ?? ''; out.status = out.status || res.statusCode; }
  };
  await handler(req, res);
  return { status: out.status, headers: out.headers, json: out.body ? JSON.parse(out.body) : null };
}

test('the original path survives the rewrite onto a single function', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.users, 2);
  assert.equal((await call('GET', '/api/nope')).status, 404, 'an unknown route is still a 404, not the health check');
});

test('a query string survives it too', async () => {
  const ann = cookieFor('ann');
  await call('POST', '/api/team/rename', { cookie: ann, body: { name: 'Iron' } });
  const r = await call('GET', '/api/team/feed?limit=1', { cookie: ann });
  assert.equal(r.status, 200);
  assert.equal(r.json.feed.length, 1, 'limit=1 reached the handler');
});

test('authentication works — the session cookie is read off the rewritten request', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  const r = await call('GET', '/api/me', { cookie: cookieFor('ann') });
  assert.equal(r.json.user.name, 'Ann');
});

test('a body the platform already parsed is used instead of the consumed stream', async () => {
  const ben = cookieFor('ben');
  const renamed = await call('POST', '/api/team/rename', { cookie: ben, body: { name: "Ben's crew" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.team.name, "Ben's crew");
  // and validation still runs on it
  assert.equal((await call('POST', '/api/team/rename', { cookie: ben, body: {} })).status, 400);
});

test('a write is committed, not just held in memory', async () => {
  const ben = cookieFor('ben');
  await call('POST', '/api/team/rename', { cookie: ben, body: { name: 'Barbell Club' } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'db.json'), 'utf8'));
  assert.equal(onDisk.team.name, 'Barbell Club', 'the store has it, not only this instance');
  // and a later request — a fresh reload of db — still sees it
  assert.equal((await call('GET', '/api/team', { cookie: ben })).json.team.name, 'Barbell Club');
});

test('per-profile state round-trips through the store', async () => {
  const ann = cookieFor('ann');
  assert.equal((await call('GET', '/api/data', { cookie: ann })).json.state.workouts.length, 1);
  const put = await call('PUT', '/api/data', { cookie: ann, body: { state: { unit: 'lb', workouts: [], _ts: 42 } } });
  assert.equal(put.status, 200);
  assert.equal((await call('GET', '/api/data', { cookie: ann })).json.state.unit, 'lb');
});

test('a profile with no state yet reads as null rather than an error', async () => {
  assert.equal((await call('GET', '/api/data', { cookie: cookieFor('ben') })).json.state, null);
});

test('simultaneous writes in one instance do not overwrite each other', async () => {
  // `db` is module state and one instance serves many requests at once, so without the lock in
  // index.js these interleave: each reloads over the other's view and each reports success,
  // while only the last one's change survives. Three profiles publishing a plan at the same
  // instant is the case that actually caught it.
  const ann = cookieFor('ann');
  const before = (await call('GET', '/api/team', { cookie: ann })).json.team.plans.length;
  const bundle = n => ({ opengym_plan: 1, week: {}, customEx: [], routines: [{ id: 'r' + n, name: n, ex: [] }] });

  const results = await Promise.all(['A', 'B', 'C'].map(n =>
    call('POST', '/api/team/plans', { cookie: ann, body: { name: 'Race ' + n, bundle: bundle(n) } })));
  assert.ok(results.every(r => r.status === 200), 'all three are accepted');

  const names = (await call('GET', '/api/team', { cookie: ann })).json.team.plans.map(p => p.name);
  for (const n of ['Race A', 'Race B', 'Race C']) {
    assert.ok(names.includes(n), `${n} was accepted and must still be there — got ${names.join(', ')}`);
  }
  assert.equal(names.length, before + 3, 'three published, three stored — no losses, no duplicates');
});

test('the Coach is absent from a serverless instance', async () => {
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal('coach' in cfg.json, false, 'no coach key ⇒ no Coach UI anywhere in the app');
});
