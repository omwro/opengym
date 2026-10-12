// Freestyle: a workout that starts empty and is filled in as you go. Two questions decide
// how little typing that takes — what an exercise looks like the moment you add it, and how
// a session you made up on the spot becomes a routine you can repeat.
import { defaultConfig, lastEntryFor, modeOf } from './history.js'

/**
 * The prescription for an exercise added mid-freestyle. There is no routine to ask, so it
 * repeats what you did last time — as many sets as you actually finished, in the same mode —
 * and falls back to the plain default for an exercise you have never logged. The weights
 * themselves come from buildSets, which already reads them off your history.
 */
export function freestyleTarget(S, exId) {
  const last = lastEntryFor(S, exId)
  const mode = modeOf({ ...(last?.target || {}), id: exId })
  const base = defaultConfig(exId, mode)
  if (!last) return base
  const n = last.sets.length
  const top = last.sets[n - 1] || {}
  const out = { ...base, sets: Math.max(1, n) }
  if (mode === 'cardio') return { ...out, min: top.min || base.min, speed: top.speed ?? base.speed }
  if (mode === 'time') return { ...out, sec: top.sec || base.sec, weight: top.w || 0 }
  // A rep range is kept: it is what the last plan asked for, and the progression engine reads it.
  const t = last.target || {}
  const reps = t.reps > 0 ? t.reps : (top.r > 0 ? top.r : base.reps)
  return t.repsMin > 0 ? { ...out, reps, repsMin: t.repsMin } : { ...out, reps }
}

/**
 * A finished session as a routine: every exercise that got at least one set done, once, in
 * the order you did it, with the sets you did and the heaviest weight you used. Progression
 * settings ride along when the session had them so "save as routine" loses nothing.
 */
export function routineFromWorkout(w, { id, name, emoji }) {
  const seen = new Set()
  const ex = []
  for (const e of w.entries || []) {
    const done = (e.sets || []).filter(s => s.done)
    if (!done.length || seen.has(e.id)) continue
    seen.add(e.id)
    const tgt = e.target || {}
    const mode = modeOf({ ...tgt, id: e.id })
    const cfg = { id: e.id, sets: done.length }
    if (mode === 'cardio') {
      const l = done[done.length - 1]
      Object.assign(cfg, { min: l.min || 20, speed: l.speed ?? 8 })
    } else {
      const top = Math.max(0, ...done.map(s => s.w || 0), e.topW || 0)
      if (mode === 'time') Object.assign(cfg, { mode, sec: Math.max(...done.map(s => s.sec || 0)) || tgt.sec || 45, weight: top })
      else {
        // What you did, not what the session seeded: freestyle targets are only a starting
        // point. The most-done count wins — "10, 10, 8" is a plan of 10s with a tough last set.
        // A rep range is the exception; it is a plan, and the top of it is its target.
        const counts = {}
        done.forEach(s => { if (s.r > 0) counts[s.r] = (counts[s.r] || 0) + 1 })
        const best = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a)[0]
        Object.assign(cfg, { mode, reps: tgt.repsMin > 0 ? tgt.reps : (best || tgt.reps || 10), weight: top })
        if (tgt.repsMin > 0) cfg.repsMin = tgt.repsMin
      }
      if (tgt.prog) cfg.prog = tgt.prog
      if (tgt.inc > 0) cfg.inc = tgt.inc
    }
    ex.push(cfg)
  }
  return { id, name, emoji, ex }
}
