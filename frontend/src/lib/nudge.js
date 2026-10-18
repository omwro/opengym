// A friendly jab for a teammate who has gone quiet: more than a week since their last logged
// workout.
import { todayISO } from './format.js'

export const NUDGE = 'Check zijn pols! Mogelijk is hij dood, of hij is WEAK!'

const daysSince = iso => Math.round((new Date(todayISO() + 'T00:00:00') - new Date(iso + 'T00:00:00')) / 86400000)

/** The nudge for a member, or null while they are still turning up. */
export function inactivityNudge({ last }) {
  if (!last) return null                         // never logged yet: new, not missing
  const days = daysSince(last)
  return days > 7 ? { days, text: NUDGE } : null
}
