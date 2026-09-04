import { describe, it, expect } from 'vitest'
import {
  FIELDS, SINGLES, PAIRS, bodyFat, stats, weightAt, delta, sideGap, clean, series,
  missingForBodyFat, lengthUnit, filled, goalOf, goalProgress, deltaColor, currentOf, metric, metricIds, changeColor, WEIGHT
} from './measures.js'

const base = (over = {}) => ({ unit: 'kg', body: 'male', height: 180, bodyweight: [], measures: [], ...over })

describe('fields', () => {
  it('keeps left and right apart, because asymmetry is the information', () => {
    expect(PAIRS.map(p => p.group)).toEqual(['Biceps', 'Forearm', 'Thigh', 'Calf'])
    for (const p of PAIRS) expect(p.left.id.endsWith('L') && p.right.id.endsWith('R')).toBe(true)
  })
  it('has no weight field — body weight has its own log', () => {
    expect(FIELDS.find(f => f.id === 'weight')).toBeUndefined()
    expect(SINGLES.map(f => f.id)).toEqual(['neck', 'shoulders', 'chest', 'waist', 'hips'])
  })
  it('lengths follow the profile unit system', () => {
    expect(lengthUnit({ unit: 'kg' })).toBe('cm')
    expect(lengthUnit({ unit: 'lb' })).toBe('in')
  })
})

describe('body fat (US Navy)', () => {
  it('computes a plausible figure for a male profile', () => {
    const bf = bodyFat(base(), { neck: 38, waist: 85 })
    expect(bf).toBeGreaterThan(10)
    expect(bf).toBeLessThan(25)
  })
  it('uses the hip measurement for a female profile and refuses without it', () => {
    const S = base({ body: 'female', height: 168 })
    expect(bodyFat(S, { neck: 32, waist: 70 })).toBeNull()
    expect(bodyFat(S, { neck: 32, waist: 70, hips: 95 })).toBeGreaterThan(15)
  })
  it('returns null rather than guessing when an input is missing', () => {
    expect(bodyFat(base({ height: null }), { neck: 38, waist: 85 })).toBeNull()
    expect(bodyFat(base(), { waist: 85 })).toBeNull()
    expect(bodyFat(base(), { neck: 38 })).toBeNull()
  })
  it('refuses impossible inputs instead of returning NaN', () => {
    expect(bodyFat(base(), { neck: 90, waist: 85 })).toBeNull()   // waist ≤ neck breaks the log
    expect(bodyFat(base(), { neck: 38, waist: 38 })).toBeNull()
  })
  it('an imperial profile is converted, not misread as centimetres', () => {
    const metric = bodyFat(base(), { neck: 38.1, waist: 88.9 })
    const imperial = bodyFat(base({ unit: 'lb', height: 70.87 }), { neck: 15, waist: 35 })
    expect(imperial).not.toBeNull()
    expect(Math.abs(imperial - metric)).toBeLessThan(0.6)   // same body, same answer
  })
  it('says what is still missing', () => {
    expect(missingForBodyFat(base({ height: null }), {})).toContain('height')
    expect(missingForBodyFat(base(), { neck: 38 })).toEqual(['waist'])
    expect(missingForBodyFat(base({ body: 'female' }), { neck: 32, waist: 70 })).toEqual(['hips'])
    expect(missingForBodyFat(base(), { neck: 38, waist: 85 })).toEqual([])
  })
})

describe('weight is taken from the existing weigh-in log', () => {
  it('picks the nearest weigh-in either side of the measurement', () => {
    const S = base({ bodyweight: [{ d: '2026-08-01', w: 80 }, { d: '2026-09-01', w: 78 }, { d: '2026-09-20', w: 77 }] })
    expect(weightAt(S, '2026-09-03')).toBe(78)
    expect(weightAt(S, '2026-09-18')).toBe(77)
  })
  it('ignores one too far away to describe the body being measured', () => {
    const S = base({ bodyweight: [{ d: '2026-01-01', w: 90 }] })
    expect(weightAt(S, '2026-09-03')).toBeNull()
  })
  it('copes with no weigh-ins at all', () => {
    expect(weightAt(base(), '2026-09-03')).toBeNull()
  })
})

