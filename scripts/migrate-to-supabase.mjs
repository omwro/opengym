#!/usr/bin/env node
/* Copy a self-hosted openGym data directory into Supabase.
 *
 * Use this to move an existing instance onto a serverless deployment without anyone losing
 * their training, their passkeys or their team. It reads the same `./data` that docker
 * compose mounts and writes the four kinds of key the store uses.
 *
 *   node scripts/migrate-to-supabase.mjs ./data
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment, and the table from
 * supabase/schema.sql to exist.
 *
 * It refuses to overwrite an instance that already has users unless --force is passed: running
 * this twice against a live deployment would roll everyone back to the state of the dump.
 * Per-profile state and the session secret are copied as they are — keeping the secret is what
 * stops the migration from signing everybody out.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dir = args.find(a => !a.startsWith('--')) || './data';

const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.error(`No such data directory: ${dir}`);
  process.exit(1);
}

const base = URL_.replace(/\/+$/, '') + '/rest/v1/kv';
const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function req(url, init) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const get = async key => (await req(`${base}?key=eq.${encodeURIComponent(key)}&select=value,version`))?.[0] || null;
const put = (key, value) => req(base + '?on_conflict=key', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
});
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const existing = await get('db');
if (existing?.value?.users?.length && !force) {
  console.error(`Refusing to overwrite: the target already has ${existing.value.users.length} profile(s).`);
  console.error('Re-run with --force if you really mean to replace them.');
  process.exit(1);
}

const db = readJSON(path.join(dir, 'db.json'));
if (!db) { console.error(`No db.json in ${dir} — is that an openGym data directory?`); process.exit(1); }
db.subs = db.subs || []; db.invites = db.invites || []; db.teams = db.teams || [];

// The version has to move forward, or the first save from a running instance is refused.
await put('db', db);
const after = await get('db');
console.log(`db            ${db.users.length} profiles, ${db.creds?.length || 0} passkeys, ${db.teams.length} teams (version ${after.version})`);

// Keeping the signing secret is what stops every existing session from being invalidated.
const secret = fs.existsSync(path.join(dir, 'secret'))
  ? fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim() : null;
if (secret) { await put('secret', { v: secret }); console.log('secret        copied (existing sessions stay valid)'); }
else console.log('secret        none found — a new one will be generated on first boot');

const vapid = readJSON(path.join(dir, 'vapid.json'));
if (vapid) { await put('vapid', vapid); console.log('vapid         copied (existing push subscriptions keep working)'); }
else console.log('vapid         none found — a new keypair will be generated on first boot');

let n = 0;
for (const name of fs.readdirSync(dir)) {
  const m = name.match(/^state-(.+)\.json$/);
  if (!m) continue;
  const state = readJSON(path.join(dir, name));
  if (!state) { console.warn(`  skipped ${name} — unreadable`); continue; }
  await put('state:' + m[1], state);
  console.log(`  ${m[1].padEnd(16)} ${(state.workouts || []).length} workouts, ${(state.routines || []).length} routines`);
  n++;
}
console.log(`\nMigrated ${n} profile${n === 1 ? '' : 's'}.`);
