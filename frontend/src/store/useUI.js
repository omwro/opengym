import { create } from 'zustand'
import { uid } from '../lib/format.js'
import { beep, vibrate, countdown, chime } from '../lib/sound.js'
import { clearNotifications } from '../lib/push.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { useStore } from './useStore.js'

// Fire-and-forget: lets the server push a "rest over" alert if this tab gets suspended
// before the local timer completes. No-ops for guests / offline.
const pushRestTimer = sec => { if (useStore.getState().user) api('/api/push/rest-timer', { method: 'POST', body: JSON.stringify({ seconds: sec }) }).catch(() => {}) }
const cancelPushRestTimer = () => { if (useStore.getState().user) api('/api/push/rest-timer/cancel', { method: 'POST', body: '{}' }).catch(() => {}) }

let toastTm = null
let timerInt = null
let timerTick = null
let restCountdown = null
let workCountdown = null
let workInt = null
let workTick = null
let workDone = null

export const useUI = create((set, get) => ({
  sheets: [],          // { id, render:(close)=>JSX, kind:'sheet'|'center', locked }
  toastMsg: '',
  timer: null,         // rest countdown between sets — { left, total, endsAt }
  work: null,          // work countdown DURING a timed set (issue #16) — { left, total, endsAt, label }

  openSheet(render, { kind = 'sheet', locked = false } = {}) {
    const id = uid()
    set(s => ({ sheets: [...s.sheets, { id, render, kind, locked }] }))
    const close = () => get().closeSheet(id)
    return { id, close, lock: v => set(s => ({ sheets: s.sheets.map(x => x.id === id ? { ...x, locked: v } : x) })) }
  },
  closeSheet(id) { set(s => ({ sheets: s.sheets.filter(x => x.id !== id) })) },
  closeAll() { set({ sheets: [] }) },

  toast(msg) {
    set({ toastMsg: msg })
    clearTimeout(toastTm)
    toastTm = setTimeout(() => set({ toastMsg: '' }), 2200)
  },

  startRest(sec) {
    get().stopRest()
    const endsAt = Date.now() + sec * 1000
    set({ timer: { left: sec, total: sec, endsAt } })
    pushRestTimer(sec)
    timerTick = () => {
      const tm = get().timer
      if (!tm) return
      const snd = useStore.getState().S.sound
      const remaining = (tm.endsAt - Date.now()) / 1000
      // Start the whole countdown as one clip as soon as it is due, so the music stays ducked
      // through the gaps. It carries the final beep too, which is then not played again.
      if (!restCountdown && remaining <= 3.5 && remaining > 0.3) restCountdown = countdown(snd, remaining)
      const left = Math.max(0, Math.round(remaining))
      if (left === tm.left) return
      if (left <= 0) {
        if (!restCountdown) chime(snd)
        restCountdown = null       // let it ring out; stopRest below must not cut it off
        vibrate([200, 100, 200]); get().toast(t('Rest over — next set!')); get().stopRest()
        // The server push can land at the same moment even though the page is on screen (the
        // cancel races it). A push has to show a notification, so tidy it away just after.
        if (document.visibilityState === 'visible') { setTimeout(() => clearNotifications('rest-timer'), 3000); setTimeout(() => clearNotifications('rest-timer'), 9000) }
        return
      }
      set({ timer: { ...tm, left } })
    }
    timerInt = setInterval(timerTick, 250)
    document.addEventListener('visibilitychange', timerTick)
  },
  addRest(sec) {
    const tm = get().timer
    if (!tm) return
    const left = tm.left + sec
    // taking off more than is left means "I'm ready now" — same as skipping, and it keeps a
    // negative duration out of both the progress bar and the server-side push schedule
    if (left <= 0) { get().stopRest(); return }
    // The end moved, so a countdown already playing is now counting to the wrong moment.
    restCountdown?.stop(); restCountdown = null
    set({ timer: { ...tm, left, total: tm.total + sec, endsAt: tm.endsAt + sec * 1000 } })
    pushRestTimer(left)
  },
  stopRest() {
    // Skipping mid-countdown silences it; a countdown that reached zero was released above.
    restCountdown?.stop(); restCountdown = null
    if (timerInt) clearInterval(timerInt); timerInt = null
    if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
    if (get().timer) cancelPushRestTimer()
    set({ timer: null })
  },

  /* ---- work timer (issue #16) ----
     Times the set itself, not the recovery after it. Kept separate from the rest timer on
     purpose: the two mean opposite things, they must never run together, and a work set is
     something you are watching — so it gets no server push (that endpoint says "rest over",
     and a plank does not need a notification you are staring at anyway).
     `onDone(elapsedSec)` is called both when the countdown reaches zero and on an early
     finish; the elapsed time is what actually gets logged, so stopping at 0:38 of a 0:45
     hold records 0:38 rather than crediting the full target. */
  startWork(sec, label, onDone) {
    get().stopWork()
    get().stopRest()
    const total = Math.max(1, Math.round(sec) || 1)
    const endsAt = Date.now() + total * 1000
    workDone = onDone
    set({ work: { left: total, total, endsAt, label } })
    workTick = () => {
      const wk = get().work
      if (!wk) return
      const snd = useStore.getState().S.sound
      const remaining = (wk.endsAt - Date.now()) / 1000
      if (!workCountdown && remaining <= 3.5 && remaining > 0.3) workCountdown = countdown(snd, remaining)
      const left = Math.max(0, Math.round(remaining))
      if (left === wk.left) return
      if (left <= 0) {
        if (!workCountdown) chime(snd)
        workCountdown = null
        vibrate([200, 100, 200])
        const done = workDone
        get().stopWork()
        if (done) done(wk.total)
        return
      }
      set({ work: { ...wk, left } })
    }
    workInt = setInterval(workTick, 250)
    document.addEventListener('visibilitychange', workTick)
  },
  // Ended the hold early — log what was actually held.
  finishWorkEarly() {
    const wk = get().work
    if (!wk) return
    const elapsed = Math.max(1, wk.total - wk.left)
    const done = workDone
    vibrate(30)
    get().stopWork()
    if (done) done(elapsed)
  },
  // Abandon without logging anything.
  stopWork() {
    workCountdown?.stop(); workCountdown = null      // ended early mid-countdown: silence it
    if (workInt) clearInterval(workInt); workInt = null
    if (workTick) document.removeEventListener('visibilitychange', workTick); workTick = null
    workDone = null
    set({ work: null })
  }
}))
