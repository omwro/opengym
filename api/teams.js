/* Teams — shared workout schemes and a shared view of everyone's progress.
 *
 * Injected with the same closures the Coach routes get (db, saveDb, readState,
 * readSession, livePresence) rather than importing them, so this module stays free of a
 * cycle with server.js and can be mounted unchanged on the serverless entry point.
 *
 * Model: there is exactly one team and everyone on the instance is in it. No codes, no
 * joining, no leaving — for a handful of friends on a server they share, the whole concept of
 * membership was ceremony around a set that was always "everybody". Creating a profile is
 * joining. Membership is symmetric and total: every member sees every other member's training,
 * and any member may publish or edit a shared scheme.
 *
 * The team never stores workouts of its own. Progress is derived on read from each member's
 * own state blob, so there is exactly one copy of anyone's training.
 */
import crypto from 'node:crypto';
import { effortWeeks } from './effort.js';

const MAX_PLANS = 30;
const NOTE_MAX = 500;
const NAME_MAX = 40;
const DEFAULT_NAME = 'The team';
// "Wake him up!": a push to a teammate who has gone quiet. Only once they have avoided the gym
// for six days — home sessions do not count — the same moment the client's loud nudge appears — and at most once per
// 12 hours per person, from anyone, so a whole team cannot take turns spamming one phone.
const POKE_AFTER_DAYS = 6;
const POKE_COOLDOWN_MS = 12 * 3600000;

const dayMs = 86400000;
const isoOf = d => new Date(d).toISOString().slice(0, 10);
const daysAgoISO = n => isoOf(Date.now() - n * dayMs);

/* ---------- progress, derived from a member's own state ---------- */

/** Everything the team screen shows about one member, from their state blob. */
function summarize(state) {
  const workouts = (state?.workouts || []);
  const bw = (state?.bodyweight || []);
  const last30 = daysAgoISO(30), last7 = daysAgoISO(7);
  const recent = workouts.filter(w => w.d >= last30);
  const vol = list => Math.round(list.reduce((n, w) => n + (w.vol || 0), 0));
  // Weeks are counted back from this week, so a member who trains Sunday-only and one who
  // trains Monday-only both read as "on a streak" on a Wednesday.
  const weeks = new Set(workouts.map(w => weekKey(w.d)));
  let streak = 0;
  for (let i = 0; i < 520; i++) {
    const k = weekKey(daysAgoISO(i * 7));
    if (weeks.has(k)) streak++;
    else if (i > 0) break;
  }
  return {
    workouts: workouts.length,
    // Max, not the last element: an imported history (FitNotes, Strong, Hevy) arrives in
    // whatever order the export had, and "last trained" is the one field that would then be
    // quietly wrong on every screen it appears on.
    last: workouts.reduce((m, w) => (!m || w.d > m ? w.d : m), null),
    // What "Avoided the gym for N days" counts from: the last workout that was not a home
    // session. Someone who has only ever trained at home has been avoiding it since their
    // first logged session. null only for a profile that has logged nothing at all.
    avoidSince: workouts.filter(w => !w.home).reduce((m, w) => (!m || w.d > m ? w.d : m), null)
      || workouts.reduce((m, w) => (!m || w.d < m ? w.d : m), null),
    // When the last gym workout (not a home session) ended, in ms — the team-wide "nobody gymed
    // for N hours" counts in hours, which a date alone cannot give. A workout without an end
    // time (an old import) counts as noon on its day. null when there is none.
    lastGymAt: workouts.filter(w => !w.home).reduce((m, w) => {
      const at = Number.isFinite(w.end) ? w.end : Date.parse(w.d + 'T12:00:00Z');
      return Number.isFinite(at) && (m == null || at > m) ? at : m;
    }, null),
    week: workouts.filter(w => w.d >= last7).length,
    vol7: vol(workouts.filter(w => w.d >= last7)),
    vol30: vol(recent),
    streak,
    prs30: recent.reduce((n, w) => n + (w.prs?.length || 0), 0),
    // Unit travels with the number: a team can mix kg and lb profiles and the screen must
    // not add them together or relabel someone's weights.
    unit: state?.unit === 'lb' ? 'lb' : 'kg',
    bw: bw.length ? bw[bw.length - 1] : null
  };
}

