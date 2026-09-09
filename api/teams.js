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

const MAX_PLANS = 30;
const NAME_MAX = 40;
const DEFAULT_NAME = 'The team';

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
        id: w.id, d: w.d, name: w.name || null,
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

export function teamRoutes({ json, readBody, readSession, saveDb, db, readState, livePresence }) {
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

  const publicTeam = async (team, user) => ({
    name: team.name,
    createdAt: team.createdAt,
    members: await Promise.all(memberUsers().map(async u => {
      const live = livePresence(u.id);
      return {
        id: u.id, name: u.name, you: u.id === user.id,
        live: live ? { exIdx: live.exIdx, exTotal: live.exTotal, setsDone: live.setsDone, setsTotal: live.setsTotal, startedAt: live.startedAt } : null,
        ...summarize(await readState(u.id))
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
          ...summarize(st),
          // Enough for the charts on a member page, and nothing that isn't training:
          // no settings, no push subscriptions, no Coach state.
          history: (st.workouts || []).slice(-120),
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

export const _internals = { summarize, weekKey, feed };
