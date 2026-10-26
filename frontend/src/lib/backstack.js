// The Android back button (and the edge-swipe back gesture, which is the same signal) for
// sheets. The router already gives every screen a history entry; sheets live outside the
// router, so back used to skip over an open sheet and change the screen underneath it.
//
// Opening a sheet pushes a history entry on top of the screen's own — same URL, marked with
// the sheet's id — so back pops that entry first and closes the sheet.
//
// The awkward direction is closing a sheet from the UI (its button, the backdrop, a swipe).
// Its entry should go too, but `history.back()` cannot be used for that: it is asynchronous,
// and plenty of buttons close a sheet and navigate in the same click (`close(); nav('/home')`)
// — the queued back would then undo the navigation. So the entry is kept and turned into an
// invisible "filler": it shows the same screen as the entry under it, and a back press that
// leaves a filler goes back once more, so it is never a press that seems to do nothing.
//
// Pure apart from the window it is handed, so the bookkeeping can be tested without a browser.

const KEYS = ['ogSheet', 'ogFiller', 'ogSkip']
const clean = state => {
  const s = { ...(state || {}) }
  for (const k of KEYS) delete s[k]
  return s
}

/**
 * @param win     the window (or a stand-in with `history` and `addEventListener`)
 * @param sheets  { top(): {id, locked} | null, isOpen(id): boolean, dismissTop(): void }
 * @returns       { opened(id), closed(id), closedAll() } — call these as sheets come and go
 */
export function installBackstack(win, sheets) {
  const h = win.history
  const rawPush = h.pushState.bind(h)
  const rawReplace = h.replaceState.bind(h)
  // The state of the entry we are on. Read from our own bookkeeping rather than h.state at
  // pop time, because a pop has already moved h.state to the entry we landed on.
  let cur = h.state

  // An entry that shows nothing of its own: a filler, or a sheet entry whose sheet is gone
  // (several sheets closed at once leave the lower entries behind).
  const invisible = s => !!s && (!!s.ogFiller || (!!s.ogSheet && !sheets.isOpen(s.ogSheet)))

  // Navigations are watched, not changed, so `cur` stays right. One exception: a screen that
  // *replaces* an invisible entry (a tab switch does) sits on top of a duplicate of the old
  // screen, so it is marked to skip that duplicate on the way back.
  h.pushState = (state, ...rest) => { rawPush(state, ...rest); cur = h.state }
  h.replaceState = (state, ...rest) => {
    const skip = invisible(cur) || !!cur?.ogSkip
    rawReplace(skip && state && typeof state === 'object' ? { ...state, ogSkip: true } : state, ...rest)
    cur = h.state
  }

  win.addEventListener('popstate', e => {
    const prev = cur
    cur = h.state
    const top = sheets.top()
    // Back popped the top sheet's own entry: close that sheet and nothing else. The router is
    // kept out of it — the URL is the screen's and has not changed.
    if (top && prev?.ogSheet === top.id && cur?.ogSheet !== top.id) {
      e.stopImmediatePropagation?.()
      // A sheet that holds on (the workout summary) must not be dismissed by accident; put its entry
      // back so the next press is still caught by it.
      if (top.locked) { rawPush({ ...clean(cur), ogSheet: top.id }, ''); cur = h.state; return }
      sheets.dismissTop()
      return
    }
    // Left an entry that looked like the one below it: that press did nothing visible, so it
    // continues one step further.
    if (invisible(prev) || prev?.ogSkip) h.back()
  }, true)   // capture: ahead of the router's own listener, so it can be kept out above

  return {
    opened(id) { rawPush({ ...clean(cur), ogSheet: id }, ''); cur = h.state },
    closed(id) {
      if (cur?.ogSheet !== id) return       // not the top entry: it is left behind, invisible
      rawReplace({ ...clean(cur), ogFiller: true }, ''); cur = h.state
    },
    closedAll() {
      if (!cur?.ogSheet) return
      rawReplace({ ...clean(cur), ogFiller: true }, ''); cur = h.state
    }
  }
}