describe('derived stats', () => {
  const S = base({ bodyweight: [{ d: '2026-09-02', w: 80 }] })
  it('lean mass and FFMI follow from weight and body fat', () => {
    const s = stats(S, { d: '2026-09-02', neck: 38, waist: 85 })
    expect(s.bodyFat).toBeGreaterThan(0)
    expect(s.lean).toBeCloseTo(80 * (1 - s.bodyFat / 100), 1)
    expect(s.ffmi).toBeGreaterThan(15)
    expect(s.ffmi).toBeLessThan(30)
  })
  it('degrades to nulls rather than NaN when weight is unknown', () => {
    const s = stats(base(), { d: '2026-09-02', neck: 38, waist: 85 })
    expect(s.weight).toBeNull()
    expect(s.lean).toBeNull()
    expect(s.ffmi).toBeNull()
    expect(s.bodyFat).toBeGreaterThan(0)   // this one needs no weight
  })
  it('waist-to-height needs only the waist', () => {
    expect(stats(S, { d: '2026-09-02', waist: 90 }).whtr).toBe(0.5)
  })
})

describe('history', () => {
  const S = base({
    measures: [
      { d: '2026-08-01', chest: 100, bicepsL: 35, bicepsR: 36 },
      { d: '2026-09-01', chest: 102, bicepsL: 35.5, bicepsR: 37 },
      { d: '2026-07-01', chest: 99 }
    ]
  })
  it('delta compares the two most recent entries that both carry the field', () => {
    expect(delta(S, 'chest')).toBe(2)          // 102 − 100, not 102 − 99
    expect(delta(S, 'bicepsR')).toBe(1)
    expect(delta(S, 'waist')).toBeNull()       // never measured
  })
  it('a series is oldest-first and skips entries without the field', () => {
    expect(series(S, 'chest').map(p => p.y)).toEqual([99, 100, 102])
    expect(series(S, 'bicepsL').map(p => p.d)).toEqual(['2026-08-01', '2026-09-01'])
  })
  it('reports the left/right gap and which side it favours', () => {
    expect(sideGap({ bicepsL: 35, bicepsR: 37 }, 'Biceps')).toBe(2)
    expect(sideGap({ bicepsL: 37, bicepsR: 35 }, 'Biceps')).toBe(-2)
    expect(sideGap({ bicepsL: 35 }, 'Biceps')).toBeNull()
  })
})

describe('cleaning input', () => {
  it('keeps real numbers and drops everything else', () => {
    const out = clean({ chest: '102.4', waist: '', neck: null, bicepsL: 'abc', bicepsR: '0', hips: -5 }, '2026-09-04')
    expect(out).toEqual({ d: '2026-09-04', chest: 102.4 })
  })
  it('rounds to one decimal — a tape measure does not do microns', () => {
    expect(clean({ chest: '102.44' }, '2026-09-04').chest).toBe(102.4)
  })
  it('filled() lists only what was actually measured, in display order', () => {
    expect(filled({ bicepsL: 35, chest: 100 }).map(f => f.id)).toEqual(['chest', 'bicepsL'])
    expect(filled({}).length).toBe(0)
  })
})

