import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startAutoFinish, isAbandoned, lastActivity, AUTO_FINISH_MS } from './autofinish.js'

const HOUR = AUTO_FINISH_MS
function setup(active) {
  let state = { S: { active } }
  const subs = new Set()
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  const set = fn => { state = { S: fn(state.S) }; subs.forEach(f => f()) }
  const listeners = new Set()
  const doc = { visibilityState: 'visible', addEventListener: (_n, f) => listeners.add(f), removeEventListener: (_n, f) => listeners.delete(f) }
  const visibility = v => { doc.visibilityState = v; listeners.forEach(f => f()) }
  const finished = []
  let clock = 0
  const h = {
    store, set, doc, visibility, finished,
    now: () => clock, tick: ms => { clock += ms; vi.advanceTimersByTime(ms) }, setClock: c => { clock = c },
    stamp: at => set(S => ({ ...S, active: S.active && { ...S.active, lastAt: at } })),
    finish: endAt => { finished.push(endAt); set(S => ({ ...S, active: null })) }
  }
  return h
}
const workout = (start, extra = {}) => ({ id: 'w', start, cur: 0, entries: [{ id: 'a', sets: [{ w: 60, r: 5, done: false }] }], ...extra })
const tickSet = S => ({ ...S, active: { ...S.active, entries: [{ id: 'a', sets: [{ w: 60, r: 5, done: true }] }] } })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('isAbandoned', () => {
  it('counts from the last activity, or the start when there was none', () => {
    expect(lastActivity(workout(100))).toBe(100)
    expect(lastActivity(workout(100, { lastAt: 500 }))).toBe(500)
    expect(isAbandoned(workout(0), HOUR - 1)).toBe(false)
    expect(isAbandoned(workout(0), HOUR)).toBe(true)
    expect(isAbandoned(workout(0, { lastAt: HOUR }), HOUR + 5)).toBe(false)
    expect(isAbandoned(null, 1e12)).toBe(false)
  })
})

describe('auto-finish', () => {
  it('finishes a workout an hour after its last activity, ending it at that activity', () => {
    const h = setup(workout(0))
    const stop = startAutoFinish(h)
    h.tick(10 * 60000)
    h.set(tickSet)                                     // a set ticked at 0:10
    h.tick(59 * 60000)
    expect(h.finished).toEqual([])                     // 0:69 — only 59 min since the set
    h.tick(60000)
    expect(h.finished).toEqual([10 * 60000])           // 1:10 — ended at 0:10, not now
    stop()
  })

  it('a long rest with the screen on is not abandonment if anything happens within the hour', () => {
    const h = setup(workout(0))
    const stop = startAutoFinish(h)
    for (let i = 0; i < 5; i++) { h.tick(50 * 60000); h.set(S => ({ ...S, active: { ...S.active, cur: i + 1 } })) }
    expect(h.finished).toEqual([])
    stop()
  })

  it('catches it when the app is opened or comes back to the screen, not only on the minute', () => {
    const h = setup(workout(0))
    h.setClock(3 * HOUR)                               // phone was locked all along, app opens now
    const stop = startAutoFinish(h)
    expect(h.finished).toEqual([0])                    // checked straight away on open
    stop()
    const h2 = setup(workout(0))
    const stop2 = startAutoFinish(h2)
    h2.visibility('hidden')
    h2.setClock(2 * HOUR)                              // timers froze while locked
    h2.visibility('visible')
    expect(h2.finished).toEqual([0])
    stop2()
  })

  it('leaves a workout alone while there is no workout, and finishes only once', () => {
    const h = setup(null)
    const stop = startAutoFinish(h)
    h.tick(3 * HOUR)
    expect(h.finished).toEqual([])
    stop()
  })
})
