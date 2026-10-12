import { describe, it, expect } from 'vitest'
import { freestyleTarget, routineFromWorkout } from './freestyle.js'
import { EXDB } from './exercises.js'

const CARDIO = EXDB.find(e => e.bp === 'cardio').id
const LIFT = EXDB.find(e => e.bp !== 'cardio').id
const LIFT2 = EXDB.filter(e => e.bp !== 'cardio')[1].id

const state = workouts => ({ workouts, exWeights: {} })
const session = (entries, d = '2026-10-01') => ({ id: 'w' + d, d, entries })

describe('freestyleTarget', () => {
  it('uses the plain default for an exercise never logged', () => {
    expect(freestyleTarget(state([]), LIFT)).toEqual({ sets: 3, reps: 10, weight: 0, mode: 'reps' })
    expect(freestyleTarget(state([]), CARDIO)).toEqual({ sets: 1, min: 20, speed: 8 })
  })

  it('repeats the sets you actually finished last time, not the ones planned', () => {
    const S = state([session([{ id: LIFT, target: { mode: 'reps', sets: 4, reps: 8 },
      sets: [{ w: 50, r: 8, done: true }, { w: 50, r: 8, done: true }, { w: 50, r: 6, done: false }] }])])
    expect(freestyleTarget(S, LIFT)).toMatchObject({ mode: 'reps', sets: 2, reps: 8 })
  })

  it('keeps a timed exercise timed and a rep range a range', () => {
    const S = state([session([
      { id: LIFT, target: { mode: 'time', sec: 30 }, sets: [{ sec: 40, w: 0, done: true }] },
      { id: LIFT2, target: { mode: 'reps', reps: 12, repsMin: 8 }, sets: [{ w: 20, r: 9, done: true }] }
    ])])
    expect(freestyleTarget(S, LIFT)).toMatchObject({ mode: 'time', sets: 1, sec: 40 })
    expect(freestyleTarget(S, LIFT2)).toMatchObject({ mode: 'reps', reps: 12, repsMin: 8 })
  })

  it('reads reps off the sets when the old workout carried no target', () => {
    const S = state([session([{ id: LIFT, sets: [{ w: 40, r: 12, done: true }] }])])
    expect(freestyleTarget(S, LIFT)).toMatchObject({ mode: 'reps', sets: 1, reps: 12 })
  })
})

describe('routineFromWorkout', () => {
  const meta = { id: 'r1', name: 'Mine', emoji: 'dumbbell' }

  it('keeps only exercises with a done set, once each, in the order done', () => {
    const w = session([
      { id: LIFT, target: { mode: 'reps', reps: 10 }, sets: [{ w: 40, r: 10, done: true }, { w: 45, r: 10, done: true }, { w: 45, r: 8, done: true }] },
      { id: LIFT2, target: { mode: 'reps', reps: 10 }, sets: [{ w: 10, r: 10, done: false }] },
      { id: LIFT, target: { mode: 'reps', reps: 10 }, sets: [{ w: 30, r: 12, done: true }] },
      { id: CARDIO, target: { min: 20, speed: 8 }, sets: [{ min: 25, speed: 9, done: true }] }
    ])
    const r = routineFromWorkout(w, meta)
    expect(r).toMatchObject(meta)
    expect(r.ex.map(e => e.id)).toEqual([LIFT, CARDIO])
    expect(r.ex[0]).toEqual({ id: LIFT, sets: 3, mode: 'reps', reps: 10, weight: 45 })
    expect(r.ex[1]).toEqual({ id: CARDIO, sets: 1, min: 25, speed: 9 })
  })

  it('takes the reps you did over the seeded target, and keeps a range as planned', () => {
    const w = session([
      { id: LIFT, target: { mode: 'reps', reps: 10 }, sets: [{ w: 20, r: 12, done: true }, { w: 20, r: 12, done: true }, { w: 20, r: 9, done: true }] },
      { id: LIFT2, target: { mode: 'reps', reps: 12, repsMin: 8, prog: 'double' }, sets: [{ w: 20, r: 9, done: true }] }
    ])
    const r = routineFromWorkout(w, meta)
    expect(r.ex[0].reps).toBe(12)
    expect(r.ex[1]).toMatchObject({ reps: 12, repsMin: 8, prog: 'double' })
  })

  it('makes an empty routine from a session with nothing done', () => {
    expect(routineFromWorkout(session([]), meta).ex).toEqual([])
  })
})