describe('goals', () => {
  const S = (goals, measures) => ({
    unit: 'kg', body: 'male', height: 180, bodyweight: [], measureGoals: goals, measures
  })
  const hist = [{ d: '2026-09-01', chest: 100, waist: 88 }, { d: '2026-08-01', chest: 98, waist: 90 }]

  it('reads a goal only when it is a usable number', () => {
    expect(goalOf(S({ chest: 105 }, hist), 'chest')).toBe(105)
    expect(goalOf(S({ chest: 0 }, hist), 'chest')).toBeNull()
    expect(goalOf(S({}, hist), 'chest')).toBeNull()
    expect(goalOf(S({ chest: 'big' }, hist), 'chest')).toBeNull()
  })

  it('takes the direction from where the goal sits, not from the body part', () => {
    // Same field, opposite intents — bulking to a bigger waist is a real goal.
    expect(goalProgress(S({ waist: 80 }, hist), 'waist')).toMatchObject({ up: false, remaining: 8 })
    expect(goalProgress(S({ waist: 95 }, hist), 'waist')).toMatchObject({ up: true, remaining: 7 })
    expect(goalProgress(S({ chest: 105 }, hist), 'chest')).toMatchObject({ up: true, remaining: 5 })
  })

  it('reports a goal as reached without demanding an exact match', () => {
    expect(goalProgress(S({ chest: 100 }, hist), 'chest').reached).toBe(true)
    expect(goalProgress(S({ chest: 100.02 }, hist), 'chest').reached).toBe(true)
    expect(goalProgress(S({ chest: 101 }, hist), 'chest').reached).toBe(false)
  })

  it('is null when there is no goal or nothing measured yet', () => {
    expect(goalProgress(S({}, hist), 'chest')).toBeNull()
    expect(goalProgress(S({ neck: 40 }, hist), 'neck')).toBeNull()
  })

  it('colours a change by whether it moves toward the goal', () => {
    const cutting = S({ waist: 80 }, hist)
    expect(deltaColor(cutting, 'waist', -2)).toBe('var(--acc)')
    expect(deltaColor(cutting, 'waist', +2)).toBe('var(--red)')
    const bulking = S({ chest: 105 }, hist)
    expect(deltaColor(bulking, 'chest', +2)).toBe('var(--acc)')
    expect(deltaColor(bulking, 'chest', -2)).toBe('var(--red)')
  })

  it('stays neutral with no goal, so nothing is implied about the direction', () => {
    expect(deltaColor(S({}, hist), 'chest', +2)).toBe('var(--label)')
    expect(deltaColor(S({ chest: 105 }, hist), 'chest', 0)).toBe('var(--label-2)')
  })

  it('current value is the most recent entry that has the field', () => {
    expect(currentOf(S({}, [{ d: '2026-09-01', waist: 88 }, { d: '2026-09-02', chest: 101 }]), 'waist')).toBe(88)
    expect(currentOf(S({}, hist), 'neck')).toBeNull()
  })
})

describe('one shape for weight and tape measurements', () => {
  const S = {
    unit: 'kg', body: 'male', height: 180, targetW: 75,
    bodyweight: [{ d: '2026-08-01', w: 80 }, { d: '2026-09-01', w: 78.4 }],
    measureGoals: { chest: 108 },
    measures: [{ d: '2026-09-01', chest: 102 }, { d: '2026-08-01', chest: 98 }]
  }

  it('lists weight first, then only measurements with data', () => {
    expect(metricIds(S)).toEqual([WEIGHT, 'chest'])
    expect(metricIds({ ...S, bodyweight: [] })).toEqual(['chest'])
    expect(metricIds({ ...S, bodyweight: [], measures: [] })).toEqual([])
  })

  it('describes body weight from its own log and goal field', () => {
    const m = metric(S, WEIGHT)
    expect(m).toMatchObject({ unit: 'kg', current: 78.4, date: '2026-09-01', change: -1.6 })
    expect(m.points.map(p => p.y)).toEqual([80, 78.4])
    expect(m.goal).toMatchObject({ goal: 75, up: false, remaining: 3.4 })
  })

  it('describes a measurement identically, from its own store', () => {
    const m = metric(S, 'chest')
    expect(m).toMatchObject({ unit: 'cm', current: 102, date: '2026-09-01', change: 4 })
    expect(m.points.map(p => p.y)).toEqual([98, 102])   // oldest-first, like weight
    expect(m.goal).toMatchObject({ goal: 108, up: true, remaining: 6 })
  })

  it('the two are interchangeable — same keys, so the card has one code path', () => {
    expect(Object.keys(metric(S, WEIGHT)).sort()).toEqual(Object.keys(metric(S, 'chest')).sort())
  })

  it('copes with a metric that has nothing logged', () => {
    const empty = metric({ ...S, bodyweight: [] }, WEIGHT)
    expect(empty.current).toBeNull()
    expect(empty.goal).toBeNull()
    expect(empty.points).toEqual([])
  })

  it('colours the change by the goal, for either kind', () => {
    expect(changeColor(metric(S, WEIGHT))).toBe('var(--acc)')     // losing toward 75
    expect(changeColor(metric(S, 'chest'))).toBe('var(--acc)')    // gaining toward 108
    expect(changeColor(metric({ ...S, targetW: 85 }, WEIGHT))).toBe('var(--red)')  // losing, goal is up
    expect(changeColor(metric({ ...S, targetW: null }, WEIGHT))).toBe('var(--label)')
  })
})
