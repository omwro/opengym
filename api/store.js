/* Storage backend — the one place that knows *where* openGym's data lives.
 *
 * Two backends, chosen by environment:
 *
 *   fs        (default)  the directory openGym has always used. A long-lived process owns
 *                        the files, so reads are cheap and a write is an atomic rename.
 *   supabase             a `kv` table, for hosts with no durable disk (Vercel). Reached over
 *                        Supabase's HTTP API rather than a Postgres socket: serverless
 *                        functions scale to many short-lived instances, and a connection pool
 *                        per instance is the classic way that falls over.
 *
 * Everything here is async so the two are interchangeable. Under `fs` the promises resolve
 * synchronously-in-spirit — nothing is deferred that wasn't before.
 *
 * ── Concurrency ──
 * `db` is one document holding every user, credential and team, so two requests that both
 * mutate it can lose each other's write. The fs backend is safe by construction: one process,
 * one copy in memory. The supabase backend versions the document and refuses a write whose
 * base version has moved (`ConflictError`); the serverless entry point replays the request
 * against fresh data rather than clobbering. Per-user state is keyed per user and needs none
 * of this — a profile only ever writes its own.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Vercel's Supabase integration injects its own names, so both spellings are accepted and
// nobody has to hand-add a duplicate of a variable that is already there. NEXT_PUBLIC_ is
// Next.js's convention for "safe in the browser" — it is only the project URL, which is
// public anyway; the key below is the part that must not travel.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// The service-role key bypasses row-level security and must never reach the browser. It is
// read here, in server-only code, and is the reason no anon or publishable key is accepted as
// a substitute — either would be refused by every policy-less table in the schema.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
export const BACKEND = SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'fs';

export class ConflictError extends Error {
  constructor() { super('db changed underneath this request'); this.name = 'ConflictError'; }
}

const EMPTY_DB = () => ({ users: [], creds: [], subs: [], invites: [], teams: [] });
// A uid reaches this as a path segment and as a URL parameter, so it is narrowed to the
// alphabet it is minted from before it becomes either.
const safeUid = uid => String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
const stateKey = uid => 'state:' + safeUid(uid);

/* ============================ filesystem ============================ */

function fsBackend() {
  const DATA = process.env.DATA_DIR || '/data';
  fs.mkdirSync(DATA, { recursive: true });
  // 0700 is what stops the unprivileged user that Coach jobs run as from reading any of this.
  // Best-effort: a bind-mounted host directory may refuse the chmod, and that is not a reason
  // to refuse to boot.
  try { fs.chmodSync(DATA, 0o700); } catch { /* host filesystem says no — carry on */ }

  const file = name => path.join(DATA, name);
  const atomicWrite = (f, content, mode) => {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
    fs.renameSync(tmp, f);
  };
  const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  // The filename openGym has always used, so an existing ./data directory is picked up as-is.
  const stateFile = uid => file('state-' + safeUid(uid) + '.json');

  return {
    async secret() {
      const f = file('secret');
      if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      return fs.readFileSync(f, 'utf8').trim();
    },
    async vapid(generate) {
      const f = file('vapid.json');
      const existing = readJSON(f);
      if (existing) return existing;
      const keys = generate();
      fs.writeFileSync(f, JSON.stringify(keys), { mode: 0o600 });
      return keys;
    },
    async loadDb() {
      return { db: readJSON(file('db.json')) || EMPTY_DB(), version: 0 };
    },
    async saveDb(db) {
      atomicWrite(file('db.json'), JSON.stringify(db, null, 2));
      return 0;   // one process owns the file; there is no version to move
    },
    async readState(uid) { return readJSON(stateFile(uid)); },
    async writeState(uid, state) { atomicWrite(stateFile(uid), JSON.stringify(state)); },
    async listStates() {
      return fs.readdirSync(DATA)
        .filter(n => n.startsWith('state-') && n.endsWith('.json'))
        .map(n => n.slice(6, -5));
    }
  };
}

/* ============================ supabase ============================ */

function supabaseBackend() {
  const base = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/kv';
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };

  async function req(url, init) {
    const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
    if (!r.ok) throw new Error(`supabase ${init?.method || 'GET'} ${r.status}: ${await r.text()}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  const get = async key => {
    const rows = await req(`${base}?key=eq.${encodeURIComponent(key)}&select=value,version`);
    return rows?.[0] || null;
  };
  // Blind upsert — for rows nothing else writes concurrently (per-user state, the keys below).
  const put = (key, value) => req(base + '?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  });

  /** Create a key only if it is absent, then return whatever ended up stored. Two instances
   *  booting at once must agree on one value, not each keep the one it generated. */
  async function once(key, generate) {
    const existing = await get(key);
    if (existing) return existing.value;
    try {
      await req(base, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ key, value: generate() })
      });
    } catch (e) {
      // 23505 = another instance inserted it first, which is the outcome we wanted anyway.
      if (!/duplicate key|23505/i.test(e.message)) throw e;
    }
    return (await get(key)).value;
  }

  return {
    async secret() {
      return (await once('secret', () => ({ v: crypto.randomBytes(32).toString('hex') }))).v;
    },
    async vapid(generate) { return once('vapid', generate); },
    async loadDb() {
      const row = await get('db');
      if (!row) return { db: EMPTY_DB(), version: 0 };
      return { db: row.value, version: row.version };
    },
    async saveDb(db, version) {
      if (!version) {
        // First write of this instance's life, or a genuinely empty table. Insert; a duplicate
        // means someone got there first and this request is working from stale data.
        try {
          await req(base, {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ key: 'db', value: db, version: 1 })
          });
          return 1;
        } catch (e) {
          if (/duplicate key|23505/i.test(e.message)) throw new ConflictError();
          throw e;
        }
      }
      // Compare-and-set: the row only moves if it is still on the version this request read.
      const rows = await req(
        `${base}?key=eq.db&version=eq.${version}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ value: db, version: version + 1, updated_at: new Date().toISOString() })
        }
      );
      if (!rows || !rows.length) throw new ConflictError();
      return version + 1;
    },
    async readState(uid) { return (await get(stateKey(uid)))?.value ?? null; },
    async writeState(uid, state) { await put(stateKey(uid), state); },
    async listStates() {
      const rows = await req(`${base}?key=like.state:*&select=key`);
      return (rows || []).map(r => r.key.slice(6));
    }
  };
}

export const store = BACKEND === 'supabase' ? supabaseBackend() : fsBackend();
