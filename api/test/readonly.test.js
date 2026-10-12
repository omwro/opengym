/* The production guard.
 *
 * Pointing a local server at the deployment's database is genuinely useful — you can look at
 * real data — and genuinely dangerous, because every write lands in it. Configuration cannot be
 * the protection, since misconfiguration is the failure mode. So the rule lives in the store,
 * and this file is what says it actually holds.
 *
 * `fetch` is stubbed: a write that is correctly refused never reaches the network, and the
 * counter below is how we prove that rather than trusting it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const table = new Map();
let writes = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method || 'GET';
  const key = u.searchParams.get('key')?.replace(/^eq\./, '') ?? null;
  const ok = body => new Response(JSON.stringify(body), { status: 200 });
  if (method === 'GET') {
    const row = table.get(key);
    return ok(row ? [{ key, value: row.value, version: row.version }] : []);
  }
  writes++;                       // nothing in this file should ever get here
  const body = JSON.parse(init.body);
  const k = body.key ?? key;
  table.set(k, { value: body.value, version: body.version ?? 1 });
  return ok([{ key: k, ...table.get(k) }]);
};

table.set('secret', { value: { v: 'a'.repeat(64) }, version: 1 });
table.set('vapid', { value: { publicKey: 'pub', privateKey: 'priv' }, version: 1 });
table.set('db', { value: { users: [{ id: 'ann', name: 'Ann' }], subs: [], team: { name: 'Iron', plans: [] } }, version: 3 });
table.set('state:ann', { value: { unit: 'kg', workouts: [{ id: 'w1', d: '2026-09-09' }] }, version: 1 });

process.env.SUPABASE_URL = 'https://djamqevqhwuwtobmebyc.supabase.co';   // a remote project
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
delete process.env.VERCEL;
delete process.env.OPENGYM_DEPLOYMENT;
delete process.env.ALLOW_REMOTE_WRITES;

const { store, READ_ONLY, ReadOnlyError, BACKEND } = await import('../store.js');

test('a remote store reached from a non-deployment is read-only', () => {
  assert.equal(BACKEND, 'supabase');
  assert.equal(READ_ONLY, true, 'if this is false, nothing below is actually being protected');
});

test('reads still work — that is the point of allowing this at all', async () => {
  const { db, version } = await store.loadDb();
  assert.equal(db.users[0].name, 'Ann');
  assert.equal(version, 3);
  assert.equal((await store.readState('ann')).workouts.length, 1);
  assert.equal(await store.secret(), 'a'.repeat(64));
  assert.deepEqual(await store.vapid(() => ({ publicKey: 'new', privateKey: 'new' })), { publicKey: 'pub', privateKey: 'priv' });
});

test('writing the shared database is refused', async () => {
  await assert.rejects(
    () => store.saveDb({ users: [], subs: [], team: null }, 3),
    e => e instanceof ReadOnlyError && /not the deployment/.test(e.message)
  );
  assert.equal((await store.loadDb()).db.users.length, 1, 'and the stored value is untouched');
});

test("writing somebody's training data is refused", async () => {
  await assert.rejects(() => store.writeState('ann', { workouts: [] }), e => e instanceof ReadOnlyError);
  assert.equal((await store.readState('ann')).workouts.length, 1, "Ann's log is untouched");
});

test('minting a new session secret is refused — it would sign everyone out at once', async () => {
  table.delete('secret');
  await assert.rejects(() => store.secret(), e => e instanceof ReadOnlyError && /create "secret"/.test(e.message));
  table.set('secret', { value: { v: 'a'.repeat(64) }, version: 1 });
});

test('generating a push keypair is refused for the same reason', async () => {
  table.delete('vapid');
  await assert.rejects(() => store.vapid(() => ({ publicKey: 'x', privateKey: 'y' })), e => e instanceof ReadOnlyError);
  table.set('vapid', { value: { publicKey: 'pub', privateKey: 'priv' }, version: 1 });
});

test('the error names what was refused and how to proceed deliberately', async () => {
  const err = await store.saveDb({}, 3).catch(e => e);
  assert.match(err.message, /ALLOW_REMOTE_WRITES=1/, 'a guard you cannot get past on purpose is a bug, not a guard');
});

test('not one write reached the store', () => {
  // The guard must stop the request before it is sent, not rely on anything downstream.
  assert.equal(writes, 0, `${writes} write(s) made it through`);
});
