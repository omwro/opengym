// Warm-up sets, planned per exercise in a routine: each one is either a percentage of the
// working weight ("50 % × 10") or a fixed weight ("20 kg × 8"), and an exercise can have
// several, done in order before the working sets.
//
// They live apart from the working sets — `cfg.warmup` in the plan, `entry.warm` in a session
// — rather than as flagged rows inside `sets`. Everything that reads training back (progression
// and deloads, PRs, estimated 1RM, volume, set counts, the team feed) reads `sets`, and a warm-up
// is not training data for any of them: 50 % × 10 must never count as a missed set of 5.

import { weightStep } from './progression.js'

export const MAX_WARMUP = 6

const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)))
const round1 = v => Math.round(v * 10) / 10

/**
 * A plan's warm-up list, made safe: at most MAX_WARMUP entries, each `{ pct, reps }` (1–100 %)
 * or `{ w, reps }` (a fixed weight ≥ 0). Anything else is dropped, so a hand-edited or shared
 * plan file cannot put nonsense on the workout screen.
 */
export function normalizeWarmup(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const reps = int(x.reps, 1, 50)
    if (x.pct != null && Number(x.pct) > 0) out.push({ pct: int(x.pct, 1, 100), reps })
    else if (x.w != null && Number(x.w) >= 0) out.push({ w: Math.max(0, round1(Number(x.w))), reps })
    if (out.length >= MAX_WARMUP) break
  }
  return out
}

/**
 * The weight for one warm-up set. A percentage is taken of the working weight and rounded to
 * something you can load (the exercise's plate or dumbbell step), and never ends up above the
 * working weight itself. A fixed weight is used as written.
 */
export function warmupWeight(item, workW, step) {
  if (item.pct == null) return item.w || 0
  const raw = Math.max(0, workW || 0) * item.pct / 100
  const snapped = step > 0 ? round1(Math.round(raw / step) * step) : round1(raw)
  return Math.max(0, Math.min(snapped, workW || 0))
}

/** The warm-up sets for a session, from the plan and the working weight it will use. */
export function buildWarm(cfg, workW, step) {
  return normalizeWarmup(cfg && cfg.warmup).map(item => ({
    w: warmupWeight(item, workW, step), r: item.reps, done: false,
    // Kept so the set follows the working weight if that changes before it is done.
    ...(item.pct != null ? { pct: item.pct } : {})
  }))
}

/**
 * The working weight moved (typed in, or the prescription changed): percentage warm-ups that
 * are not done yet move with it. Done ones are history; fixed ones were never relative.
 */
export function refreshWarm(warm, workW, step) {
  return (warm || []).map(s => (s.done || s.pct == null ? s : { ...s, w: warmupWeight(s, workW, step) }))
}

/** The working weight a session's warm-ups are relative to: the first working set's. */
export const workingWeight = sets => (sets && sets.length ? sets[0].w || 0 : 0)

/** Warm-up sets for a freshly built session entry. */
export function warmFor(cfg, sets, exId, unit) {
  return buildWarm(cfg, workingWeight(sets), weightStep(exId, unit))
}

/** "50 % × 10" / "20 kg × 8" — one planned warm-up, for the plan screens. */
export const warmupText = (item, unit) => (item.pct != null ? `${item.pct} % × ${item.reps}` : `${item.w} ${unit} × ${item.reps}`)

/* ---------- added during a workout ---------- */

/**
 * The next warm-up set to add mid-workout, on the same ramp the plan editor suggests:
 * 50 % × 10, then 70 % × 5, then 85 % × 3 and closer — each a percentage of the working weight
 * so it follows it like a planned one. Marked `added` so the finish can offer to keep it.
 */
export function nextWarm(warm, workW, step) {
  const list = warm || []
  const last = list[list.length - 1]
  const pct = !last ? 50 : last.pct != null ? Math.min(95, last.pct + (last.pct < 70 ? 20 : 15)) : 70
  const r = !last ? 10 : Math.max(1, (last.r || 5) - ((last.r || 5) > 5 ? 5 : 2))
  return { w: warmupWeight({ pct }, workW, step), r, done: false, pct, added: true }
}

/** A session's warm-up sets as a plan: a percentage where it still followed the work, else the weight. */
export const warmToPlan = warm => normalizeWarmup((warm || []).map(s => (s.pct != null ? { pct: s.pct, reps: s.r } : { w: s.w, reps: s.r })))

/**
 * The warm-ups worth offering to keep after a workout: exercises from the routine (not a stand-in
 * swapped in for the day) where warm-up sets were added, changed or removed during the session
 * (`added` on a set, `warmEdited` on the entry).
 * [{ exId, warmup }] — `warmup` replaces what the routine had for that exercise.
 */
export function warmupsToSave(A, routine) {
  if (!A || !routine) return []
  const inPlan = new Set((routine.ex || []).map(e => e.id))
  return (A.entries || [])
    .filter(e => inPlan.has(e.id) && !e.swappedFrom && (e.warmEdited || (e.warm || []).some(s => s.added)))
    .map(e => ({ exId: e.id, warmup: warmToPlan(e.warm) }))
    .filter(x => x.warmup.length)
}
