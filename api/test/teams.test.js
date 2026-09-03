/* Teams: membership, the shared view of progress, and shared schemes.
   The routes are pure closures over the injected db/state helpers, so they can be exercised
   without a socket — which is what makes them equally mountable on the serverless entry. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { teamRoutes, _internals } from '../teams.js';
import { sampleState } from './helpers.mjs';

/* ---------------- harness ---------------- */
function harness() {
  const db = { users: [], creds: [], subs: [], invites: [], teams: [] };
  const states = new Map();
  let saves = 0;
  const ctx = {
    db, states,
    add(id, name, state) { db.users.push({ id, name }); if (state) states.set(id, state); return db.users.at(-1); },
    saves: () => saves
  };
  let caller = null;
  ctx.as = u => { caller = u; return ctx; };
  ctx.routes = teamRoutes({
    db,
    json: (res, code, obj) => { res.code = code; res.body = obj; },
    readBody: async req => req.body || {},
    readSession: () => caller,
    saveDb: () => { saves++; },
    readState: uid => states.get(uid) || null,
    livePresence: uid => states.get(uid)?._live || null
  });
  ctx.call = async (route, body, query) => {
    const res = {};
    await ctx.routes[route]({ body, url: '/x' + (query ? '?' + query : ''), headers: {} }, res);
    return res;
  };
  return ctx;
}

const iso = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/* ---------------- membership ---------------- */

test('a profile with no team is asked to make one, not handed an error', async () => {
  const h = harness(); const u = h.add('u1', 'Ann');
  const res = await h.as(u).call('GET /api/team');
  assert.equal(res.code, 200);
  assert.equal(res.body.team, null);
});

test('creating a team puts you in it as the founder, with a code to hand out', async () => {
  const h = harness(); const u = h.add('u1', 'Ann');
  const res = await h.as(u).call('POST /api/team/create', { name: 'Iron Club' });
  assert.equal(res.code, 200);
  assert.equal(res.body.team.name, 'Iron Club');
  assert.match(res.body.team.code, /^[A-Z0-9]{6}$/);
  assert.equal(res.body.team.members.length, 1);
  assert.equal(res.body.team.members[0].founder, true);
  assert.equal(u.teamId, res.body.team.id);
});

