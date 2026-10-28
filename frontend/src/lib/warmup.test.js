import { describe, it, expect } from 'vitest'
import { normalizeWarmup, warmupWeight, buildWarm, refreshWarm, workingWeight, warmupText, MAX_WARMUP } from './warmup.js'

describe('normalizeWarmup', () => {
  it('keeps percentage and fixed-weight entries, in order', () => {
    expect(normalizeWarmup([{ pct: 50, reps: 10 }, { w: 20, reps: 8 }])).toEqual([{ pct: 50, reps: 10 }, { w: 20, reps: 8 }])
  })
  it('clamps silly numbers and drops what is not a warm-up', () => {
    expect(normalizeWarmup([{ pct: 150, reps: 0 }, { pct: 0, w: 'x' }, null, 'a', { w: -5, reps: 3 }]))
      .toEqual([{ pct: 100, reps: 1 }])
    expect(normalizeWarmup(undefined)).toEqual([])
    expect(normalizeWarmup(Array.from({ length: 10 }, () => ({ pct: 50, reps: 5 })))).toHaveLength(MAX_WARMUP)
  })
})

describe('warmupWeight', () => {
  it('takes a percentage of the working weight, rounded to a loadable step', () => {
    expect(warmupWeight({ pct: 50, reps: 10 }, 100, 2.5)).toBe(50)
    expect(warmupWeight({ pct: 70, reps: 5 }, 82.5, 2.5)).toBe(57.5)    // 57.75 → 57.5
    expect(warmupWeight({ pct: 60, reps: 5 }, 22, 2)).toBe(14)          // dumbbells: 13.2 → 14
  })
  it('never goes above the working weight, and is 0 without one', () => {
    expect(warmupWeight({ pct: 100, reps: 1 }, 21, 2)).toBe(21)
    expect(warmupWeight({ pct: 50, reps: 10 }, 0, 2.5)).toBe(0)
  })
  it('uses a fixed weight as written', () => {
    expect(warmupWeight({ w: 20, reps: 8 }, 100, 2.5)).toBe(20)
  })
})

describe('building and following the working weight', () => {
  const cfg = { warmup: [{ pct: 50, reps: 10 }, { w: 20, reps: 8 }, { pct: 80, reps: 3 }] }

  it('builds one undone set per planned warm-up', () => {
    expect(buildWarm(cfg, 100, 2.5)).toEqual([
      { w: 50, r: 10, done: false, pct: 50 },
      { w: 20, r: 8, done: false },
      { w: 80, r: 3, done: false, pct: 80 }
    ])
    expect(buildWarm({}, 100, 2.5)).toEqual([])
  })

  it('moves undone percentage sets when the working weight changes, nothing else', () => {
    const warm = buildWarm(cfg, 100, 2.5)
    warm[0].done = true
    expect(refreshWarm(warm, 120, 2.5).map(s => s.w)).toEqual([50, 20, 95])   // 96 → 95
  })

  it('reads the working weight off the first working set', () => {
    expect(workingWeight([{ w: 60 }, { w: 62.5 }])).toBe(60)
    expect(workingWeight([])).toBe(0)
  })

  it('describes a planned warm-up', () => {
    expect(warmupText({ pct: 50, reps: 10 }, 'kg')).toBe('50 % × 10')
    expect(warmupText({ w: 20, reps: 8 }, 'kg')).toBe('20 kg × 8')
  })
})

describe('warm-ups in the plan', async () => {
  const { buildPlanBundle } = await import('./plan-share.js')
  const { exLine } = await import('./history.js')
  const { EXDB } = await import('./exercises.js')
  const LIFT = EXDB.find(e => e.bp !== 'cardio').id

  it('travel with a shared plan, cleaned up', () => {
    const S = { routines: [{ id: 'r', name: 'A', ex: [{ id: LIFT, sets: 3, reps: 5, mode: 'reps', warmup: [{ pct: 50, reps: 10 }, { bogus: 1 }] }] }], week: {}, customEx: [] }
    expect(buildPlanBundle(S, 'x').routines[0].ex[0].warmup).toEqual([{ pct: 50, reps: 10 }])
  })

  it('show up in the one-line summary', () => {
    expect(exLine({ id: LIFT, sets: 3, reps: 5, weight: 60, warmup: [{ pct: 50, reps: 10 }, { pct: 70, reps: 5 }] }, 'kg')).toBe('3 × 5 · 60 kg · +2 warm-up')
  })
})
