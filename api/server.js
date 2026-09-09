/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { teamRoutes } from './teams.js';
import { store, BACKEND } from './store.js';

// Two separate questions, deliberately not one flag:
//
//   SERVERLESS — is something else handling the socket? Set by the serverless entry point.
//                It governs whether this module listens on a port and starts background
//                timers, and nothing else.
//   COACH      — can the AI Coach run at all? It owns a directory, spawns child processes
//                under a separate user and reviews on a schedule, so it needs both a
//                filesystem backend and a process that outlives a request. Where it cannot
//                run it is not merely disabled: it is never imported, keeping its very large
//                provider SDKs out of the deployment.
//
// Keeping them apart is what lets a long-lived server run against Supabase — a perfectly
// reasonable way to self-host, and the only way to exercise that backend locally.
export const SERVERLESS = /^(1|true|yes|on)$/i.test(process.env.SERVERLESS || '');
const COACH = BACKEND === 'fs' && !SERVERLESS;
const coachConfig = COACH ? await import('./coach/config.js') : null;
const coachJobs = COACH ? await import('./coach/jobs.js') : null;
const { coachRoutes } = COACH ? await import('./coach/routes.js') : { coachRoutes: () => ({}) };
const { startCadence } = COACH ? await import('./coach/cadence.js') : { startCadence: () => {} };

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
// Passkeys are gone, and with them the relying-party id that had to match the address bar
// exactly — the single fiddliest thing about deploying this app, and the reason a new
// deployment URL used to break sign-in until an environment variable caught up. A password
// does not care what the host is called.
//
// All that survives is the one question the session cookie needs answered: is this connection
// https? A Secure cookie over plain http is dropped by the browser, and sign-in then fails
// silently, so it is read per request rather than assumed from configuration.
function isHttps(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto) return proto === 'https';
  return /^https:/i.test(ORIGIN);
}
// Admin dashboard (issue): admins are matched by uid.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

// One password for the whole instance, with profiles behind it.
//
// A deliberate trade for a handful of friends sharing one server: you pick your name from a
// list and type the password everybody knows. This is not per-user authentication and does not
// pretend to be — anyone with the password can open any profile here. That is the intent (a
// shared training log, not a bank), but it is worth stating plainly, because the passkeys this
// replaces really did identify individual people.
//
// Set APP_PASSWORD to your own; the default exists so a fresh instance boots.
const APP_PASSWORD = process.env.APP_PASSWORD || 'shoarmasate';
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
const secureFor = req => (isHttps(req) ? ' Secure;' : '');

/* ---------- secret + db ---------- */
// Where any of this actually lives is store.js's problem: a directory on disk when openGym
// owns a long-lived process, a `kv` table when it is deployed somewhere without one.
const SECRET = await store.secret();

// `const`, and refilled in place on reload: the route modules are handed this object once at
// startup, so rebinding the name would leave them reading a copy that never changes again.
const db = { users: [], subs: [], team: null };
let dbVersion = 0;
async function reloadDb() {
  const loaded = await store.loadDb();
  dbVersion = loaded.version;
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, { users: [], subs: [], team: null }, loaded.db);
  // Fields from the passkey era. Nothing reads them any more, and carrying them forward would
  // keep rewriting a dead copy of everyone's credentials on every save. Dropped from the
  // in-memory copy only — the next ordinary write is what actually removes them from the
  // store, so this costs no extra round trip and needs no migration step to be run.
  delete db.creds;
  delete db.invites;
  return db;
}
await reloadDb();

