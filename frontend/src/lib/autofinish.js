// A workout left running: finished by itself after an hour without any activity.
//
// People forget to tap Finish — the phone goes in the bag and the workout keeps running, the
// streak and the stats wait for it, and teammates see "training now" the next morning. A running
// workout lives only on the device (it is never synced), so this has to happen in the app.
//
// "Activity" is anything that changes the session: a set ticked or edited, an exercise added or
// moved to. The time of the last one is kept on the workout (`lastAt`); a workout with none
// counts from its start. The check runs when the app opens, whenever it comes back to the
// screen, and once a minute while it is open — a locked phone runs no timers, so the moment you
// pick it up again is when an abandoned workout gets noticed. It is then saved as it stood at
// that last activity: its end time is `lastAt`, not the hour after, so its duration is honest.
import { useEffect } from 'react'

export const AUTO_FINISH_MS = 60 * 60000
const CHECK_MS = 60000

/** What counts as activity: where you are, the exercises, and every set and warm-up as logged. */
export const activitySig = A => (A ? JSON.stringify([A.cur, A.entries.map(e => [e.id,
  e.sets.map(x => [x.w, x.r, x.sec, x.min, x.speed, x.done]),
  (e.warm || []).map(x => [x.w, x.r, x.done])])]) : '')

/** When the workout last saw activity. */
export const lastActivity = A => A.lastAt || A.start

/** Whether a running workout has been left for the auto-finish period. */
export const isAbandoned = (A, now, limit = AUTO_FINISH_MS) => !!A && now - lastActivity(A) >= limit

/**
 * Watch the running workout: stamp `lastAt` on every change, and hand an abandoned one to
 * `finish(endAt)`. `stamp(at)` writes `lastAt` into the store. Returns the function that stops it.
 */
export function startAutoFinish({ store, stamp, finish, doc = document, now = () => Date.now(), every = CHECK_MS }) {
  let lastSig = activitySig(store.getState().S.active)
  let finishing = false
  const check = () => {
    const A = store.getState().S.active
    if (!A || finishing || !isAbandoned(A, now())) return
    finishing = true
    try { finish(lastActivity(A)) } finally { finishing = false }
  }
  const unsub = store.subscribe(() => {
    const A = store.getState().S.active
    const sig = activitySig(A)
    if (sig === lastSig) return
    const wasRunning = !!lastSig
    lastSig = sig
    // A change to a running workout is activity. A workout that just started has its start.
    if (A && wasRunning) stamp(now())
  })
  const onVis = () => { if (doc.visibilityState === 'visible') check() }
  doc.addEventListener('visibilitychange', onVis)
  const iv = setInterval(check, every)
  check()
  return () => { unsub(); clearInterval(iv); doc.removeEventListener('visibilitychange', onVis) }
}

/** App-wide: see the top of this file. `finish(endAt)` saves the workout (sheets.jsx). */
export function useAutoFinish(store, finish) {
  useEffect(() => startAutoFinish({
    store,
    stamp: at => store.getState().update(s => { if (s.active) s.active.lastAt = at }, false),
    finish
  }), [])
}
