import { describe, it, expect } from 'vitest'
import { installBackstack } from './backstack.js'

// A browser history in miniature: entries with a URL and a state, and a back() that fires
// popstate asynchronously, as browsers do. `listeners` stand in for window's popstate ones.
function fakeWindow(url = '/home') {
  const entries = [{ url, state: { idx: 0 } }]
  let i = 0
  const listeners = []
  const history = {
    get state() { return entries[i].state },
    get url() { return entries[i].url },
    get length() { return entries.length },
    pushState(state, _t, u) { entries.splice(i + 1); entries.push({ url: u || entries[i].url, state }); i++ },
    replaceState(state, _t, u) { entries[i] = { url: u || entries[i].url, state } },
    // following a link to another #/route: a new entry with no state, and a popstate
    hashNav(u) {
      entries.splice(i + 1); entries.push({ url: u, state: null }); i++
      const e = { stopped: false, stopImmediatePropagation() { this.stopped = true } }; listeners.forEach(f => f(e)); win.lastPop = e
    },
    back() {
      if (i === 0) return
      Promise.resolve().then(() => { i--; const e = { stopped: false, stopImmediatePropagation() { this.stopped = true } }; listeners.forEach(f => f(e)); win.lastPop = e })
    }
  }
  const win = { history, addEventListener: (_n, f) => listeners.push(f), lastPop: null }
  return win
}
const settle = () => new Promise(r => setTimeout(r, 0))

// The sheet store, reduced to what the back stack asks of it.
function sheetsFor() {
  const list = []
  return {
    list,
    api: {
      top: () => list.at(-1) || null,
      isOpen: id => list.some(s => s.id === id),
      dismissTop: () => { list.pop() }
    }
  }
}

function setup(url) {
  const win = fakeWindow(url)
  const sh = sheetsFor()
  const bs = installBackstack(win, sh.api)
  const open = (id, locked = false) => { sh.list.push({ id, locked }); bs.opened(id) }
  const closeFromUI = id => { sh.list.splice(sh.list.findIndex(s => s.id === id), 1); bs.closed(id) }
  const nav = u => win.history.pushState({ idx: win.history.length }, '', u)
  const back = async () => { win.history.back(); await settle() }
  return { win, sh, bs, open, closeFromUI, nav, back }
}

describe('back closes sheets before it changes the screen', () => {
  it('closes the open sheet and stays on the screen', async () => {
    const t = setup()
    t.nav('/stats')
    t.open('a')
    await t.back()
    expect(t.sh.list).toEqual([])
    expect(t.win.history.url).toBe('/stats')
    expect(t.win.lastPop.stopped).toBe(true)      // the router never sees it
  })

  it('closes stacked sheets one press at a time, top first', async () => {
    const t = setup()
    t.open('a'); t.open('b')
    await t.back()
    expect(t.sh.list.map(s => s.id)).toEqual(['a'])
    await t.back()
    expect(t.sh.list).toEqual([])
  })

  it('keeps a locked sheet open and still catches the next press', async () => {
    const t = setup()
    t.nav('/workout')
    t.open('summary', true)
    await t.back()
    expect(t.sh.list.map(s => s.id)).toEqual(['summary'])
    await t.back()
    expect(t.sh.list.map(s => s.id)).toEqual(['summary'])
    expect(t.win.history.url).toBe('/workout')
  })

  it('without a sheet, back is the router’s as before', async () => {
    const t = setup()
    t.nav('/stats')
    await t.back()
    expect(t.win.history.url).toBe('/home')
    expect(t.win.lastPop.stopped).toBe(false)
  })
})

describe('a sheet closed from the UI leaves no dead back press', () => {
  it('one press after closing a sheet goes to the previous screen', async () => {
    const t = setup()
    t.nav('/stats')
    t.open('a'); t.closeFromUI('a')
    await t.back()
    await settle()
    expect(t.win.history.url).toBe('/home')
  })

  it('close-then-navigate in one click keeps the navigation', async () => {
    const t = setup()
    t.nav('/workout')
    t.open('summary'); t.closeFromUI('summary'); t.nav('/plan')
    await settle()
    expect(t.win.history.url).toBe('/plan')
    await t.back(); await settle()
    expect(t.win.history.url).toBe('/workout')   // the screen the sheet was on
    await t.back(); await settle()
    expect(t.win.history.url).toBe('/home')      // and on from there in one press
  })

  it('a sheet closed from the UI under another one is skipped too', async () => {
    const t = setup()
    t.nav('/plan')
    t.open('a'); t.open('b'); t.closeFromUI('b')
    await t.back(); await settle()
    expect(t.sh.list).toEqual([])                 // that press closed a
    expect(t.win.history.url).toBe('/plan')
    await t.back(); await settle()
    expect(t.win.history.url).toBe('/home')
  })

  it('closing everything at once still takes one press to leave the screen', async () => {
    const t = setup()
    t.nav('/workout')
    t.open('a'); t.open('b')
    t.sh.list.length = 0; t.bs.closedAll()
    await t.back(); await settle(); await settle()
    expect(t.win.history.url).toBe('/home')
  })

  it('a tab that replaces a closed sheet’s entry skips the duplicate below it', async () => {
    const t = setup()
    t.nav('/plan')
    t.open('a'); t.closeFromUI('a')
    t.win.history.replaceState({ idx: 1 }, '', '/stats')   // tab switch: replace
    await t.back(); await settle()
    expect(t.win.history.url).toBe('/home')
  })
})

describe('a link to another screen is not a back press', () => {
  it('right after closing a sheet, the new screen stays', async () => {
    const t = setup()
    t.nav('/plan')
    t.open('a'); t.closeFromUI('a')
    t.win.history.hashNav('/workout')
    await settle(); await settle()
    expect(t.win.history.url).toBe('/workout')
    expect(t.win.lastPop.stopped).toBe(false)
  })

  it('with a sheet open, the router still gets the navigation', async () => {
    const t = setup()
    t.open('a')
    t.win.history.hashNav('/team')
    await settle()
    expect(t.win.history.url).toBe('/team')
    expect(t.win.lastPop.stopped).toBe(false)
  })
})