const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
// Routes call this synchronously, as they always have. Under the fs backend the write is done
// by the time the next line runs; under a remote store it is a promise the request must settle
// before replying, which is what `flushDb` is for — the serverless entry awaits it and retries
// the whole request if the document moved underneath it.
let dbWrite = null;
function saveDb() {
  // fs: the adapter has no awaits, so the rename has happened by the time this returns —
  // exactly the durability the file-backed version always had.
  if (BACKEND === 'fs') { store.saveDb(db, dbVersion); return; }
  const chain = (dbWrite || Promise.resolve()).then(() => store.saveDb(db, dbVersion)).then(v => { dbVersion = v; });
  dbWrite = chain;
  // Callers of saveDb() are synchronous and never see this promise. Under SERVERLESS that is
  // fine — flushDb() awaits it and the entry point replays the request. In a long-lived server
  // nothing awaits it at all, so a refused write would surface as an unhandled rejection and,
  // under Node's default, kill the process. Recover instead: resync from the store so this
  // instance stops working from a version that has moved on.
  //
  // Being refused at all means something else is writing the same database. One long-lived
  // server owning it never conflicts; two writers (a local server pointed at the deployment's
  // database, say) is the case this catches, and the log line says so.
  chain.catch(async err => {
    if (SERVERLESS) return;             // flushDb() is the handler there, and it retries properly
    console.error('db write refused — another writer has this database. Resyncing.', err.message);
    try { await reloadDb(); } catch (e) { console.error('resync failed', e.message); }
  });
}
/** Settle any pending db write. Throws ConflictError if another request got there first. */
async function flushDb() { const p = dbWrite; dbWrite = null; if (p) await p; }

const readState = uid => store.readState(uid);

