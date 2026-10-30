/* Effort score — a week's training scored 0–100 against the member's *own* plan and history,
 * so a beginner and a veteran compete on the same scale. Raw numbers (kilos, volume) never
 * enter it: those always favour whoever is strongest. Three parts:
 *
 *   show 40  sessions this week against the days they planned (3 when they plan none)
 *   hard 35  the share of their working sets that were hard: RIR ≤ 2 or RPE ≥ 8 when rated,
 *            otherwise the set reached its target (reps or time); a done cardio set counts
 *   prog 25  of the exercises they did that they had done before, the share they improved on:
 *            a higher estimated 1RM (Epley, ≤ 12 reps), or more reps / a longer hold where
 *            there is no load
 *
 * Warm-ups live outside `sets` and never count. Pure: state in, numbers out.
 */

export const EFFORT_WEEKS = 8
export const WEIGHTS = { show: 40, hard: 35, prog: 25 }
const DAY = 86400000
const REP_CAP = 12

/** Monday of the ISO week a YYYY-MM-DD date falls in (UTC), as YYYY-MM-DD. */
export function weekOf(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)

const modeOf = e => {
  const m = e?.target?.mode
  if (m === 'reps' || m === 'time' || m === 'cardio') return m
  // no mode on the target: cardio entries carry minutes, everything else reps
  return (e?.sets || []).some(s => s.min != null) ? 'cardio' : 'reps'
}

function hardSet(s, e, mode) {
  if (s.rir != null) return s.rir <= 2
  if (s.rpe != null) return s.rpe >= 8
  const t = e.target || {}
  if (mode === 'cardio') return true
  if (mode === 'time') return !(t.sec > 0) || (s.sec || 0) >= t.sec
  const goal = t.repsMin > 0 ? t.repsMin : t.reps
  return !(goal > 0) || (s.r || 0) >= goal
}

/** The best performance in one entry, comparable session to session; null when there is none. */
function bestOf(e, mode) {
  const done = (e.sets || []).filter(s => s.done)
  if (!done.length || mode === 'cardio') return null
  if (mode === 'time') return Math.max(...done.map(s => s.sec || 0)) || null
  const loaded = done.filter(s => s.w > 0 && s.r >= 1 && s.r <= REP_CAP)
  if (loaded.length) return { load: true, v: Math.max(...loaded.map(s => (s.r === 1 ? s.w : s.w * (1 + s.r / 30)))) }
  return { load: false, v: Math.max(...done.map(s => s.r || 0)) || null }
}
// As { key, v }: a loaded lift compares on estimated 1RM, bodyweight on reps, a hold on seconds.
// Only like with like — 1RM against 1RM, never against a bodyweight rep count.
const norm = b => (b == null ? null : typeof b === 'number' ? { key: 'time', v: b } : b.v == null ? null : { key: b.load ? 'load' : 'bw', v: b.v })

/** One week's score for a profile's state. `wk` is the week's Monday (YYYY-MM-DD). */
export function weekScore(state, wk) {
  const workouts = state?.workouts || []
  const end = addDays(wk, 7)
  const inWeek = workouts.filter(w => w.d >= wk && w.d < end)
  const before = workouts.filter(w => w.d < wk)

  const planned = Object.values(state?.week || {}).filter(Boolean).length
  const target = Math.min(7, Math.max(1, planned || 3))
  const sessions = inWeek.length
  const show = Math.min(1, sessions / target) * WEIGHTS.show

  let sets = 0, hard = 0
  const thisWeek = new Map()
  for (const w of inWeek) for (const e of w.entries || []) {
    const mode = modeOf(e)
    for (const s of e.sets || []) if (s.done) { sets++; if (hardSet(s, e, mode)) hard++ }
    const n = norm(bestOf(e, mode))
    if (!n) continue
    const prev = thisWeek.get(e.id)
    if (!prev || (n.key === 'load' && prev.key !== 'load') || (n.key === prev.key && n.v > prev.v)) thisWeek.set(e.id, n)
  }
  const hardPart = sets ? (hard / sets) * WEIGHTS.hard : 0

  let compared = 0, improved = 0
  for (const [id, cur] of thisWeek) {
    let prior = null
    for (const w of before) for (const e of w.entries || []) {
      if (e.id !== id) continue
      const n = norm(bestOf(e, modeOf(e)))
      if (n && n.key === cur.key && (prior == null || n.v > prior)) prior = n.v
    }
    if (prior == null) continue          // first time: nothing to improve on yet
    compared++
    if (cur.v > prior + 1e-6) improved++
  }
  const prog = compared ? (improved / compared) * WEIGHTS.prog : 0

  const r = x => Math.round(x)
  return { wk, score: r(show + hardPart + prog), show: r(show), hard: r(hardPart), prog: r(prog), sessions, target }
}

/** The last EFFORT_WEEKS weeks up to and including this one, oldest first. */
export function effortWeeks(state, now = Date.now(), weeks = EFFORT_WEEKS) {
  const thisWeek = weekOf(new Date(now).toISOString().slice(0, 10))
  const out = []
  for (let i = weeks - 1; i >= 0; i--) out.push(weekScore(state, addDays(thisWeek, -7 * i)))
  return out
}
