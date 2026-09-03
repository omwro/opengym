/* The Supabase backend, against a fake kv table.
 *
 * What matters here is the compare-and-set: on a serverless host several instances hold their
 * own copy of `db`, and the only thing stopping one from overwriting another's write is that
 * the store refuses a save whose base version has moved. These tests are the reason the
 * serverless entry can safely replay a request instead of losing someone's team membership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
const { store, BACKEND, ConflictError } = await import('../store.js');

/* ---------------- a kv table with just enough PostgREST behaviour ---------------- */
let table;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || 'GET';
  const eq = p => {
    const v = u.searchParams.get(p);
    return v == null ? null : v.replace(/^eq\./, '');
  };
  const key = eq('key');
  const ok = body => new Response(JSON.stringify(body), { status: 200 });

  if (method === 'GET') {
    if (u.searchParams.get('key')?.startsWith('like.')) {
      const pre = u.searchParams.get('key').slice(5).replace('*', '');
      return ok(Object.keys(table).filter(k => k.startsWith(pre)).map(k => ({ key: k })));
    }
    const row = table[key];
    return ok(row ? [{ key, value: row.value, version: row.version }] : []);
  }
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    const upsert = /merge-duplicates/.test(init.headers?.Prefer || '');
    if (table[body.key] && !upsert) {
      return new Response('duplicate key value violates unique constraint (23505)', { status: 409 });
    }
    table[body.key] = { value: body.value, version: body.version ?? (table[body.key]?.version ?? 0) + 1 };
    return ok([{ key: body.key, ...table[body.key] }]);
  }
  if (method === 'PATCH') {
    const want = eq('version');
    const row = table[key];
    if (!row || String(row.version) !== want) return ok([]);   // CAS miss — no rows updated
    const body = JSON.parse(init.body);
    table[key] = { value: body.value, version: body.version };
    return ok([{ key, ...table[key] }]);
  }
  throw new Error('unexpected ' + method);
};

test.beforeEach(() => { table = {}; });

test('supabase is chosen when both its url and service key are present', () => {
  assert.equal(BACKEND, 'supabase');
});

test('an empty table reads as an empty db at version 0', async () => {
  const { db, version } = await store.loadDb();
  assert.deepEqual(db.users, []);
  assert.deepEqual(db.teams, []);
  assert.equal(version, 0);
});

test('a save round-trips and moves the version forward', async () => {
  const v1 = await store.saveDb({ users: [{ id: 'a' }], teams: [] }, 0);
  assert.equal(v1, 1);
  const first = await store.loadDb();
  assert.equal(first.version, 1);
  const v2 = await store.saveDb({ ...first.db, users: [{ id: 'a' }, { id: 'b' }] }, first.version);
  assert.equal(v2, 2);
  assert.equal((await store.loadDb()).db.users.length, 2);
});

test('two instances writing the same version: the second is refused, not silently dropped', async () => {
  await store.saveDb({ users: [], teams: [] }, 0);              // version 1
  const alice = await store.loadDb();
  const bob = await store.loadDb();                              // same version — concurrent
  assert.equal(alice.version, bob.version);

  await store.saveDb({ ...alice.db, users: [{ id: 'alice' }] }, alice.version);
  await assert.rejects(
    () => store.saveDb({ ...bob.db, users: [{ id: 'bob' }] }, bob.version),
    e => e instanceof ConflictError,
    'the stale write must be refused so the caller can replay it'
  );
  // Alice is still there: the losing write never landed.
  assert.deepEqual((await store.loadDb()).db.users, [{ id: 'alice' }]);
});

test('a first-write race is a conflict too, not a lost insert', async () => {
  await store.saveDb({ users: [{ id: 'first' }], teams: [] }, 0);
  await assert.rejects(() => store.saveDb({ users: [{ id: 'second' }], teams: [] }, 0),
    e => e instanceof ConflictError);
  assert.deepEqual((await store.loadDb()).db.users, [{ id: 'first' }]);
});

test('a replay after reloading succeeds — the pattern the serverless entry uses', async () => {
  await store.saveDb({ users: [], teams: [] }, 0);
  const stale = await store.loadDb();
  await store.saveDb({ users: [{ id: 'other' }], teams: [] }, stale.version);   // someone else

  let saved = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = await store.loadDb();
    const next = { ...fresh.db, users: [...fresh.db.users, { id: 'me' }] };
    try { saved = await store.saveDb(next, fresh.version); break; }
    catch (e) { if (!(e instanceof ConflictError)) throw e; }
  }
  assert.ok(saved, 'the replay commits');
  assert.deepEqual((await store.loadDb()).db.users.map(u => u.id), ['other', 'me'],
    'and neither writer lost their change');
});

test('per-user state is keyed per user, so profiles never contend', async () => {
  await store.writeState('ann', { workouts: [{ d: '2026-09-01' }] });
  await store.writeState('ben', { workouts: [] });
  assert.equal((await store.readState('ann')).workouts.length, 1);
  assert.equal((await store.readState('ben')).workouts.length, 0);
  assert.equal(await store.readState('nobody'), null);
  assert.deepEqual((await store.listStates()).sort(), ['ann', 'ben']);
});

test('a uid is narrowed before it becomes a key', async () => {
  await store.writeState('../../etc/passwd', { workouts: [] });
  assert.deepEqual(Object.keys(table), ['state:etcpasswd']);
});

test('the session secret is generated once and reused, never regenerated per instance', async () => {
  const first = await store.secret();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await store.secret(), first, 'a second instance must agree, or every cookie breaks');
});

test('vapid keys are generated once and shared by every instance', async () => {
  let calls = 0;
  const gen = () => { calls++; return { publicKey: 'pub' + calls, privateKey: 'priv' + calls }; };
  const a = await store.vapid(gen);
  const b = await store.vapid(gen);
  assert.deepEqual(a, b);
  assert.equal(calls, 1, 'regenerating would invalidate every push subscription on the instance');
});
