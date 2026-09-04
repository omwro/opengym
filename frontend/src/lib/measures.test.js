import { describe, it, expect } from 'vitest'
import {
  FIELDS, SINGLES, PAIRS, bodyFat, stats, weightAt, delta, sideGap, clean, series,
  missingForBodyFat, lengthUnit, filled
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
