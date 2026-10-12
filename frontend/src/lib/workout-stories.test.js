import { describe, it, expect } from 'vitest'
import { carryWeight, exerciseHistory, repsText, exLine } from './history.js'
import { weightStep, defaultIncrement, isDumbbell } from './progression.js'
import { EXDB } from './exercises.js'

const dumbbellId = EXDB.find(e => e.eq === 'dumbbell').id
const barbellId = EXDB.find(e => e.eq === 'barbell').id
const cableId = EXDB.find(e => e.eq === 'cable').id

describe('weight carries forward to the next sets', () => {
  it('an edited weight fills every later set that is not done', () => {
    const sets = [{ w: 20, done: true }, { w: 20 }, { w: 20 }, { w: 20 }]
    carryWeight(sets, 1, 24)
    expect(sets.map(s => s.w)).toEqual([20, 20, 24, 24])
  })
  it('never rewrites a set that is already done — that is history', () => {
    const sets = [{ w: 20 }, { w: 22, done: true }, { w: 20 }]
    carryWeight(sets, 0, 30)
    expect(sets.map(s => s.w)).toEqual([20, 22, 30])
  })
  it('editing the last set changes nothing else', () => {
    const sets = [{ w: 20 }, { w: 20 }]
    carryWeight(sets, 1, 25)
    expect(sets.map(s => s.w)).toEqual([20, 20])
  })
})

describe('weight steps follow the equipment', () => {
  it('dumbbells step 2 kg, plates 2.5 kg', () => {
    expect(isDumbbell(dumbbellId)).toBe(true)
    expect(weightStep(dumbbellId, 'kg')).toBe(2)
    expect(weightStep(barbellId, 'kg')).toBe(2.5)
    expect(weightStep(cableId, 'kg')).toBe(2.5)
  })
  it('in pounds both step 5', () => {
    expect(weightStep(dumbbellId, 'lb')).toBe(5)
    expect(weightStep(barbellId, 'lb')).toBe(5)
  })
  it('progression on a dumbbell lift adds 2 kg — a dumbbell that exists', () => {
    expect(defaultIncrement(dumbbellId, 'kg')).toBe(2)
    expect(defaultIncrement(dumbbellId, 'lb')).toBe(5)
  })
})

describe('rep ranges are shown as ranges', () => {
  it('a range reads bottom–top', () => {
    expect(repsText({ reps: 12, repsMin: 8 })).toBe('8–12')
    expect(exLine({ id: barbellId, sets: 3, reps: 10, repsMin: 8 }, 'kg')).toBe('3 × 8–10')
  })
  it('a single target stays a single number', () => {
    expect(repsText({ reps: 10 })).toBe('10')
    expect(repsText({ reps: 10, repsMin: 10 })).toBe('10')
  })
})

describe('history of one exercise', () => {
  const S = { workouts: [
    { id: 'a', d: '2026-09-01', entries: [{ id: 'x', sets: [{ w: 20, r: 10, done: true }, { w: 22, r: 8, done: true }] }] },
    { id: 'c', d: '2026-09-15', entries: [{ id: 'x', sets: [{ w: 24, r: 8, done: true }, { w: 99, r: 1, done: false }] }] },
    { id: 'b', d: '2026-09-08', entries: [{ id: 'y', sets: [{ w: 50, r: 5, done: true }] }] },
    { id: 'd', d: '2026-09-10', entries: [{ id: 'x', sets: [{ w: 30, done: false }] }] }
  ] }
  it('is newest first, whatever order the log is stored in', () => {
    expect(exerciseHistory(S, 'x').map(r => r.d)).toEqual(['2026-09-15', '2026-09-01'])
  })
  it('keeps only the sets that were done, and their heaviest', () => {
    const [latest, older] = exerciseHistory(S, 'x')
    expect(latest.sets).toHaveLength(1)
    expect(latest.top).toBe(24)
    expect(older.top).toBe(22)
  })
  it('skips sessions where the exercise was there but nothing was done', () => {
    expect(exerciseHistory(S, 'x').some(r => r.d === '2026-09-10')).toBe(false)
  })
})
