/* The other side of the production guard: when it must stay out of the way.
 *
 * Three legitimate writers exist — the deployment itself, a store that lives on this machine,
 * and anyone who says explicitly that they mean it. A guard that blocked those would be worked
 * around rather than relied on, so each is covered here.
 *
 * Each case needs its own process: READ_ONLY is decided once, at import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** Import store.js in a fresh process under `env` and report what it decided. */
function decide(env) {
  const code = `
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    const { READ_ONLY, BACKEND } = await import('${new URL('../store.js', import.meta.url).pathname}');
    console.log(JSON.stringify({ READ_ONLY, BACKEND }));
  `;
  const base = {
    PATH: process.env.PATH,
    SUPABASE_URL: 'https://djamqevqhwuwtobmebyc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role'
  };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...base, ...env }, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('a laptop pointed at a remote project is guarded — the case this exists for', () => {
  assert.equal(decide({}).READ_ONLY, true);
});

test('the deployment itself writes freely', () => {
  assert.equal(decide({ VERCEL: '1' }).READ_ONLY, false, 'Vercel sets this at runtime');
  assert.equal(decide({ OPENGYM_DEPLOYMENT: '1' }).READ_ONLY, false, 'and a self-hosted deployment can say so');
});

test('an explicit opt-in is honoured, so a deliberate write is always possible', () => {
  for (const v of ['1', 'true', 'yes', 'on']) {
    assert.equal(decide({ ALLOW_REMOTE_WRITES: v }).READ_ONLY, false, v + ' should opt in');
  }
  assert.equal(decide({ ALLOW_REMOTE_WRITES: '0' }).READ_ONLY, true, 'and anything else does not');
  assert.equal(decide({ ALLOW_REMOTE_WRITES: '' }).READ_ONLY, true);
});

test('a store on this machine is yours to write to', () => {
  for (const url of ['http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321', 'https://localhost:54321/']) {
    assert.equal(decide({ SUPABASE_URL: url }).READ_ONLY, false, url + ' is local');
  }
});

test('a hostname that merely starts with "localhost" is not local', () => {
  // localhost.evil.example resolves wherever its owner wants it to.
  assert.equal(decide({ SUPABASE_URL: 'https://localhost.evil.example' }).READ_ONLY, true);
  assert.equal(decide({ SUPABASE_URL: 'https://127.0.0.1.evil.example' }).READ_ONLY, true);
});

test('the filesystem backend is never guarded — there is nothing shared to protect', () => {
  const r = decide({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', DATA_DIR: '/tmp/gym-guard-test' });
  assert.equal(r.BACKEND, 'fs');
  assert.equal(r.READ_ONLY, false);
});