/* ---------- push notifications (Web Push / VAPID) ---------- */
let vapid = await store.vapid(() => webpush.generateVAPIDKeys());
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
// A sweep, not a schedule: it only means anything in a process that keeps running, so on a
// serverless host it is skipped entirely rather than started in a function that is about to be
// frozen. (Rest-timer push still works there — that one is driven by a request.)
if (!SERVERLESS) setInterval(async () => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = await readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
// unref'd like the other timers here: a pending reminder check is not a reason to keep the
// process alive, and it is what lets this module be imported by a test that then exits.
}, 10000)?.unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user, req) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${secureFor(req)} SameSite=Lax`;
}
const clearCookieFor = req => `gymsid=; Path=/; Max-Age=0; HttpOnly;${secureFor(req)} SameSite=Lax`;

/* ---------- sign-in throttle (in-memory) ---------- */
// One shared password is one guessable secret, so a wrong answer has to cost the caller
// something. Per-instance and best-effort — a serverless deployment spreads attempts across
// instances — but the alternative is unlimited free guesses at a single password, which is the
// one attack this design invites.
const attempts = new Map();               // ip -> { n, until }
const LOCK_AFTER = 8;
const LOCK_MS = 60000;
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress || 'unknown';
const throttled = req => {
  const a = attempts.get(clientIp(req));
  return !!(a && a.n >= LOCK_AFTER && Date.now() < a.until);
};
function noteAttempt(req, ok) {
  const ip = clientIp(req);
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n++; a.until = Date.now() + LOCK_MS;
  attempts.set(ip, a);
}
setInterval(() => { for (const [k, v] of attempts) if (Date.now() > v.until + LOCK_MS) attempts.delete(k); }, 60000)?.unref();

/** Constant-time check. Both sides are hashed first so the compare is length-independent. */
function passwordOK(given) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  // Serverless runtimes commonly parse and consume the request stream before handing it over;
  // when they have, the stream is empty and `req.body` is the only copy. Under node:http this
  // is always undefined and the original path runs.
  if (req.body !== undefined && req.body !== null) {
    try { return Promise.resolve(typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : req.body); }
    catch { return Promise.reject(new Error('bad json')); }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
export const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    const coach = coachConfig ? coachConfig.publicConfig() : null;
    json(res, 200, { ...(coach ? { coach } : {}) });
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  // The list the sign-in screen is built from. Public by necessity — you have to be able to
  // pick your profile before you are signed in — and it deliberately carries nothing but a name
  // and an id. On an instance shared by friends that is the intended amount of exposure; if you
  // put this on the open internet, understand that the names are visible to anyone who loads it.
  'GET /api/profiles': async (req, res) => {
    json(res, 200, {
      profiles: db.users
        .filter(u => !u.disabled)
        .map(u => ({ id: u.id, name: u.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // Lets the client show "create the first profile" instead of an empty picker.
      empty: db.users.filter(u => !u.disabled).length === 0
    });
  },

  'POST /api/login': async (req, res) => {
    if (throttled(req)) return json(res, 429, { error: 'too many attempts — wait a minute' });
    const body = await readBody(req);
    const user = db.users.find(u => u.id === body.id);
    // One message for both a wrong password and an unknown profile: telling them apart would
    // turn the public profile list into a way to confirm which ids are real.
    const ok = !!user && !user.disabled && passwordOK(body.password);
    noteAttempt(req, ok);
    if (!ok) return json(res, 401, { error: 'wrong password' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } },
      { 'Set-Cookie': sessionCookie(user, req) });
  },

  // Adding a profile is something you do from inside — a friend hands you the phone, or you set
  // theirs up. The one exception is a brand-new instance: with no profiles there is nobody to
  // sign in as, so the password alone gets the first one made. Without that the app could never
  // be started at all.
  'POST /api/profiles': async (req, res) => {
    const body = await readBody(req);
    const signedIn = !!readSession(req);
    const bootstrapping = db.users.filter(u => !u.disabled).length === 0;
    if (!signedIn) {
      if (!bootstrapping) return json(res, 401, { error: 'sign in first to add a profile' });
      if (throttled(req)) return json(res, 429, { error: 'too many attempts — wait a minute' });
      const ok = passwordOK(body.password);
      noteAttempt(req, ok);
      if (!ok) return json(res, 401, { error: 'wrong password' });
    }
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    if (db.users.some(u => !u.disabled && u.name.toLowerCase() === name.toLowerCase()))
      return json(res, 409, { error: 'a profile with that name already exists' });
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, created: new Date().toISOString() };
    db.users.push(user);
    saveDb();
    // A profile created from inside does NOT sign the creator out of their own: they set it up
    // and hand the phone over, and whoever takes it signs in from the picker. Only the
    // bootstrap case takes the session, because there was nobody signed in to displace.
    const headers = signedIn ? undefined : { 'Set-Cookie': sessionCookie(user, req) };
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, headers);
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookieFor(req) }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Signing back in with the password works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookieFor(req) });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { state: (await readState(user.id)) ?? null });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    await store.writeState(user.id, body.state);
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // One read per user, in parallel: sequential awaits here would make the dashboard's
    // latency the sum of every profile on the instance.
    const users = await Promise.all(db.users.map(async u => {
      const S = (await readState(u.id)) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u),
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    }));
    json(res, 200, { users, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await readState(u.id)) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u) },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over db and SECRET, and passing them in keeps that module free of
  // a cycle. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin }),

  /* ---------- Teams ---------- */
  // Shared schemes + a shared view of everyone's training. Like the Coach routes these
  // are closures over db and the session helpers rather than importers of them.
  ...teamRoutes({ json, readBody, readSession, saveDb, db, readState, livePresence })
};

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
if (COACH) {
  // A job that was running when the process died is not coming back; say so rather than leaving
  // a spinner that never resolves.
  coachJobs.recoverOnBoot();
  // A ready proposal is the one Coach event worth a notification. Failures and "nothing to
  // change" stay silent on purpose (FR-38/E4).
  coachJobs.setProposalHook((uid, pending) => {
    const n = (pending?.changes || []).length;
    if (!n) return;
    sendPush(uid, {
      title: 'Your Coach has been reading',
      body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
      tag: 'coach-proposal', url: '#/coach'
    });
  });
  startCadence({ users: () => db.users, userNow });
}

/* ---------- request dispatch ---------- */
// Shared by both entry points so there is one definition of what a request means: the long-
// lived server below, and the serverless handler in index.js, which wraps this with a reload
// of the db before and a conflict-checked write after.
export async function dispatch(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}

// Only the long-lived deployment listens on a port. Under a serverless host this module is
// imported for its routes and nothing else, and binding a socket there would be an error.
// Exported so a test can shut it down; undefined when something else owns the socket.
export const server = SERVERLESS ? null
  : http.createServer(dispatch).listen(PORT, () => console.log(`gym-api on :${PORT} (origin=${ORIGIN})`));

export { reloadDb, flushDb, json };
