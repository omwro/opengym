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
