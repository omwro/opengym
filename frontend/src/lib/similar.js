// Stand-in exercises for when the machine is taken.
import { EXDB, EXIDX } from './exercises.js'

// Words that say nothing about the movement, so they do not count as overlap.
const FILLER = new Set(['with', 'on', 'the', 'and', 'of', 'a', 'v.', 'v', '2', '3', 'version', 'lever', 'cable', 'dumbbell', 'barbell', 'machine', 'band', 'smith'])
const words = n => new Set(n.toLowerCase().replace(/[()]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !FILLER.has(w)))

/**
 * Stand-ins for an exercise, best first. Same target muscle is the entry ticket; within that,
 * the movement matters more than the equipment — an incline press is replaced by another
 * incline press before a dip — and a stretch is never a substitute for a working set.
 */
export function similarTo(exId) {
  const ex = EXIDX[exId]
  if (!ex) return []
  const mine = words(ex.n)
  const score = e => {
    let s = 0
    if (e.tg && e.tg === ex.tg) s += 10
    else if (e.bp === ex.bp) s += 3
    for (const w of words(e.n)) if (mine.has(w)) s += 4
    if (e.eq === ex.eq) s += 2
    return s
  }
  return EXDB
    .filter(e => e.id !== exId && (e.tg === ex.tg || e.bp === ex.bp) && !/stretch/i.test(e.n))
    .map(e => [score(e), e])
    .sort((a, b) => b[0] - a[0] || (a[1].n < b[1].n ? -1 : 1))
    .map(([, e]) => e)
}
