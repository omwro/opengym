// A friendly jab for a teammate who has stayed away from the gym. Two steps: from 72 hours
// (three calendar days — workouts carry a date, not a time) a plain mention in the normal text
// colour, and after more than six days the loud one. Home sessions do not stop the count: the
// server sends `avoidSince`, the last workout that was not at home.
import { todayISO } from './format.js'

export const NUDGE = 'Check zijn pols! Mogelijk is hij dood, of hij is WEAK!'
export const MILD_DAYS = 3
export const STRONG_DAYS = 6
export const mildText = days => `Avoided the gym for ${days} days.`

const daysSince = iso => Math.round((new Date(todayISO() + 'T00:00:00') - new Date(iso + 'T00:00:00')) / 86400000)

/** The nudge for a member — { level: 'mild' | 'strong', days, text } — or null while they are still turning up. */
export function inactivityNudge({ last, avoidSince }) {
  // An older server sends only `last`; it counted every workout, so that still reads right.
  const since = avoidSince !== undefined ? avoidSince : last
  if (!since) return null                        // never logged yet: new, not missing
  const days = daysSince(since)
  if (days > STRONG_DAYS) return { level: 'strong', days, text: mildText(days) + ' ' + NUDGE }
  if (days >= MILD_DAYS) return { level: 'mild', days, text: mildText(days) }
  return null
}

/* ---------- the whole team ---------- */

export const TEAM_IDLE_HOURS = 24
export const teamIdleText = hours => `Nobody gymed for the past ${hours} hours. It smells like bitch in here!`

// When a member last went to the gym, in ms. An older server sends only the date; noon on that
// day is near enough for a count in hours.
const gymAt = m => (m.lastGymAt !== undefined ? m.lastGymAt : (m.last ? Date.parse(m.last + 'T12:00:00Z') : null))

/**
 * The team-wide jab: when nobody has been to the gym for TEAM_IDLE_HOURS or more — someone who
 * never logged anything counts as not having gone — and nobody is training right now. Counted
 * from the most recent gym workout of anyone; with none at all, from when the team began.
 * Returns { hours, text } or null.
 */
export function teamIdle(members, now, since = null) {
  if (!members?.length || members.some(m => m.live)) return null
  const times = members.map(gymAt).filter(t => Number.isFinite(t))
  const from = times.length ? Math.max(...times) : since
  if (!Number.isFinite(from)) return null
  const hours = Math.floor((now - from) / 3600000)
  return hours >= TEAM_IDLE_HOURS ? { hours, text: teamIdleText(hours) } : null
}