function weekKey(iso) {
  // ISO week, Monday-first — matches the client's streakWeeks so both ends agree.
  const d = new Date(iso + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** The team feed: recent sessions from every member, newest first. */
async function feed(members, readState, limit) {
  const items = [];
  // Read every member in parallel — one after another would make the feed as slow as the
  // team is large on any backend where a read is a round trip.
  const states = await Promise.all(members.map(m => readState(m.id)));
  for (let i = 0; i < members.length; i++) {
    const m = members[i], st = states[i];
    for (const w of (st?.workouts || [])) {
      items.push({
        uid: m.id, who: m.name,
        id: w.id, d: w.d, name: w.name || null, home: !!w.home,
        vol: Math.round(w.vol || 0), unit: st?.unit === 'lb' ? 'lb' : 'kg',
        sets: (w.entries || []).reduce((n, e) => n + (e.sets || []).filter(s => s.done).length, 0),
        exercises: (w.entries || []).length,
        // Number checks, not truthiness: a session whose clock starts at 0 is still 40 minutes long.
        min: Number.isFinite(w.start) && Number.isFinite(w.end) ? Math.round((w.end - w.start) / 60000) : null,
        prs: w.prs || [],
        // end is the only wall-clock stamp a finished session carries; d orders the rest.
        at: w.end || null
      });
    }
  }
  items.sort((a, b) => (b.d === a.d ? (b.at || 0) - (a.at || 0) : (b.d < a.d ? -1 : 1)));
  return items.slice(0, limit);
}

/** Days since a member's last workout date, or null for someone who never logged one. */
const daysSinceISO = last => (last ? Math.round((Date.parse(isoOf(Date.now())) - Date.parse(last)) / dayMs) : null);

export function teamRoutes({ json, readBody, readSession, saveDb, db, readState, livePresence, sendPush = async () => [] }) {
  /**
   * The one team. Created on first read rather than at boot, so a fresh instance carries no
   * team record until somebody actually looks.
   *
   * Also migrates the previous shape: teams used to be a list you joined with a code, and an
   * instance upgraded in place would otherwise silently lose the schemes published under it.
   */
  function theTeam() {
    if (!db.team) {
      const old = Array.isArray(db.teams) ? db.teams : [];
      const carried = old.flatMap(t => t.plans || []);
      db.team = {
        name: old.find(t => t.name)?.name || DEFAULT_NAME,
        plans: carried,
        createdAt: old[0]?.createdAt || Date.now()
      };
      delete db.teams;
      // Membership used to live on the user record; it is now implied by existing.
      for (const u of db.users) delete u.teamId;
      saveDb();
    }
    db.team.plans = db.team.plans || [];
    return db.team;
  }

  // Everyone on the instance, minus anyone an admin has disabled.
  const memberUsers = () => db.users.filter(u => !u.disabled);

  /** Resolve the caller. Writes the error response itself. */
  function requireUser(req, res) {
    const user = readSession(req);
    if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
    return { user, team: theTeam() };
  }

  // The last poke on someone, for the button's cooldown: who and when, nothing more.
  const pokeOf = (team, uid) => {
    const p = team.pokes?.[uid];
    return p && Date.now() - p.at < POKE_COOLDOWN_MS ? { byName: p.byName, at: p.at, next: p.at + POKE_COOLDOWN_MS } : null;
  };

  const publicTeam = async (team, user) => ({
    name: team.name,
    createdAt: team.createdAt,
    members: await Promise.all(memberUsers().map(async u => {
      const live = await livePresence(u.id);
      const state = await readState(u.id);
      return {
        id: u.id, name: u.name, you: u.id === user.id,
        live: live ? { exIdx: live.exIdx, exTotal: live.exTotal, setsDone: live.setsDone, setsTotal: live.setsTotal, startedAt: live.startedAt, updatedAt: live.updatedAt } : null,
        poke: pokeOf(team, u.id),
        // the last eight weeks of effort scores, for the team chart (effort.js)
        effort: effortWeeks(state),
        ...summarize(state)
      };
    })),
    plans: (team.plans || []).map(p => ({
      id: p.id, name: p.name, note: p.note || '', by: p.by, byName: p.byName, at: p.at,
      routines: (p.bundle?.routines || []).length,
      days: Object.keys(p.bundle?.week || {}).length
    }))
  });

  return {
    // Everyone, with their progress. There is no "you have no team yet" state to handle.
    'GET /api/team': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      json(res, 200, { team: await publicTeam(ctx.team, ctx.user) });
    },

    'POST /api/team/rename': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, NAME_MAX);
      if (!name) return json(res, 400, { error: 'name required' });
      ctx.team.name = name;
      saveDb();
      json(res, 200, { team: await publicTeam(ctx.team, ctx.user) });
    },

    // Recent sessions across the whole team, newest first.
    'GET /api/team/feed': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const url = new URL(req.url, 'http://x');
      const limit = Math.min(200, Math.max(1, +url.searchParams.get('limit') || 60));
      json(res, 200, { feed: await feed(memberUsers(), readState, limit) });
    },

    // Publish a scheme to the team. The body is the same bundle the existing plan-share
    // file carries, so a shared scheme and a shared file are the same thing at both ends —
    // routines, the week schedule and the custom exercises they reference. Never workouts.
    'POST /api/team/plans': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const bundle = body.bundle;
      if (!bundle || !Array.isArray(bundle.routines)) return json(res, 400, { error: 'a plan is required' });
      const name = String(body.name || '').trim().slice(0, NAME_MAX) || (ctx.user.name + "'s plan");
      const plans = ctx.team.plans;
      if (plans.length >= MAX_PLANS) return json(res, 409, { error: 'too many plans — delete one first' });
      plans.push({
        id: crypto.randomBytes(9).toString('base64url'),
        name, note: String(body.note || '').trim().slice(0, 200),
        by: ctx.user.id, byName: ctx.user.name, at: Date.now(),
        bundle
      });
      saveDb();
      json(res, 200, { team: await publicTeam(ctx.team, ctx.user) });
    },

    // The full bundle for one plan — fetched only when someone opens or imports it, so the
    // team screen itself stays small however many schemes are on it.
    'GET /api/team/plan': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const plan = ctx.team.plans.find(p => p.id === id);
      if (!plan) return json(res, 404, { error: 'no such plan' });
      json(res, 200, { plan });
    },

    // Replace a published scheme in place, keeping its id, so members who already took it
    // are looking at the same plan rather than a second copy of it.
    'POST /api/team/plans/update': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const plan = ctx.team.plans.find(p => p.id === body.id);
      if (!plan) return json(res, 404, { error: 'no such plan' });
      if (body.bundle) {
        if (!Array.isArray(body.bundle.routines)) return json(res, 400, { error: 'a plan is required' });
        plan.bundle = body.bundle;
      }
      if (body.name != null) plan.name = String(body.name).trim().slice(0, NAME_MAX) || plan.name;
      if (body.note != null) plan.note = String(body.note).trim().slice(0, 200);
      plan.at = Date.now();
      plan.byName = ctx.user.name;
      plan.by = ctx.user.id;
      saveDb();
      json(res, 200, { team: await publicTeam(ctx.team, ctx.user) });
    },

    'POST /api/team/plans/remove': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      ctx.team.plans = ctx.team.plans.filter(p => p.id !== body.id);
      saveDb();
      json(res, 200, { team: await publicTeam(ctx.team, ctx.user) });
    },

    /* ---------- shared notes per exercise ----------
     * One note per exercise, for the whole team: which handle on the cable, which machine in
     * which gym, seat on 4. It is about the equipment, not a person's training, which is why it
     * lives on the team and not in anyone's own state — and why anyone may edit it. Who wrote it
     * last travels with it so a surprising change can be asked about. */
    'GET /api/team/notes': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      json(res, 200, { notes: ctx.team.notes || {} });
    },

    'POST /api/team/notes': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const exId = String(body.exId || '').trim().slice(0, 64);
      if (!exId) return json(res, 400, { error: 'exercise required' });
      const text = String(body.text ?? '').trim().slice(0, NOTE_MAX);
      const notes = (ctx.team.notes = ctx.team.notes || {});
      // Emptying a note removes it, rather than leaving a blank one with somebody's name on it.
      if (!text) delete notes[exId];
      else notes[exId] = { text, by: ctx.user.id, byName: ctx.user.name, at: Date.now() };
      saveDb();
      json(res, 200, { notes });
    },

    // Follow a teammate's workout while it is happening: where they are and every set so far.
    // The team list carries only the summary; this is polled by the screen that follows them.
    'GET /api/team/live': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const u = memberUsers().find(x => x.id === id);
      if (!u) return json(res, 404, { error: 'no such member' });
      const live = await livePresence(u.id);
      const st = live ? ((await readState(u.id)) || {}) : {};
      json(res, 200, {
        member: { id: u.id, name: u.name, unit: st.unit === 'lb' ? 'lb' : 'kg', customEx: st.customEx || [] },
        live
      });
    },

    // One session in full — every exercise and every set — for a row tapped in the activity
    // feed. The feed itself stays a list of summaries; the detail is fetched only when opened.
    'GET /api/team/workout': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const q = new URL(req.url, 'http://x').searchParams;
      const u = memberUsers().find(x => x.id === q.get('uid'))
      if (!u) return json(res, 404, { error: 'no such member' });
      const st = (await readState(u.id)) || {};
      const w = (st.workouts || []).find(x => x.id === q.get('id'));
      if (!w) return json(res, 404, { error: 'no such workout' });
      json(res, 200, {
        workout: w,
        // what the detail view needs to read it right: their unit and their own exercises
        member: { id: u.id, name: u.name, unit: st.unit === 'lb' ? 'lb' : 'kg', customEx: st.customEx || [] }
      });
    },

    // Wake a quiet teammate up with a push. Refused for yourself, for someone who trained in
    // the last six days (or never has — new is not missing), and inside the 12-hour cooldown.
    // A poke that reached no device does not count: the cooldown is only spent once a push
    // service has actually taken it, so "they have notifications off" can be said and retried.
    'POST /api/team/poke': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const body = await readBody(req);
      const u = memberUsers().find(x => x.id === body.id);
      if (!u) return json(res, 404, { error: 'no such member' });
      if (u.id === ctx.user.id) return json(res, 400, { error: 'you cannot wake yourself up' });
      const days = daysSinceISO(summarize(await readState(u.id)).avoidSince);
      if (days == null || days < POKE_AFTER_DAYS) return json(res, 400, { error: 'not inactive long enough', days });
      const prev = pokeOf(ctx.team, u.id);
      if (prev) return json(res, 429, { error: 'already woken up recently', poke: prev });
      const results = await sendPush(u.id, {
        title: '⏰ Wake up!',
        body: `${ctx.user.name} probeert je wakker te maken! Avoided the gym for ${days} days 💤`,
        tag: 'poke',
        url: '#/home'
      }, { ttl: 12 * 3600 });
      const delivered = results.some(r => r.ok);
      if (delivered) {
        ctx.team.pokes = ctx.team.pokes || {};
        ctx.team.pokes[u.id] = { by: ctx.user.id, byName: ctx.user.name, at: Date.now() };
        saveDb();
      }
      json(res, 200, { ok: delivered, devices: results.length, poke: pokeOf(ctx.team, u.id) });
    },

    // One member's training in full, for the profile screen behind a name in the feed.
    'GET /api/team/member': async (req, res) => {
      const ctx = requireUser(req, res); if (!ctx) return;
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      const u = memberUsers().find(x => x.id === id);
      if (!u) return json(res, 404, { error: 'no such member' });
      const st = (await readState(id)) || {};
      json(res, 200, {
        member: {
          id: u.id, name: u.name, you: u.id === ctx.user.id,
          poke: pokeOf(ctx.team, u.id),
          ...summarize(st),
          // Enough for the charts on a member page, and nothing that isn't training:
          // no settings, no push subscriptions, no Coach state.
          // Newest first, by date — not by position in the array, which follows the order
          // sessions were synced in and is not guaranteed to be chronological.
          history: [...(st.workouts || [])]
            .sort((a, b) => (b.d === a.d ? (b.end || 0) - (a.end || 0) : b.d < a.d ? -1 : 1))
            .slice(0, 120),
          bodyweight: (st.bodyweight || []).slice(-365),
          exWeights: st.exWeights || {},
          customEx: st.customEx || [],
          week: st.week || {},
          routines: st.routines || []
        }
      });
    }
  };
}

export const _internals = { summarize, weekKey, feed, POKE_AFTER_DAYS, POKE_COOLDOWN_MS };
