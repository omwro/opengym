import { describe, it, expect } from 'vitest'
import { similarTo } from './similar.js'
import { EXIDX } from './exercises.js'

const top = (id, n = 5) => similarTo(id).slice(0, n).map(e => e.n)

describe('stand-ins when the machine is taken', () => {
  it('never offers a stretch as a substitute for a working set', () => {
    for (const id of ['0314', '0198', '0743', '0577']) {
      expect(similarTo(id).some(e => /stretch/i.test(e.n))).toBe(false)
    }
  })
  it('keeps to the same target muscle at the top', () => {
    for (const id of ['0314', '0198', '0577', '0603']) {
      const tg = EXIDX[id].tg
      expect(similarTo(id).slice(0, 5).every(e => e.tg === tg)).toBe(true)
    }
  })
  it('an incline press is replaced by another incline press first', () => {
    const t = top('0314')
    expect(t.some(n => /incline/.test(n) && /press/.test(n))).toBe(true)
  })
  it('never suggests the exercise itself', () => {
    expect(similarTo('0198').some(e => e.id === '0198')).toBe(false)
  })
})
