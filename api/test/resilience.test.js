/* A long-lived server against a remote store.
 *
 * saveDb() is called synchronously from route handlers and its promise is not returned to
 * them. Under SERVERLESS the entry point awaits it via flushDb() and replays on conflict; in a
 * long-lived server nothing awaits it, so a refused write is an unhandled rejection — which,
 * under Node's default, ends the process. A gym app that dies because two writers touched the
 * same database is worse than one that logs and resyncs.
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

test('the long-lived server runs against a remote store', () => {
  assert.equal(api.SERVERLESS, false, 'not the serverless path');
  assert.ok(api.routes['GET /api/health'], 'and it built its routes');
});

test('a refused write is logged and resynced, not left to crash the process', async () => {
  // Reach saveDb the way a route does: a team rename goes through it.
  const before = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    refuseNextCas = true;
    // Somebody else moved the row on, so this instance's version is stale.
    table.set('db', { value: table.get('db').value, version: 99 });

    let status = 0;
    const res = { writeHead(c) { status = c; }, end() {}, headersSent: false };
    await api.routes['POST /api/team/rename'](
      { method: 'POST', url: '/api/team/rename', headers: { cookie }, body: { name: 'Iron' } }, res);
    assert.equal(status, 200, 'the request itself succeeded — it is the write behind it that was refused');

    // Give the fire-and-forget chain time to reject and be handled.
    await new Promise(r => setTimeout(r, 200));
  } finally { console.error = before; }

  assert.deepEqual(unhandled, [], 'an unhandled rejection here ends the process under Node\'s default');
  assert.ok(logged.some(l => /another writer/.test(l)), 'and it says why, rather than failing silently: ' + JSON.stringify(logged));
});
