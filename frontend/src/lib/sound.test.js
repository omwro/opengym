import { describe, it, expect } from 'vitest'
import { renderSamples } from './sound.js'

describe('beep rendering', () => {
  it('is loud: peaks just under full scale, not the old 35%', () => {
    const s = renderSamples([{ freq: 1040, dur: 0.12, when: 0 }])
    const peak = Math.max(...s.map(Math.abs))
    expect(peak).toBeGreaterThan(0.9)
    expect(peak).toBeLessThanOrEqual(0.95 + 1e-6)
  })
  it('rings out like a chime instead of stopping dead like an alarm', () => {
    const s = renderSamples([{ freq: 1047, dur: 0.45, when: 0 }])
    const rms = (a, b) => Math.sqrt(s.slice(a, b).reduce((x, v) => x + v * v, 0) / (b - a))
    const q = Math.floor(s.length / 4)
    expect(rms(0, q)).toBeGreaterThan(rms(3 * q, 4 * q) * 3)   // loud strike, soft tail
  })
  it('is not a hard-clipped, buzzy tone', () => {
    // a square-ish alarm sits at full scale for long stretches; a clean tone only touches its peak
    const s = renderSamples([{ freq: 1047, dur: 0.45, when: 0 }])
    const nearPeak = s.filter(v => Math.abs(v) > 0.9).length / s.length
    expect(nearPeak).toBeLessThan(0.05)
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

import { countdownParts, renderSamples as render, TICK } from './sound.js'

describe('the countdown is one clip, so the music stays ducked between beeps', () => {
  it('holds 3-2-1 and the final beep at the right offsets', () => {
    const p = countdownParts(3)
    const expected = [0, 1, 2, 3, 3.14, 3.28]
    expected.forEach((w, i) => expect(p[i].when).toBeCloseTo(w, 6))
  })
  it('joins late: started with 2.2 s left it plays only what is still ahead', () => {
    const p = countdownParts(2.2)
    expect(p.filter(x => x.freq === TICK.freq).length).toBe(2)
    expect(p.at(-1).when).toBeCloseTo(2.48)
  })
  it('stays under five seconds — longer media gets the music paused, not ducked', () => {
    const s = render(countdownParts(3.5))
    expect(s.length / 22050).toBeLessThan(5)
  })
  it('is continuous: the gaps are part of the clip, not the end of it', () => {
    const s = render(countdownParts(3))
    // the clip runs past the last tick into the final beep — one playback covering all of it
    expect(s.length / 22050).toBeGreaterThan(3.9)
  })
})
