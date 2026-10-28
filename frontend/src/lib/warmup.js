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
