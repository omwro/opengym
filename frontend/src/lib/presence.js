// "Training now": the live-presence heartbeat teammates (and the admin dashboard) see.
//
// It belongs to the *workout*, not to the workout screen. It used to live inside the workout
// view, so opening the Team tab mid-session — to see who else is training — unmounted it and
// told the server you had stopped. It now runs app-wide for as long as a workout is active and
// says "stopped" only when the workout really ends (finished or discarded).
//
// A locked phone runs no timers, so between sets nothing is sent at all. Three things cover
// that: one last ping as the app goes to the background (with `keepalive`, so it survives the
// page being suspended), a ping the moment it comes back, and a server-side expiry long enough
// for a rest with the screen off (PRESENCE_TTL in api/server.js).
import { useEffect } from 'react'
import { api } from './api.js'
import { supersetUnits, setsDoneActive } from './history.js'

export const HEARTBEAT_MS = 20000

/** What a heartbeat carries: where you are, and every set so far, for a teammate following along. */
export function livePayload(A) {
  const u = supersetUnits(A.entries)
  const c = Math.min(A.cur, Math.max(0, A.entries.length - 1))
  const ui = u.findIndex(x => x.includes(c))
  return {
    active: true, name: A.name, exIdx: ui + 1, exTotal: u.length,
    setsDone: setsDoneActive(A), setsTotal: A.entries.reduce((n, e) => n + e.sets.length, 0), startedAt: A.start,
    cur: c,
    entries: A.entries.map(e => ({ id: e.id, target: { reps: e.target?.reps, repsMin: e.target?.repsMin, mode: e.target?.mode },
      sets: e.sets.map(x => ({ w: x.w, r: x.r, min: x.min, speed: x.speed, sec: x.sec, done: !!x.done })) }))
  }
}

/** What changes are worth sending at once: where you are, and what you have logged. */
const signature = A => (A ? JSON.stringify([A.cur, A.entries.map(e => [e.id, e.sets.map(x => [x.w, x.r, x.done])])]) : '')

/**
 * Run the heartbeat for one workout; returns the function that stops it. `store` is the zustand
 * store (getState/subscribe), `post(body, keepalive)` sends to /api/activity, `doc` is the
 * document (its visibility decides when to ping).
 */
export function startPresence({ store, post, doc = document, every = HEARTBEAT_MS }) {
  let stopped = false
  const send = (keepalive = false) => {
    const A = store.getState().S.active
    if (!A || stopped) return
    post(livePayload(A), keepalive)
  }
  send()
  const iv = setInterval(() => { if (doc.visibilityState === 'visible') send() }, every)
  // Gone to the background (phone locked, another app): one last stamp now. Back: at once,
  // not up to 20 s later — and a timer the OS froze may not fire on its own anyway.
  const onVis = () => send(doc.visibilityState === 'hidden')
  doc.addEventListener('visibilitychange', onVis)
  // A ticked set reaches someone following along straight away, throttled because typing a
  // weight changes the state on every keystroke.
  let lastSig = signature(store.getState().S.active), pending = null
  const unsub = store.subscribe(() => {
    const now = signature(store.getState().S.active)
    if (now === lastSig || stopped) return
    lastSig = now
    clearTimeout(pending)
    pending = setTimeout(() => send(), 1500)
  })
  return () => {
    stopped = true
    clearInterval(iv); clearTimeout(pending); unsub()
    doc.removeEventListener('visibilitychange', onVis)
    // Only an ended workout says "stopped". Closing or reloading the app with a workout still
    // on does not — it resumes when the app opens, and the server lets the presence expire.
    if (!store.getState().S.active) post({ active: false }, true)
  }
}

/**
 * Keep the server told while a workout runs. `activeId` is the running workout's id or null —
 * the heartbeat restarts per workout, and when it goes from a workout to none, that workout
 * ended and "stopped" is sent.
 */
export function usePresence(store, signedIn, activeId) {
  useEffect(() => {
    if (!signedIn || !activeId) return
    return startPresence({
      store,
      post: (body, keepalive) => api('/api/activity', { method: 'POST', keepalive, body: JSON.stringify(body) }).catch(() => {})
    })
  }, [signedIn, activeId])
}
