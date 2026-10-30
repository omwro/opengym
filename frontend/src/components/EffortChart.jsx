// The team's effort over the last weeks: one line per member, scored 0–100 against their own
// plan and history (api/effort.js), so the chart shows who is putting in the work, not who is
// strongest. Your own line is drawn thicker. Tap or hover a week for everyone's score that week.
//
// Colours follow the member, never their rank: each member keeps the slot their position in the
// id-sorted team gives them, so someone overtaking someone else does not repaint either line.
// Eight validated slots (--series-1…8, index.css); a ninth member and beyond is drawn in the
// neutral ink rather than in a generated colour.
import { useLayoutEffect, useRef, useState } from 'react'
import { MONTHS } from '../lib/format.js'
import { t } from '../lib/i18n.js'

const W = 340
const H = 170
const P = { l: 26, r: 64, t: 10, b: 22 }   // right margin holds the end-of-line names
const SLOTS = 8

export const seriesColor = i => (i < SLOTS ? `var(--series-${i + 1})` : 'var(--label-3)')

/** Stable colour slot per member id: by sorted id, so it never depends on scores or order on screen. */
export function colorSlots(members) {
  const ids = members.map(m => m.id).sort()
  return Object.fromEntries(ids.map((id, i) => [id, i]))
}

const shortWeek = iso => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + t(MONTHS[d.getUTCMonth()]) }

export default function EffortChart({ members }) {
  const wrapRef = useRef(null), svgRef = useRef(null), tipRef = useRef(null)
  const [hover, setHover] = useState(null)       // week index

  const slots = colorSlots(members)
  const weeks = members[0]?.effort?.map(w => w.wk) || []
  const n = weeks.length
  const X = i => P.l + (n > 1 ? i / (n - 1) : 0.5) * (W - P.l - P.r)
  const Y = v => P.t + (1 - v / 100) * (H - P.t - P.b)

  // Others first, you last, so your line sits on top where they cross.
  const series = [...members].sort((a, b) => (a.you ? 1 : 0) - (b.you ? 1 : 0))

  // Names at the line ends, in the right margin. Kept apart by at least 11 units; one that had
  // to move gets a thin leader back to its line so it stays attached.
  const ends = series.map(m => ({ m, y: Y(m.effort.at(-1)?.score || 0) })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].y, (ends[i - 1].ly ?? ends[i - 1].y) + 11)
  if (ends.length) ends[0].ly = ends[0].y
  const over = (ends.at(-1)?.ly || 0) - (H - P.b)
  if (over > 0) ends.forEach(e => { e.ly -= over })

  useLayoutEffect(() => {
    const tip = tipRef.current, wrap = wrapRef.current
    if (hover == null || !tip || !wrap) return
    const cw = wrap.clientWidth, tw = tip.offsetWidth
    const cx = X(hover) / W * cw
    tip.style.left = Math.max(4, Math.min(cw - tw - 4, cx - tw / 2)) + 'px'
  })

  if (!n) return null
  const onMove = e => {
    const c = e.touches ? e.touches[0] : e
    if (!c || c.clientX === undefined) return
    const r = svgRef.current.getBoundingClientRect()
    const vx = (c.clientX - r.left) / (r.width || W) * W
    let best = 0
    for (let i = 1; i < n; i++) if (Math.abs(X(i) - vx) < Math.abs(X(best) - vx)) best = i
    setHover(best)
  }

  const atHover = hover == null ? [] : [...members]
    .map(m => ({ m, s: m.effort[hover]?.score || 0 }))
    .sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))

  return <div className="chart-i" ref={wrapRef}
    onMouseMove={onMove} onMouseDown={onMove} onMouseLeave={() => setHover(null)}
    onTouchStart={onMove} onTouchMove={onMove}>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ aspectRatio: `${W}/${H}`, display: 'block', width: '100%', height: 'auto' }}
      role="img" aria-label={t('Effort per week for every team member')}>
      {[0, 50, 100].map(v => <g key={v}>
        <line x1={P.l} x2={W - P.r} y1={Y(v)} y2={Y(v)} stroke="var(--sep-op)" strokeWidth="1" />
        <text x={P.l - 5} y={Y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--label-2)">{v}</text>
      </g>)}
      {weeks.map((wk, i) => (i % 2 === (n - 1) % 2) && <text key={wk} x={X(i)} y={H - 7} fontSize="9.5" fill="var(--label-2)"
        textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{i === n - 1 ? t('This week') : shortWeek(wk)}</text>)}
      {hover != null && <line x1={X(hover)} x2={X(hover)} y1={P.t} y2={H - P.b} stroke="var(--label-3)" strokeWidth="1" />}
      {series.map(m => {
        const color = seriesColor(slots[m.id])
        const pts = m.effort.map((w, i) => `${X(i).toFixed(1)},${Y(w.score).toFixed(1)}`).join(' ')
        return <g key={m.id}>
          <polyline points={pts} fill="none" stroke={color} strokeWidth={m.you ? 4 : 2} strokeLinejoin="round" strokeLinecap="round" />
          {/* the current week's point, ringed in the surface so it reads where lines meet */}
          <circle cx={X(n - 1)} cy={Y(m.effort.at(-1).score)} r={m.you ? 5 : 4} fill={color} stroke="var(--surface)" strokeWidth="2" />
          {hover != null && <circle cx={X(hover)} cy={Y(m.effort[hover].score)} r={m.you ? 5 : 4} fill={color} stroke="var(--surface)" strokeWidth="2" />}
        </g>
      })}
      {ends.map(({ m, y, ly }) => <g key={'l' + m.id}>
        {Math.abs(ly - y) > 2 && <line x1={X(n - 1) + 6} y1={y} x2={W - P.r + 6} y2={ly - 3} stroke="var(--label-3)" strokeWidth="1" />}
        <text x={W - P.r + 9} y={ly} fontSize="10" fontWeight={m.you ? 700 : 500} fill={m.you ? 'var(--label)' : 'var(--label-2)'}>
          {(m.you ? t('You') : m.name).slice(0, 9)} {m.effort.at(-1).score}
        </text>
      </g>)}
    </svg>
    {hover != null && <div className="ctip" ref={tipRef} style={{ top: 4 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{hover === n - 1 ? t('This week') : t('Week of {0}', shortWeek(weeks[hover]))}</div>
      {atHover.map(({ m, s }) => <div key={m.id} className="row" style={{ gap: 6, justifyContent: 'space-between' }}>
        <span className="row" style={{ gap: 5 }}>
          <i style={{ width: 8, height: 8, borderRadius: 4, background: seriesColor(slots[m.id]), display: 'inline-block' }} />
          <span style={{ fontWeight: m.you ? 700 : 400 }}>{m.you ? t('You') : m.name}</span>
        </span>
        <b>{s}</b>
      </div>)}
    </div>}
  </div>
}
