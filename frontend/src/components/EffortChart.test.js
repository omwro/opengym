import { describe, it, expect } from 'vitest'
import { smoothPath } from './EffortChart.jsx'

// every coordinate the path passes through or pulls towards
const ys = d => [...d.matchAll(/[\d.]+,([\d.]+)/g)].map(m => +m[1])

describe('smoothPath', () => {
  it('runs through every point', () => {
    const d = smoothPath([[0, 10], [10, 50], [20, 30]])
    expect(d.startsWith('M0.0,10.0')).toBe(true)
    expect(d).toContain(' 10.0,50.0 C')
    expect(d.endsWith(' 20.0,30.0')).toBe(true)
  })
  it('never bends beyond the highest or lowest point', () => {
    const pts = [[0, 100], [10, 0], [20, 100], [30, 95], [40, 0], [50, 0], [60, 40]]
    const all = ys(smoothPath(pts))
    expect(Math.max(...all)).toBeLessThanOrEqual(100)
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0)
  })
  it('handles one or no point', () => {
    expect(smoothPath([[5, 5]])).toBe('M5,5')
    expect(smoothPath([])).toBe('')
  })
})
