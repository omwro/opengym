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
