/* Concurrent requests through the serverless entry, against a store with real latency.
 *
 * This is deliberately NOT the fs backend. Every fs operation is synchronous, so requests never
 * actually interleave and the bug this file exists for cannot reproduce — a test that passes
 * either way guards nothing. Instead a local HTTP server stands in for Supabase's REST API,
 * with a small delay on every call, which is what a network round trip really is and what
 * gives two in-flight requests the chance to read the same version of `db`.
 *
 * Without the per-instance lock in index.js, the last test here loses writes that were all
 * answered with 200.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

/* ---------------- a stand-in for the kv table, with latency ---------------- */
const table = new Map();
let reads = 0, writes = 0;
const delay = ms => new Promise(r => setTimeout(r, ms));

const kv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const eq = p => url.searchParams.get(p)?.replace(/^eq\./, '') ?? null;
  const body = await new Promise(resolve => {
    const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(c.length ? JSON.parse(Buffer.concat(c)) : null));
  });
  await delay(4);                       // a round trip, not a function call
  const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
  const key = eq('key');

  if (req.method === 'GET') {
    reads++;
    const row = table.get(key);
    return send(200, row ? [{ key, value: row.value, version: row.version }] : []);
  }
  if (req.method === 'POST') {
    const upsert = /merge-duplicates/.test(req.headers.prefer || '');
    if (table.has(body.key) && !upsert) return send(409, { message: 'duplicate key value (23505)' });
    writes++;
    table.set(body.key, { value: body.value, version: body.version ?? (table.get(body.key)?.version ?? 0) + 1 });
    return send(200, [{ key: body.key, ...table.get(body.key) }]);
  }
  if (req.method === 'PATCH') {
    const row = table.get(key);
    if (!row || String(row.version) !== eq('version')) return send(200, []);   // compare-and-set miss
    writes++;
    table.set(key, { value: body.value, version: body.version });
    return send(200, [{ key, ...table.get(key) }]);
  }
  send(405, {});
});
await new Promise(r => kv.listen(0, '127.0.0.1', r));

const SECRET = 'c'.repeat(64);
table.set('secret', { value: { v: SECRET }, version: 1 });
table.set('db', {
  value: { users: [{ id: 'ann', name: 'Ann' }, { id: 'ben', name: 'Ben' }, { id: 'cat', name: 'Cat' }],
           subs: [], team: null },
  version: 1
});

process.env.SUPABASE_URL = `http://127.0.0.1:${kv.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.SERVERLESS = '1';
process.env.RP_ID = 'localhost';
process.env.ORIGIN = 'http://localhost';
const handler = (await import('../index.js')).default;

const cookieFor = uid => {
  const p = `${uid}:${Date.now() + 86400000}:0`;
  return 'gymsid=' + p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
};
async function call(method, apiPath, { cookie, body } = {}) {
  const [, p, qs] = apiPath.match(/^\/api\/([^?]*)(?:\?(.*))?$/);
  const req = { method, url: '/api/index.js?__p=' + p + (qs ? '&' + qs : ''), headers: cookie ? { cookie } : {} };
  if (body !== undefined) req.body = body;
  const out = { status: 0, headers: {}, body: '' };
  const res = { statusCode: 200, headersSent: false,
    setHeader: (k, v) => { out.headers[k] = v; },
    writeHead: (c, h) => { out.status = c; Object.assign(out.headers, h || {}); res.headersSent = true; },
    end: b => { out.body = b ?? ''; out.status = out.status || res.statusCode; } };
  await handler(req, res);
  return { status: out.status, json: out.body ? JSON.parse(out.body) : null };
}

test.after(() => kv.close());

test('the backend really is the async one', async () => {
  const { BACKEND } = await import('../store.js');
  assert.equal(BACKEND, 'supabase', 'this file is meaningless against a synchronous store');
  assert.ok(reads > 0, 'and the store is being read over the wire');
});

test('the team can be renamed and read back', async () => {
  const r = await call('POST', '/api/team/rename', { cookie: cookieFor('ann'), body: { name: 'Iron' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/team', { cookie: cookieFor('ann') })).json.team.name, 'Iron');
});

test('profiles created at the same instant all survive', async () => {
  // The join race is gone with join codes, but creating profiles is the same write to the same
  // document — and a profile answered with 200 that then vanishes is the same bug.
  const made = await Promise.all(['Dee', 'Eve', 'Fay'].map(name =>
    call('POST', '/api/profiles', { cookie: cookieFor('ann'), body: { name } })));
  assert.ok(made.every(r => r.status === 200), 'all three are accepted: ' + made.map(r => r.status));
  const members = (await call('GET', '/api/team', { cookie: cookieFor('ann') })).json.team.members.map(m => m.name).sort();
  assert.deepEqual(members, ['Ann', 'Ben', 'Cat', 'Dee', 'Eve', 'Fay'],
    'a profile answered with 200 must not be undone by another created at the same time');
});

test('simultaneous publishes are all kept — none lost, none duplicated', async () => {
  const ann = cookieFor('ann');
  const before = (await call('GET', '/api/team', { cookie: ann })).json.team.plans.length;
  const bundle = n => ({ opengym_plan: 1, week: {}, customEx: [], routines: [{ id: 'r' + n, name: n, ex: [] }] });

  const results = await Promise.all(['A', 'B', 'C', 'D'].map((n, i) =>
    call('POST', '/api/team/plans', {
      cookie: cookieFor(['ann', 'ben', 'cat', 'ann'][i]),
      body: { name: 'Race ' + n, bundle: bundle(n) }
    })));
  assert.ok(results.every(r => r.status === 200), 'all four are accepted: ' + results.map(r => r.status));

  const names = (await call('GET', '/api/team', { cookie: ann })).json.team.plans.map(p => p.name);
  for (const n of ['Race A', 'Race B', 'Race C', 'Race D']) {
    assert.ok(names.includes(n), `${n} was answered 200 and must still exist — got: ${names.join(', ')}`);
  }
  assert.equal(names.length, before + 4, 'four published, four stored');
});

test('a profile syncing while others write does not disturb them', async () => {
  const ann = cookieFor('ann');
  const [put, rename] = await Promise.all([
    call('PUT', '/api/data', { cookie: cookieFor('ben'), body: { state: { unit: 'lb', workouts: [], _ts: 1 } } }),
    call('POST', '/api/team/rename', { cookie: ann, body: { name: 'Iron Club' } })
  ]);
  assert.equal(put.status, 200);
  assert.equal(rename.status, 200);
  assert.equal((await call('GET', '/api/team', { cookie: ann })).json.team.name, 'Iron Club');
  assert.equal((await call('GET', '/api/data', { cookie: cookieFor('ben') })).json.state.unit, 'lb');
});
