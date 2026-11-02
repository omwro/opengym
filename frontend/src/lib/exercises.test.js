import { describe, it, expect } from 'vitest'
import { allExercises, matchesQuery, normalizeCustom, EXDB } from './exercises.js'
import { mergePlan, parsePlan } from './plan-share.js'

// A custom exercise the way a shared plan used to store it: a name and a body part, nothing more.
const bare = { id: 'cx1', n: 'cable fly from team', bp: 'chest' }

describe('searching exercises', () => {
  it('does not crash on a custom exercise without equipment or target', () => {
    const all = allExercises({ customEx: [bare] })
    expect(() => all.filter(e => matchesQuery(e, 'cur'))).not.toThrow()
    expect(all.filter(e => matchesQuery(e, 'cable fly')).map(e => e.id)).toContain('cx1')
  })
  it('matches on name, target, equipment and description, any case', () => {
    const e = { n: 'Bench Press', tg: 'pectorals', eq: 'barbell', desc: 'Flat Bench' }
    expect(['bench', 'pector', 'barb', 'flat'].every(q => matchesQuery(e, q))).toBe(true)
    expect(matchesQuery(e, 'squat')).toBe(false)
    expect(matchesQuery({}, 'x')).toBe(false)
    expect(matchesQuery({}, '')).toBe(true)
  })
  it('heals a bare custom into the full shape, and skips junk', () => {
    expect(normalizeCustom(bare)).toMatchObject({ id: 'cx1', tg: '', eq: 'custom', custom: true })
    expect(normalizeCustom({ id: 'x' }).n).toBe('custom exercise')
    expect(allExercises({ customEx: [null, { n: 'no id' }, bare] }).length).toBe(EXDB.length + 1)
  })
})

describe('taking a shared plan with a custom exercise', () => {
  it('stores the custom with equipment and target, so search keeps working', () => {
    const S = { routines: [], customEx: [], week: {}, workouts: [] }
    const bundle = parsePlan({ opengym_plan: 1, routines: [{ id: 'r', name: 'Team push', ex: [{ id: 'cx1', sets: 3, reps: 10 }] }], customEx: [bare] })
    mergePlan(S, bundle)
    expect(S.customEx[0]).toMatchObject({ n: 'cable fly from team', bp: 'chest', tg: '', eq: 'custom', custom: true })
  })
})
