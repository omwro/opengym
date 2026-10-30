import test from 'node:test';
import assert from 'node:assert/strict';
import { weekScore, effortWeeks, weekOf, EFFORT_WEEKS } from '../effort.js';

const WK = '2026-10-26';                        // a Monday
const set = (w, r, extra = {}) => ({ w, r, done: true, ...extra });
const wo = (d, entries, extra = {}) => ({ id: d + Math.random(), d, entries, ...extra });
const ex = (id, sets, target = { mode: 'reps', reps: 5 }) => ({ id, target, sets });

test('weekOf gives the Monday', () => {
  assert.equal(weekOf('2026-10-30'), '2026-10-26');
  assert.equal(weekOf('2026-10-26'), '2026-10-26');
  assert.equal(weekOf('2026-11-01'), '2026-10-26');
});

test('showing up is measured against your own plan, 3 sessions when there is none', () => {
  const two = { workouts: [wo('2026-10-27', []), wo('2026-10-29', [])] };
  assert.equal(weekScore(two, WK).show, 67);                                  // 2 of 3
  assert.equal(weekScore({ ...two, week: { 1: 'a', 4: 'b' } }, WK).show, 100); // planned 2, did 2
  assert.equal(weekScore({ workouts: [] }, WK).score, 0);
});

test('hard sets: rated sets by RIR/RPE, unrated by reaching the target', () => {
  const s = { week: { 1: 'a' }, workouts: [wo('2026-10-27', [ex('x', [
    set(100, 5, { rir: 1 }),      // hard
    set(100, 5, { rpe: 7 }),      // easy
    set(100, 5),                  // target 5 reached: hard
    set(100, 3)                   // missed: not hard
  ])])] };
  assert.equal(weekScore(s, WK).hard, 50);                                     // 2 of 4
});

test('progress compares each exercise with your own best before this week', () => {
  const s = { week: { 1: 'a' }, workouts: [
    wo('2026-10-20', [ex('bench', [set(60, 5)]), ex('pullup', [set(0, 8)], { mode: 'reps' })]),
    wo('2026-10-27', [ex('bench', [set(62.5, 5)]), ex('pullup', [set(0, 7)], { mode: 'reps' }), ex('new', [set(20, 10)])])
  ] };
  // bench improved, pull-ups did not, a first-time exercise is not compared
  assert.equal(weekScore(s, WK).prog, 50);                                     // 1 of 2
});

test('a beginner and a veteran with the same effort score the same', () => {
  const athlete = w => ({ week: { 1: 'a', 3: 'b', 5: 'c' }, workouts: [
    wo('2026-10-19', [ex('sq', [set(w, 5)])]),
    ...['2026-10-26', '2026-10-28', '2026-10-30'].map(d => wo(d, [ex('sq', [set(w * 1.05, 5, { rir: 1 })])]))
  ] });
  assert.deepEqual(
    (({ score, show, hard, prog }) => ({ score, show, hard, prog }))(weekScore(athlete(40), WK)),
    (({ score, show, hard, prog }) => ({ score, show, hard, prog }))(weekScore(athlete(180), WK)));
  assert.equal(weekScore(athlete(40), WK).score, 100);
});

test('warm-ups never count', () => {
  const s = { week: { 1: 'a' }, workouts: [wo('2026-10-27', [{ id: 'x', target: { mode: 'reps', reps: 5 }, sets: [set(100, 5, { rir: 1 })], warm: [set(40, 10)] }])] };
  assert.equal(weekScore(s, WK).hard, 100);
});

test('effortWeeks: the last eight weeks, oldest first, ending this week', () => {
  const w = effortWeeks({ workouts: [] }, Date.parse('2026-10-30T12:00:00Z'));
  assert.equal(w.length, EFFORT_WEEKS);
  assert.equal(w.at(-1).wk, '2026-10-26');
  assert.equal(w[0].wk, '2026-09-07');
});

test('the score is the plain average of the three percentages', () => {
  const s = { week: { 1: 'a', 3: 'b', 5: 'c' }, workouts: [
    wo('2026-10-20', [ex('bench', [set(60, 5)])]),
    wo('2026-10-27', [ex('bench', [set(62.5, 5, { rir: 1 }), set(62.5, 5, { rir: 4 })])])
  ] };
  const w = weekScore(s, WK);
  assert.deepEqual([w.show, w.hard, w.prog], [33, 50, 100]);
  assert.equal(w.score, Math.round((100 / 3 + 50 + 100) / 3));          // 61
});
