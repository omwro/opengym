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
  it('mentions it quietly from 72 hours up to a week', () => {
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(3) })).toEqual({ level: 'mild', days: 3, text: 'Al 3 dagen niet getraind.' })
    expect(inactivityNudge({ id: 'a', name: 'Hamza', last: ago(7) })).toMatchObject({ level: 'mild', days: 7 })
  })
  it('kicks in properly after more than seven days', () => {
    const n = inactivityNudge({ id: 'a', name: 'Hamza', last: ago(8) })
    expect(n.level).toBe('strong')
    expect(n.days).toBe(8)
    expect(n.text).toBe('Check zijn pols! Mogelijk is hij dood, of hij is WEAK!')
  })
  it('does not nag someone who has simply never logged yet', () => {
    expect(inactivityNudge({ id: 'a', name: 'New', last: null })).toBeNull()
  })
})
