import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startPresence, livePayload, HEARTBEAT_MS } from './presence.js'

// A store and a document, reduced to what the heartbeat uses.
function setup() {
  let state = { S: { active: { id: 'w', name: 'Push', start: 1, cur: 0, entries: [{ id: 'a', sets: [{ w: 60, r: 5, done: false }] }] } } }
  const subs = new Set()
  const store = { getState: () => state, subscribe: f => { subs.add(f); return () => subs.delete(f) } }
  const set = fn => { state = { S: fn(state.S) }; subs.forEach(f => f()) }
  const listeners = new Set()
  const doc = { visibilityState: 'visible', addEventListener: (_n, f) => listeners.add(f), removeEventListener: (_n, f) => listeners.delete(f) }
  const visibility = v => { doc.visibilityState = v; listeners.forEach(f => f()) }
  const sent = []
  const post = (body, keepalive) => sent.push({ active: body.active, keepalive: !!keepalive, setsDone: body.setsDone })
  return { store, set, doc, visibility, sent, post }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the "training now" heartbeat', () => {
  it('pings at once and then every 20 s while the app is on screen', () => {
    const h = setup()
    const stop = startPresence(h)
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(h.sent.map(s => s.active)).toEqual([true, true, true])
    stop()
  })

  it('stamps once on the way to the background, stays quiet there, and pings straight back', () => {
    const h = setup()
    const stop = startPresence(h)
    h.visibility('hidden')
    expect(h.sent.at(-1)).toMatchObject({ active: true, keepalive: true })
    const before = h.sent.length
    vi.advanceTimersByTime(HEARTBEAT_MS * 5)
    expect(h.sent.length).toBe(before)                  // a locked phone sends nothing
    h.visibility('visible')
    expect(h.sent.length).toBe(before + 1)              // back: immediately
    stop()
  })

  it('sends a ticked set within seconds, not at the next heartbeat', () => {
    const h = setup()
    const stop = startPresence(h)
    h.set(S => ({ ...S, active: { ...S.active, entries: [{ id: 'a', sets: [{ w: 60, r: 5, done: true }] }] } }))
    vi.advanceTimersByTime(1600)
    expect(h.sent.at(-1)).toMatchObject({ active: true, setsDone: 1 })
    stop()
  })

  it('says "stopped" only when the workout has ended — not when the app closes mid-workout', () => {
    const h = setup()
    startPresence(h)()                                  // app closed / reloaded, workout still on
    expect(h.sent.some(s => s.active === false)).toBe(false)
    const h2 = setup()
    const stop = startPresence(h2)
    h2.set(S => ({ ...S, active: null }))               // finished or discarded
    stop()
    expect(h2.sent.at(-1)).toEqual({ active: false, keepalive: true, setsDone: undefined })
  })

  it('carries where you are and the sets so far', () => {
    const p = livePayload({ name: 'Push', start: 5, cur: 0, entries: [{ id: 'a', target: { reps: 5 }, sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5 }] }] })
    expect(p).toMatchObject({ active: true, name: 'Push', exIdx: 1, exTotal: 1, setsDone: 1, setsTotal: 2, startedAt: 5, cur: 0 })
    expect(p.entries[0].sets[1].done).toBe(false)
  })
})
