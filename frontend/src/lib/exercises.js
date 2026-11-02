import { EXDB } from './exercises-data.js'
import { t } from './i18n.js'

export { EXDB }
export const EXIDX = {}
EXDB.forEach(e => { EXIDX[e.id] = e })
export const BODYPARTS = [...new Set(EXDB.map(e => e.bp))].sort()

// Equipment options present in a given list of exercises, most common first (issue #6).
// Deriving them from the *already filtered* list keeps the chip row short and means
// every body-part × equipment combination on screen has results behind it.
export function equipmentOf(list) {
  const c = {}
  list.forEach(e => { if (e.eq) c[e.eq] = (c[e.eq] || 0) + 1 })
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))
}

// Custom (user-created) exercises live in synced state S.customEx (issue #11) and are
// merged into the id index here so every EXIDX[id] lookup keeps working unchanged.
let customIds = []
export function registerCustom(list) {
  customIds.forEach(id => delete EXIDX[id])
  customIds = (list || []).map(e => e.id)
  ;(list || []).forEach(e => { if (e && e.id) EXIDX[e.id] = normalizeCustom(e) })
}
/**
 * A custom exercise with every field the app reads from an exercise, whatever it came from.
 * Customs made in the app always had them, but one arriving with a shared plan (a teammate's
 * plan, a plan file) carried only a name and a body part — and searching for any exercise then
 * crashed on its missing equipment. Stored customs are healed here too, so profiles that
 * already imported such a plan work again without anything to redo.
 */
export const normalizeCustom = c => ({
  ...c,
  n: typeof c.n === 'string' && c.n.trim() ? c.n : 'custom exercise',
  bp: typeof c.bp === 'string' ? c.bp : '',
  tg: typeof c.tg === 'string' ? c.tg : '',
  eq: typeof c.eq === 'string' && c.eq ? c.eq : 'custom',
  custom: true
})

// Full searchable catalogue — customs first so your own exercises are easy to find.
export const allExercises = st => [...(st.customEx || []).filter(c => c && c.id).map(normalizeCustom), ...EXDB]

/** Does an exercise match a search (already lower-cased)? Tolerates any missing field. */
export const matchesQuery = (e, ql) => !ql
  || [e.n, e.tg, e.eq, e.desc].some(v => typeof v === 'string' && v.toLowerCase().includes(ql))

// Media normally sits next to the app (img/ and gif/, mounted into the web container).
// A build can point them somewhere else — the demo build pulls them off a CDN instead of
// shipping ~140 MB of images into the deployment.
const IMG_BASE = import.meta.env.VITE_IMG_BASE || 'img/'
const GIF_BASE = import.meta.env.VITE_GIF_BASE || 'gif/'
export const imgSrc = ex => IMG_BASE + ex.img
export const gifSrc = ex => GIF_BASE + ex.gif

// Cardio exercises log time + speed instead of weight × reps.
export const isCardio = idOrEx => (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.bp === 'cardio'

// An id that resolves to nothing — a plan file built against a different exercise dataset,
// a custom exercise deleted on another device before the sync arrived — still has to
// render. A placeholder keeps it visible (and removable) instead of taking the whole view
// down on the first `ex.n`.
export const exOr = id => EXIDX[id] ||
  { id, n: t('Unknown exercise'), bp: '', tg: '', eq: '', sm: [], st: [], missing: true }
