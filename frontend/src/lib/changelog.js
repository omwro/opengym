// "What's new": the changelog, shown once after an update.
//
// CHANGELOG.md is the single source — no second list to keep in step. At build time a Vite
// plugin (vite.config.js) parses it with `parseChangelog` and bundles the newest entries as
// `virtual:changelog`. Each "### " section is one entry, identified by its title: a section
// keeps its title when "## Unreleased" becomes "## v1.x", so releasing never makes old news
// look new again.
//
// What a device has seen is kept on that device. A device that has never stored anything is a
// fresh install, not an update: it is shown nothing and everything counts as seen.
//
// No DOM or browser APIs here — the build imports this file under Node.

/** Newest first: [{ id, version, title, body }] from the changelog's markdown. */
export function parseChangelog(md, limit = 20) {
  const out = []
  let version = ''
  let cur = null
  const push = () => { if (cur) { cur.body = cur.body.join('\n').trim(); out.push(cur); cur = null } }
  for (const line of String(md || '').split('\n')) {
    const h2 = /^## (.+)/.exec(line)
    if (h2) { push(); version = h2[1].trim(); continue }
    const h3 = /^### (.+)/.exec(line)
    if (h3) { push(); const title = h3[1].trim(); cur = { id: title, version, title, body: [] }; continue }
    if (cur) cur.body.push(line)
  }
  push()
  return out.slice(0, limit)
}

/**
 * Which entries to show, and what to remember afterwards.
 * `seen` is the stored list of ids, or null on a device that never stored one.
 */
export function unseenEntries(entries, seen) {
  const ids = entries.map(e => e.id)
  if (!Array.isArray(seen)) return { show: [], remember: ids }
  const known = new Set(seen)
  // Kept to what is still in the bundle, so the list cannot grow forever.
  return { show: entries.filter(e => !known.has(e.id)), remember: ids }
}

/**
 * The little markdown the changelog uses, as blocks of inline runs, so the app can render it
 * without injecting HTML: paragraphs, "- " bullets (with indented continuation lines),
 * **bold**, *italic* and `code`.
 */
export function blocksOf(body) {
  const blocks = []
  let para = null
  let list = null
  const flush = () => {
    if (para) { blocks.push({ type: 'p', runs: runsOf(para.join(' ')) }); para = null }
    if (list) { blocks.push({ type: 'ul', items: list.map(i => runsOf(i)) }); list = null }
  }
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) { flush(); continue }
    const bullet = /^\s*[-*] (.*)/.exec(line)
    if (bullet) { if (para) flush(); list = list || []; list.push(bullet[1]); continue }
    if (list && /^\s+\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue }
    if (list) flush()
    para = para || []
    para.push(line.trim())
  }
  flush()
  return blocks
}

/** "**a** b *c* `d`" → [{ t: 'a', b: true }, { t: ' b ' }, { t: 'c', i: true }, …] */
export function runsOf(text) {
  const runs = []
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*/g
  let last = 0, m
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index) })
    if (m[1] != null) runs.push({ t: m[1], b: true })
    else if (m[2] != null) runs.push({ t: m[2], code: true })
    else runs.push({ t: m[3], i: true })
    last = re.lastIndex
  }
  if (last < text.length) runs.push({ t: text.slice(last) })
  return runs
}
