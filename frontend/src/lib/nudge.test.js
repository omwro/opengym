import { describe, it, expect } from 'vitest'
import { inactivityNudge } from './nudge.js'
import { todayISO } from './format.js'

// a local calendar date, the way workouts are logged — toISOString would shift it to UTC
const ago = n => { const d = new Date(todayISO() + 'T00:00:00'); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

describe('the "is he still alive?" nudge', () => {
  it('stays quiet for the first two days', () => {
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(0) })).toBeNull()
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(2) })).toBeNull()
  })
  it('mentions it quietly from 72 hours up to six days', () => {
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(3) })).toEqual({ level: 'mild', days: 3, text: 'Avoided the gym for 3 days.' })
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(6) })).toMatchObject({ level: 'mild', days: 6 })
  })
  it('kicks in properly after more than six days', () => {
    const n = inactivityNudge({ id: 'a', name: 'Hamza', last: ago(7) })
    expect(n.level).toBe('strong')
    expect(n.days).toBe(7)
    expect(n.text).toBe('Avoided the gym for 7 days. Check zijn pols! Mogelijk is hij dood, of hij is WEAK!')
  })
  it('does not nag someone who has simply never logged yet', () => {
    expect(inactivityNudge({ id: 'a', name: 'New', last: null })).toBeNull()
  })
  it('counts from the last gym session, so a home session does not reset it', () => {
    expect(inactivityNudge({ last: ago(1), avoidSince: ago(8) })).toMatchObject({ level: 'strong', days: 8 })
    expect(inactivityNudge({ last: ago(1), avoidSince: ago(1) })).toBeNull()
  })
})

import { teamIdle } from './nudge.js'

describe('nobody gymed', () => {
  const H = 3600000, now = Date.parse('2026-10-29T20:00:00Z')
  const m = (lastGymAt, extra = {}) => ({ id: Math.random(), lastGymAt, ...extra })

  it('stays quiet while someone went within the last 24 hours', () => {
    expect(teamIdle([m(now - 30 * H), m(now - 23 * H)], now)).toBeNull()
  })
  it('counts from the most recent gym workout of anyone, in whole hours', () => {
    expect(teamIdle([m(now - 30 * H), m(now - 26.5 * H)], now))
      .toEqual({ hours: 26, text: 'Nobody gymed for the past 26 hours. It smells like bitch in here!' })
  })
  it('counts someone who never logged as not having gone', () => {
    expect(teamIdle([m(null), m(now - 48 * H)], now)?.hours).toBe(48)
  })
  it('with nobody ever logged, counts from when the team began', () => {
    expect(teamIdle([m(null), m(null)], now, now - 72 * H)?.hours).toBe(72)
    expect(teamIdle([m(null)], now, null)).toBeNull()
  })
  it('says nothing while someone is training right now', () => {
    expect(teamIdle([m(now - 50 * H, { live: {} }), m(null)], now)).toBeNull()
  })
  it('falls back to the date from an older server', () => {
    expect(teamIdle([{ last: '2026-10-27' }], now)?.hours).toBe(56)
  })
})
