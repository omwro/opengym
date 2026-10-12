import { describe, it, expect } from 'vitest'
import { renderSamples } from './sound.js'

describe('beep rendering', () => {
  it('is loud: peaks just under full scale, not the old 35%', () => {
    const s = renderSamples([{ freq: 1040, dur: 0.12, when: 0 }])
    const peak = Math.max(...s.map(Math.abs))
    expect(peak).toBeGreaterThan(0.9)
    expect(peak).toBeLessThanOrEqual(0.95 + 1e-6)
  })
  it('keeps most of its energy high — a soft-clipped tone, not a quiet sine', () => {
    const s = renderSamples([{ freq: 1040, dur: 0.2, when: 0 }])
    const rms = Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length)
    expect(rms).toBeGreaterThan(0.5)   // a pure sine at the same peak sits around 0.67 × envelope
  })
  it('renders a pattern as one clip with every tone at its offset', () => {
    const s = renderSamples([{ freq: 880, dur: 0.15, when: 0 }, { freq: 1320, dur: 0.3, when: 0.5 }])
    const at = sec => Math.abs(s[Math.floor(sec * 22050)])
    expect(s.length / 22050).toBeGreaterThan(0.8)   // spans to the last tone
    const gap = Math.max(...Array.from({ length: 200 }, (_, i) => at(0.3 + i / 22050)))
    expect(gap).toBeLessThan(1e-6)                  // silence between the two
  })
  it('never clips past full scale even when tones overlap', () => {
    const s = renderSamples([{ freq: 880, dur: 0.3, when: 0 }, { freq: 1100, dur: 0.3, when: 0.1 }])
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(0.95 + 1e-6)
  })
})
