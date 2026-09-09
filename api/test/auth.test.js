/* Sign-in: one shared password, profiles behind it.
 *
 * The two rules worth guarding are the ones a person would notice going wrong: you cannot add
 * a profile unless you are signed in, and a brand-new instance is the single exception — with
 * no profiles there is nobody to sign in as, so without that carve-out the app could never be
 * started at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-auth-'));
fs.writeFileSync(path.join(DIR, 'secret'), 'a'.repeat(64));
process.env.DATA_DIR = DIR;
process.env.SERVERLESS = '1';
process.env.APP_PASSWORD = 'shoarmasate';
process.env.RP_ID = 'localhost';
process.env.ORIGIN = 'http://localhost';
const api = await import('../server.js');

let cookieJar = null;
async function call(route, body, { cookie = cookieJar, ip = '1.2.3.4' } = {}) {
  const out = { code: 0, body: null, headers: {} };
  const res = {
    headersSent: false,
    writeHead(c, h) { out.code = c; Object.assign(out.headers, h || {}); res.headersSent = true; },
    end(b) { out.body = b ? JSON.parse(b) : null; }
  };
  const [method, url] = route.split(' ');
  await api.routes[route.split('?')[0]](
    { method, url, headers: { ...(cookie ? { cookie } : {}), 'x-forwarded-for': ip }, body, socket: {} }, res);
  const set = out.headers['Set-Cookie'];
  if (set) out.cookie = set.split(';')[0];
  return out;
}
const signIn = async (id, password = 'shoarmasate', opts) => {
  const r = await call('POST /api/login', { id, password }, opts);
  if (r.cookie) cookieJar = r.cookie;
  return r;
};

test('a fresh instance has no profiles and says so', async () => {
  const r = await call('GET /api/profiles');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.profiles, []);
  assert.equal(r.body.empty, true, 'the client needs this to offer "create the first profile"');
});

test('the first profile can be created with the password alone — otherwise nobody could start', async () => {
  const wrong = await call('POST /api/profiles', { name: 'Ann', password: 'nope' });
  assert.equal(wrong.code, 401);
  const r = await call('POST /api/profiles', { name: 'Ann', password: 'shoarmasate' });
  assert.equal(r.code, 200);
  assert.equal(r.body.user.name, 'Ann');
  assert.ok(r.cookie, 'and it signs you straight in — there is nobody to displace');
  cookieJar = r.cookie;
});

test('once a profile exists, adding another requires being signed in', async () => {
  const anon = await call('POST /api/profiles', { name: 'Ben', password: 'shoarmasate' }, { cookie: null });
  assert.equal(anon.code, 401, 'the password alone is no longer enough');
  assert.match(anon.body.error, /sign in/);

  const r = await call('POST /api/profiles', { name: 'Ben' });
  assert.equal(r.code, 200, 'signed in, no password needed');
  assert.equal(r.cookie, undefined,
    'and it does not steal the creator\'s session — you set a friend up, then hand them the phone');
});

test('profiles are listed for the picker, names only', async () => {
  const r = await call('GET /api/profiles', null, { cookie: null });
  assert.deepEqual(r.body.profiles.map(p => p.name), ['Ann', 'Ben']);
  assert.deepEqual(Object.keys(r.body.profiles[0]).sort(), ['id', 'name'], 'nothing else leaks');
  assert.equal(r.body.empty, false);
});

test('duplicate names are refused — the picker is how people find themselves', async () => {
  const r = await call('POST /api/profiles', { name: 'ann' });
  assert.equal(r.code, 409);
});

test('signing in needs the right password', async () => {
  const { profiles } = (await call('GET /api/profiles', null, { cookie: null })).body;
  const ann = profiles.find(p => p.name === 'Ann');
  const bad = await signIn(ann.id, 'wrong', { ip: '5.5.5.5' });
  assert.equal(bad.code, 401);
  const ok = await signIn(ann.id);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.user.name, 'Ann');
  assert.ok(ok.cookie);
  const me = await call('GET /api/me');
  assert.equal(me.body.user.name, 'Ann');
});

test('an unknown profile fails exactly like a wrong password', async () => {
  // Distinguishing them would turn the public list into a way to confirm which ids are real.
  const unknown = await call('POST /api/login', { id: 'nope', password: 'shoarmasate' }, { cookie: null, ip: '6.6.6.6' });
  const wrongPw = await call('POST /api/login', { id: 'nope', password: 'wrong' }, { cookie: null, ip: '6.6.6.7' });
  assert.equal(unknown.code, 401);
  assert.deepEqual(unknown.body, wrongPw.body);
});

test('a disabled profile cannot sign in and is not in the picker', async () => {
  const dbFile = path.join(DIR, 'db.json');
  const before = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const ben = before.users.find(u => u.name === 'Ben');
  fs.writeFileSync(dbFile, JSON.stringify({
    ...before,
    users: before.users.map(u => (u.id === ben.id ? { ...u, disabled: true } : u))
  }));
  await api.reloadDb();

  const list = (await call('GET /api/profiles', null, { cookie: null })).body;
  assert.deepEqual(list.profiles.map(p => p.name), ['Ann'], 'a disabled profile is off the picker');
  const r = await call('POST /api/login', { id: ben.id, password: 'shoarmasate' }, { cookie: null, ip: '7.7.7.7' });
  assert.equal(r.code, 401, 'and the right password still does not open it');

  // Put it back so later tests see both profiles.
  fs.writeFileSync(dbFile, JSON.stringify(before));
  await api.reloadDb();
});

test('an empty or missing password is never accepted', async () => {
  const { profiles } = (await call('GET /api/profiles', null, { cookie: null })).body;
  const id = profiles[0].id;
  // Each on its own IP so the throttle does not mask the result behind a 429.
  const cases = [
    [{ id }, 'no password field at all'],
    [{ id, password: '' }, 'empty string'],
    [{ id, password: null }, 'null'],
    [{ id, password: undefined }, 'undefined'],
    [{}, 'nothing at all']
  ];
  for (let i = 0; i < cases.length; i++) {
    const [body, what] = cases[i];
    const r = await call('POST /api/login', body, { cookie: null, ip: '20.0.0.' + i });
    assert.equal(r.code, 401, what + ' must be refused');
    assert.equal(r.cookie, undefined, what + ' must not hand out a session');
  }
});

test('repeated wrong guesses get throttled', async () => {
  const { profiles } = (await call('GET /api/profiles', null, { cookie: null })).body;
  const id = profiles[0].id;
  const ip = '9.9.9.9';
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST /api/login', { id, password: 'guess' + i }, { cookie: null, ip });
  assert.equal(last.code, 429, 'a single shared password must not allow unlimited free guesses');
  // A different caller is unaffected.
  const other = await call('POST /api/login', { id, password: 'shoarmasate' }, { cookie: null, ip: '10.0.0.1' });
  assert.equal(other.code, 200);
});

test('the config no longer advertises invite-only signup', async () => {
  const r = await call('GET /api/config', null, { cookie: null });
  assert.equal('invite_only' in r.body, false);
  for (const gone of ['POST /api/register/options', 'POST /api/register/verify',
                      'POST /api/login/options', 'POST /api/login/verify',
                      'GET /api/admin/invites', 'POST /api/admin/invites/new']) {
    assert.equal(api.routes[gone], undefined, gone + ' should be gone with passkeys');
  }
});
