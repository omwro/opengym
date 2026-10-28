import { describe, it, expect } from 'vitest'
import { parseChangelog, unseenEntries, blocksOf, runsOf } from './changelog.js'

const MD = `# Changelog

## Unreleased

### Warm-up sets

Each exercise can have **warm-up sets**.

- one
- two, which
  wraps onto a second line

### Home sessions

Train at home.

## v1.2.3 — 2026-07-31

### The screen stays on

Old news.
`

describe('parseChangelog', () => {
  it('reads every ### section as an entry, newest first, with its version', () => {
    const e = parseChangelog(MD)
    expect(e.map(x => [x.title, x.version])).toEqual([
      ['Warm-up sets', 'Unreleased'], ['Home sessions', 'Unreleased'], ['The screen stays on', 'v1.2.3 — 2026-07-31']
    ])
    expect(e[1].body).toBe('Train at home.')
  })
  it('keeps only the newest entries', () => {
    expect(parseChangelog(MD, 2)).toHaveLength(2)
    expect(parseChangelog('')).toEqual([])
  })
})

describe('unseenEntries', () => {
  const entries = parseChangelog(MD)
  it('shows a fresh install nothing, and remembers everything', () => {
    expect(unseenEntries(entries, null)).toEqual({ show: [], remember: entries.map(e => e.id) })
  })
  it('after an update, shows only what is new', () => {
    const r = unseenEntries(entries, ['Home sessions', 'The screen stays on'])
    expect(r.show.map(e => e.title)).toEqual(['Warm-up sets'])
  })
  it('does not re-show an entry when Unreleased becomes a version', () => {
    const released = parseChangelog(MD.replace('## Unreleased', '## v1.2.4 — 2026-11-01'))
    expect(unseenEntries(released, entries.map(e => e.id)).show).toEqual([])
  })
})

describe('the little markdown', () => {
  it('splits paragraphs and bullets, joining wrapped bullet lines', () => {
    const b = blocksOf(parseChangelog(MD)[0].body)
    expect(b.map(x => x.type)).toEqual(['p', 'ul'])
    expect(b[1].items).toHaveLength(2)
    expect(b[1].items[1].map(r => r.t).join('')).toBe('two, which wraps onto a second line')
  })
  it('marks bold, italic and code', () => {
    expect(runsOf('a **b** *c* `d`')).toEqual([{ t: 'a ' }, { t: 'b', b: true }, { t: ' ' }, { t: 'c', i: true }, { t: ' ' }, { t: 'd', code: true }])
  })
})