test('a join code is read off a phone screen, so it is matched loosely', async () => {
  const h = harness(); const a = h.add('u1', 'Ann'); const b = h.add('u2', 'Ben');
  const { body } = await h.as(a).call('POST /api/team/create', { name: 'Iron Club' });
  const code = body.team.code;
  const res = await h.as(b).call('POST /api/team/join', { code: ' ' + code.toLowerCase().slice(0, 3) + '-' + code.slice(3) + ' ' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.team.members.map(m => m.name).sort(), ['Ann', 'Ben']);
});

test('a wrong code joins nothing', async () => {
  const h = harness(); const a = h.add('u1', 'Ann');
  const res = await h.as(a).call('POST /api/team/join', { code: 'ZZZZZZ' });
  assert.equal(res.code, 404);
  assert.equal(a.teamId, undefined);
});

test('joining a second team leaves the first — a profile is in one team', async () => {
  const h = harness(); const a = h.add('u1', 'Ann'); const b = h.add('u2', 'Ben');
  const one = (await h.as(a).call('POST /api/team/create', { name: 'One' })).body.team;
  const two = (await h.as(b).call('POST /api/team/create', { name: 'Two' })).body.team;
  await h.as(a).call('POST /api/team/join', { code: two.code });
  assert.equal(a.teamId, two.id);
  assert.equal(h.db.teams.find(t => t.id === one.id), undefined, 'the emptied team is not left holding its code');
});

test('the last member leaving disbands the team; others leaving does not', async () => {
  const h = harness(); const a = h.add('u1', 'Ann'); const b = h.add('u2', 'Ben');
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  await h.as(b).call('POST /api/team/join', { code: t.code });
  await h.as(b).call('POST /api/team/leave');
  assert.equal(h.db.teams.length, 1);
  assert.equal(b.teamId, undefined);
  await h.as(a).call('POST /api/team/leave');
  assert.equal(h.db.teams.length, 0);
});

test('team endpoints are closed to anyone not in the team', async () => {
  const h = harness(); const a = h.add('u1', 'Ann'); const out = h.add('u9', 'Zoe');
  await h.as(a).call('POST /api/team/create', { name: 'Iron' });
  for (const route of ['GET /api/team/feed', 'POST /api/team/plans', 'GET /api/team/member']) {
    const res = await h.as(out).call(route, { bundle: { routines: [] } });
    assert.equal(res.code, 404, route + ' must not serve a non-member');
  }
  const anon = await h.as(null).call('GET /api/team');
  assert.equal(anon.code, 401);
});

/* ---------------- shared progress ---------------- */

test("every member's training is summarized from their own state, never copied into the team", async () => {
  const h = harness();
  const a = h.add('u1', 'Ann', sampleState({
    workouts: [
      { id: 'w1', d: iso(2), vol: 1000, prs: ['0001'], entries: [{ id: '0001', sets: [{ done: true }, { done: true }] }] },
      { id: 'w2', d: iso(40), vol: 500, prs: [], entries: [] }
    ]
  }));
  const b = h.add('u2', 'Ben', sampleState({ unit: 'lb', workouts: [], bodyweight: [{ d: iso(1), w: 180 }] }));
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  await h.as(b).call('POST /api/team/join', { code: t.code });

  const res = await h.as(a).call('GET /api/team');
  const ann = res.body.team.members.find(m => m.name === 'Ann');
  const ben = res.body.team.members.find(m => m.name === 'Ben');
  assert.equal(ann.workouts, 2);
  assert.equal(ann.week, 1, 'only the session inside the last 7 days counts to this week');
  assert.equal(ann.vol7, 1000);
  assert.equal(ann.vol30, 1000, 'the 40-day-old session is outside the 30-day window');
  assert.equal(ann.prs30, 1);
  assert.equal(ann.you, true);
  assert.equal(ben.you, false);
  assert.equal(ben.unit, 'lb', "a member's numbers carry the unit they were logged in");
  assert.equal(ben.workouts, 0);
  assert.deepEqual(ben.bw, { d: iso(1), w: 180 });
  // No team record holds anyone's sessions.
  assert.equal(JSON.stringify(h.db.teams).includes('"w1"'), false);
});

test('"last trained" is the newest session, not the last one in the array', async () => {
  // An imported history (FitNotes, Strong, Hevy) arrives in whatever order the export had.
  const h = harness();
  const a = h.add('u1', 'Ann', sampleState({ workouts: [
    { id: 'new', d: iso(1), vol: 100, entries: [] },
    { id: 'old', d: iso(90), vol: 100, entries: [] }
  ] }));
  await h.as(a).call('POST /api/team/create', { name: 'Iron' });
  const { body } = await h.as(a).call('GET /api/team');
  assert.equal(body.team.members[0].last, iso(1));

  const page = await h.as(a).call('GET /api/team/member', null, 'id=u1');
  assert.deepEqual(page.body.member.history.map(w => w.id), ['new', 'old'], 'a member page reads newest first');
});

test('the feed interleaves the whole team, newest first, and names who trained', async () => {
  const h = harness();
  const a = h.add('u1', 'Ann', sampleState({ workouts: [
    { id: 'a1', d: iso(3), name: 'Push', vol: 900, prs: [], entries: [{ id: '1', sets: [{ done: true }, { done: false }] }] }
  ] }));
  const b = h.add('u2', 'Ben', sampleState({ workouts: [
    { id: 'b1', d: iso(1), name: 'Pull', vol: 800, prs: ['0002'], start: 0, end: 40 * 60000, entries: [{ id: '2', sets: [{ done: true }] }] }
  ] }));
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  await h.as(b).call('POST /api/team/join', { code: t.code });

  const { body } = await h.as(a).call('GET /api/team/feed');
  assert.deepEqual(body.feed.map(f => f.who), ['Ben', 'Ann']);
  assert.equal(body.feed[0].sets, 1);
  assert.equal(body.feed[0].min, 40);
  assert.deepEqual(body.feed[0].prs, ['0002']);
  assert.equal(body.feed[1].sets, 1, 'sets that were never completed are not counted');
});

test("a member page carries training and nothing else — no settings, no push, no coach", async () => {
  const h = harness();
  const a = h.add('u1', 'Ann', sampleState());
  const b = h.add('u2', 'Ben', sampleState({ coach: { consent: { agreedAt: 'x' } }, reminder: { on: true } }));
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  await h.as(b).call('POST /api/team/join', { code: t.code });
  const { body } = await h.as(a).call('GET /api/team/member', null, 'id=u2');
  assert.equal(body.member.name, 'Ben');
  assert.equal(body.member.history.length, 1);
  assert.equal('coach' in body.member, false);
  assert.equal('reminder' in body.member, false);
});

/* ---------------- shared schemes ---------------- */

const bundle = () => ({ opengym_plan: 1, name: 'PPL', week: { 1: 'r1', 3: 'r1' }, routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0001', sets: 3, reps: 8 }] }], customEx: [] });

test('publishing a scheme shares the plan and only the plan', async () => {
  const h = harness();
  const a = h.add('u1', 'Ann', sampleState());
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  const res = await h.as(a).call('POST /api/team/plans', { name: 'PPL 3-day', note: 'start light', bundle: bundle() });
  assert.equal(res.code, 200);
  const [p] = res.body.team.plans;
  assert.equal(p.name, 'PPL 3-day');
  assert.equal(p.byName, 'Ann');
  assert.equal(p.routines, 1);
  assert.equal(p.days, 2);
  assert.equal('bundle' in p, false, 'the list stays small; the bundle is fetched on open');
  const full = await h.as(a).call('GET /api/team/plan', null, 'id=' + p.id);
  assert.deepEqual(full.body.plan.bundle, bundle());
});

test('a scheme without routines is refused', async () => {
  const h = harness(); const a = h.add('u1', 'Ann');
  await h.as(a).call('POST /api/team/create', { name: 'Iron' });
  assert.equal((await h.as(a).call('POST /api/team/plans', { name: 'x' })).code, 400);
});

test('any member can revise a shared scheme in place, keeping its id', async () => {
  const h = harness();
  const a = h.add('u1', 'Ann'); const b = h.add('u2', 'Ben');
  const t = (await h.as(a).call('POST /api/team/create', { name: 'Iron' })).body.team;
  await h.as(b).call('POST /api/team/join', { code: t.code });
  const p = (await h.as(a).call('POST /api/team/plans', { name: 'PPL', bundle: bundle() })).body.team.plans[0];

  const next = bundle(); next.routines.push({ id: 'r2', name: 'Legs', ex: [] });
  const res = await h.as(b).call('POST /api/team/plans/update', { id: p.id, bundle: next, note: 'added legs' });
  assert.equal(res.code, 200);
  const after = res.body.team.plans;
  assert.equal(after.length, 1, 'revising is not a second copy');
  assert.equal(after[0].id, p.id);
  assert.equal(after[0].routines, 2);
  assert.equal(after[0].byName, 'Ben', 'the scheme says who touched it last');
  assert.equal(after[0].note, 'added legs');
});

test('removing a scheme takes only that one', async () => {
  const h = harness(); const a = h.add('u1', 'Ann');
  await h.as(a).call('POST /api/team/create', { name: 'Iron' });
  const one = (await h.as(a).call('POST /api/team/plans', { name: 'A', bundle: bundle() })).body.team.plans[0];
  await h.as(a).call('POST /api/team/plans', { name: 'B', bundle: bundle() });
  const res = await h.as(a).call('POST /api/team/plans/remove', { id: one.id });
  assert.deepEqual(res.body.team.plans.map(p => p.name), ['B']);
});

/* ---------------- internals ---------------- */

test('the week key agrees with the client: Monday-first, so a Sunday and a Monday differ', () => {
  const { weekKey } = _internals;
  assert.equal(weekKey('2026-08-31'), '2026-08-31');            // a Monday
  assert.equal(weekKey('2026-09-06'), '2026-08-31');            // the Sunday that closes it
  assert.equal(weekKey('2026-09-07'), '2026-09-07');            // the next Monday
});
