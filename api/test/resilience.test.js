/* A long-lived server against a remote store, which is not the single-writer situation the
 * original design assumed: a laptop pointed at the deployment's database is a second writer
 * exactly like another instance is.
 *
 * Two failures are covered here, both seen for real.
 *
 * 1. A refused write used to be an unhandled rejection, which under Node's default ends the
 *    process.
 * 2. Worse, the route had already answered 200 from its in-memory copy, so the caller was told
 *    their plan was published when the write behind it was then thrown away. `serve` exists to
 *    close that: it commits before replying, and replays the request on a stale version.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* A kv stand-in that can be told to refuse the next compare-and-set. */
const table = new Map();
let refuseNextCas = false;
const kv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = url.searchParams.get('key')?.replace(/^eq\./, '') ?? null;
  const body = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(c.length ? JSON.parse(Buffer.concat(c)) : null)); });
  const send = (code, p) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(p)); };
  if (req.method === 'GET') { const row = table.get(key); return send(200, row ? [{ key, value: row.value, version: row.version }] : []); }
  if (req.method === 'POST') {
    if (table.has(body.key) && !/merge-duplicates/.test(req.headers.prefer || '')) return send(409, { message: 'duplicate key (23505)' });
    table.set(body.key, { value: body.value, version: body.version ?? (table.get(body.key)?.version ?? 0) + 1 });
    return send(200, [{ key: body.key, ...table.get(body.key) }]);
  }
  if (req.method === 'PATCH') {
    if (refuseNextCas) { refuseNextCas = false; return send(200, []); }   // as if someone else wrote first
    const row = table.get(key);
    if (!row || String(row.version) !== url.searchParams.get('version')?.replace(/^eq\./, '')) return send(200, []);
    table.set(key, { value: body.value, version: body.version });
    return send(200, [{ key, ...table.get(key) }]);
  }
  send(405, {});
});
await new Promise(r => kv.listen(0, '127.0.0.1', r));

table.set('secret', { value: { v: 'd'.repeat(64) }, version: 1 });
table.set('db', { value: { users: [{ id: 'ann', name: 'Ann' }], subs: [], team: null }, version: 1 });

process.env.SUPABASE_URL = `http://127.0.0.1:${kv.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
delete process.env.SERVERLESS;          // the long-lived path — this is the whole point
process.env.PORT = '0';
process.env.RP_ID = 'localhost';
process.env.ORIGIN = 'http://localhost';

const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(e));

const api = await import('../server.js');

// A signed cookie for the profile in the fixture db — a write route has to get past auth
// before it can reach saveDb at all.
const SECRET = 'd'.repeat(64);
const crypto = await import('node:crypto');
const cookie = (() => {
  const p = `ann:${Date.now() + 86400000}:0`;
  return 'gymsid=' + p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
})();

test.after(() => { kv.close(); api.server?.close(); });

test('a refused write is replayed rather than answered with a false success', async () => {
  // The request lands on a version that has already moved. Without the replay in `serve` this
  // answers 200 and the rename is silently dropped.
  refuseNextCas = true;
  const out = { code: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(c, h) { out.code = c; out.headers = h; },
    end(b) { out.body = b ? JSON.parse(b) : null; }
  };
  await api.serve({ method: 'POST', url: '/api/team/rename', headers: { cookie }, body: { name: 'Replayed' } }, res);

  assert.equal(out.code, 200, 'the replay succeeds');
  assert.equal(out.body.team.name, 'Replayed');
  // And the claim is true: the store really holds it.
  assert.equal(table.get('db').value.team?.name, 'Replayed',
    'a 200 must mean the write landed, not that it was attempted');
});

test('the long-lived server runs against a remote store', () => {
  assert.equal(api.SERVERLESS, false, 'not the serverless path');
  assert.ok(api.routes['GET /api/health'], 'and it built its routes');
});

test('a refused write never becomes an unhandled rejection', async () => {
  // saveDb() hands its promise to nobody, so before `serve` awaits it there is a window where
  // a rejection would be unhandled — and under Node's default that ends the process. Calling a
  // route directly is the bluntest way to exercise that window.
  refuseNextCas = true;
  table.set('db', { value: table.get('db').value, version: 99 });   // this instance is now stale

  const res = { writeHead() {}, end() {}, headersSent: false };
  await api.routes['POST /api/team/rename'](
    { method: 'POST', url: '/api/team/rename', headers: { cookie }, body: { name: 'Whatever' } }, res);
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(unhandled, [], 'an unhandled rejection here ends the process under Node\'s default');
});
