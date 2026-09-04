/* Body measurements — the tape-measure half of the logbook.
 *
 * Training shows up in the numbers on the bar long before it shows up on a scale, and not at
 * all in a single body-weight line: a chest that has gained 3 cm while weight held still is
 * the whole story of a cut. This screen is that record.
 *
 * Left and right are logged separately throughout. A gap between arms is worth seeing, and
 * averaging it away is the one thing that guarantees you never will.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fmtNum, fmtDate, todayISO } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import {
  FIELDS, SINGLES, PAIRS, sorted, filled, stats, delta, sideGap, clean, isEmpty,
  labelOf, lengthUnit, series, missingForBodyFat
} from '../lib/measures.js'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button, TextField, SelectRow } from '../components/ui.jsx'

const ui = () => useUI.getState()

/* ============================ logging a measurement ============================ */

function MeasureForm({ existing, close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const unit = lengthUnit(S)
  const last = sorted(S)[0]
  const [d, setD] = useState(existing?.d || todayISO())
  const [vals, setVals] = useState(() =>
    Object.fromEntries(FIELDS.map(f => [f.id, existing?.[f.id] ?? ''])))

  const set = (id, v) => setVals(x => ({ ...x, [id]: v.replace(',', '.') }))
  // Live, so you can see the estimate answer to the tape while you are still holding it.
  const draft = clean(vals, d)
  const preview = stats(S, draft)
  const missing = missingForBodyFat(S, draft)

  const save = () => {
    if (isEmpty(draft)) { toast(t('Fill in at least one measurement')); return }
    update(s => {
      s.measures = (s.measures || []).filter(m => m.d !== d && m.d !== existing?.d)
      s.measures.push(draft)
    })
    close()
    toast(existing ? t('Measurement updated') : t('Measurement saved'))
  }

  // Last time's number as the placeholder: it is the value you are usually about to confirm,
  // and it makes an unchanged field obvious without pre-filling something you did not measure.
  const ph = id => (Number.isFinite(last?.[id]) ? String(last[id]) : '–')

  return <>
    <h3>{existing ? t('Edit measurement') : t('New measurement')}</h3>
    <div className="muted small" style={{ margin: '4px 0 14px', lineHeight: 1.45 }}>
      {t('Measure relaxed, and at the same time of day — the trend is what you are after, not any single number.')}
    </div>

    <label className="lbl2" style={{ display: 'block', marginBottom: 4 }}>{t('Date')}</label>
    <TextField type="date" value={d} onChange={e => setD(e.target.value)} max={todayISO()} />

    <h4 className="sec">{t('Torso')} <span className="dim" style={{ textTransform: 'none' }}>· {unit}</span></h4>
    <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {SINGLES.map(f => <label key={f.id} style={{ display: 'block' }}>
        <span className="lbl2">{labelOf(f.id)}</span>
        <TextField inputMode="decimal" style={{ textAlign: 'center' }} placeholder={ph(f.id)}
          value={vals[f.id]} onChange={e => set(f.id, e.target.value)} />
      </label>)}
    </div>

    <h4 className="sec">{t('Left & right')} <span className="dim" style={{ textTransform: 'none' }}>· {unit}</span></h4>
    {PAIRS.map(({ group, left, right }) => {
      const gap = sideGap(draft, group)
      return <div key={group} style={{ marginBottom: 10 }}>
        <div className="row between" style={{ marginBottom: 4 }}>
          <span className="lbl2">{t(group)}</span>
          {!!gap && <span className="dim" style={{ fontSize: '.72rem' }}>
            {t('{0} {1} difference — {2} larger', fmtNum(Math.abs(gap)), unit, gap > 0 ? t('right') : t('left'))}
          </span>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {[left, right].map(f => <div key={f.id} style={{ flex: 1, position: 'relative' }}>
            <span className="dim" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '.72rem', fontWeight: 700 }}>{f.side}</span>
            <TextField inputMode="decimal" style={{ textAlign: 'center', paddingLeft: 26 }} placeholder={ph(f.id)}
              value={vals[f.id]} onChange={e => set(f.id, e.target.value)} />
          </div>)}
        </div>
      </div>
    })}

    {preview.bodyFat != null
      ? <div className="card row between" style={{ marginTop: 14 }}>
          <span className="muted small">{t('Estimated body fat')}</span>
          <b style={{ color: 'var(--acc)' }}>{fmtNum(preview.bodyFat)}%</b>
        </div>
      : <div className="dim small" style={{ margin: '14px 2px 0', lineHeight: 1.45 }}>
          {t('Add {0} for a body-fat estimate.', missing.join(', '))}
        </div>}

    <div style={{ height: 14 }} />
    <Button variant="primary" icon="check" onClick={save}>{t('Save')}</Button>
  </>
}

export const measureSheet = existing => ui().openSheet(close => <MeasureForm existing={existing} close={close} />)

/* ============================ one entry ============================ */

function EntrySheet({ entry, close }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const unit = lengthUnit(S)
  const s = stats(S, entry)

  const remove = () => confirmSheet({
    title: t('Delete this measurement?'),
    message: t('The entry from {0} is removed. Nothing else changes.', fmtDate(entry.d, true)),
    confirmText: t('Delete'), danger: true,
    onConfirm: () => {
      update(st => { st.measures = (st.measures || []).filter(m => m.d !== entry.d) })
      close(); toast(t('Measurement deleted'))
    }
  })

  return <>
    <h3>{fmtDate(entry.d, true)}</h3>
    {(s.bodyFat != null || s.weight != null) && <div className="tiles" style={{ textAlign: 'left', marginTop: 12 }}>
      {s.weight != null && <div className="tile"><div className="l">{t('Body weight')}</div><div className="v" style={{ fontSize: '1.2rem' }}>{fmtNum(s.weight)} {S.unit}</div></div>}
      {s.bodyFat != null && <div className="tile"><div className="l">{t('Body fat')}</div><div className="v" style={{ fontSize: '1.2rem' }}>{fmtNum(s.bodyFat)}%</div></div>}
      {s.lean != null && <div className="tile"><div className="l">{t('Lean mass')}</div><div className="v" style={{ fontSize: '1.2rem' }}>{fmtNum(s.lean)} {S.unit}</div></div>}
      {s.ffmi != null && <div className="tile"><div className="l">FFMI</div><div className="v" style={{ fontSize: '1.2rem' }}>{fmtNum(s.ffmi)}</div></div>}
    </div>}

    <h4 className="sec">{t('Measurements')}</h4>
    <div className="list" style={{ gap: 0 }}>
      {filled(entry).map(f => <div key={f.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <span className="small">{labelOf(f.id)}</span>
        <b className="small">{fmtNum(entry[f.id])} {unit}</b>
      </div>)}
    </div>

    {s.whtr != null && <div className="dim small" style={{ margin: '12px 2px 0', lineHeight: 1.45 }}>
      {t('Waist to height {0} — {1}', s.whtr, s.whtr < 0.5 ? t('below the 0.50 marker') : t('the usual advice is to aim below 0.50'))}
    </div>}

    <div style={{ height: 16 }} />
    <Button variant="tinted" icon="pencil" onClick={() => { close(); measureSheet(entry) }}>{t('Edit')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="danger" icon="trash" onClick={remove}>{t('Delete')}</Button>
  </>
}

/* ============================ screen ============================ */

/** One tile per measurement, with a left/right pair kept together as a single "35 / 37". */
function tilesFor(S, m) {
  const tiles = [];
  for (const f of SINGLES) {
    if (!Number.isFinite(m[f.id])) continue;
    tiles.push({
      key: f.id, label: labelOf(f.id), value: fmtNum(m[f.id]),
      trend: delta(S, f.id), lowerIsBetter: f.id === 'waist'
    });
  }
  for (const p of PAIRS) {
    const l = m[p.left.id], r = m[p.right.id];
    const has = [Number.isFinite(l), Number.isFinite(r)];
    if (!has[0] && !has[1]) continue;
    if (has[0] && has[1]) {
      tiles.push({ key: p.group, label: t(p.group) + ' L/R', value: `${fmtNum(l)} / ${fmtNum(r)}`, gap: sideGap(m, p.group) });
    } else {
      // Only one side measured — say which, rather than showing a number that reads as both.
      const f = has[0] ? p.left : p.right;
      tiles.push({ key: f.id, label: labelOf(f.id), value: fmtNum(m[f.id]), trend: delta(S, f.id) });
    }
  }
  return tiles;
}

const Trend = ({ value, unit, lowerIsBetter }) => {
  if (!value) return null
  const good = lowerIsBetter ? value < 0 : value > 0
  return <span className="row" style={{ gap: 3, color: good ? 'var(--acc)' : 'var(--label-2)', fontSize: '.72rem', fontWeight: 600 }}>
    <Icon name={value > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 11 }} />
    {fmtNum(Math.abs(value))} {unit}
  </span>
}

export default function Measures() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const all = sorted(S)
  const unit = lengthUnit(S)
  const latest = all[0]
  const [field, setField] = useState('chest')
  const pts = series(S, field)
  const st = latest ? stats(S, latest) : null

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 12 }}>
        <h1>{t('Measurements')}</h1>
        <div className="sub">{all.length ? t(all.length === 1 ? '{0} entry' : '{0} entries', all.length) : t('Tape measure')}</div>
      </div>
    </div>

    <Button variant="primary" icon="plus" onClick={() => measureSheet()}>{t('Log a measurement')}</Button>
    <div style={{ height: 14 }} />

    {!all.length ? <div className="empty">
      <div className="ico"><Icon name="target" /></div>
      {t('No measurements yet. A tape measure catches progress a scale misses — a chest up 3 cm at the same body weight is the whole point.')}
    </div> : <>
      <div className="card">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{t('Latest')}</h2>
          <span className="dim small">{fmtDate(latest.d, true)}</span>
        </div>
        {/* Paired fields share a tile. Split across two, "Left biceps 35" can appear while its
            other half falls off the end — hiding the one comparison the pair exists to make. */}
        <div className="tiles" style={{ textAlign: 'left', marginBottom: 0 }}>
          {tilesFor(S, latest).map(tile => <div key={tile.key} className="tile">
            <div className="l">{tile.label}</div>
            <div className="v" style={{ fontSize: '1.25rem' }}>
              {tile.value} <span className="dim" style={{ fontSize: '.7rem' }}>{unit}</span>
            </div>
            {tile.gap != null
              ? <span className="dim" style={{ fontSize: '.7rem' }}>
                  {tile.gap === 0 ? t('even') : t('{0} {1} apart', fmtNum(Math.abs(tile.gap)), unit)}
                </span>
              : <Trend value={tile.trend} unit={unit} lowerIsBetter={tile.lowerIsBetter} />}
          </div>)}
        </div>
        {st?.bodyFat != null && <div className="row between" style={{ marginTop: 12, paddingTop: 10, borderTop: 'var(--hair) solid var(--sep)' }}>
          <span className="muted small">{t('Body fat')} · {t('lean')} {st.lean != null ? fmtNum(st.lean) + ' ' + S.unit : '—'}{st.ffmi != null ? ' · FFMI ' + fmtNum(st.ffmi) : ''}</span>
          <b style={{ color: 'var(--acc)' }}>{fmtNum(st.bodyFat)}%</b>
        </div>}
      </div>

      {pts.length > 1 && <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('Trend')}</h2>
        </div>
        <SelectRow icon="chartLine" title={t('Measurement')} value={field} onChange={setField}
          sheetTitle={t('Measurement')}
          options={FIELDS.filter(f => series(S, f.id).length).map(f => ({ value: f.id, label: labelOf(f.id) }))} />
        <div className="chart" style={{ marginTop: 8 }}><LineChart points={pts} h={140} unit={unit} /></div>
      </div>}

      <h4 className="sec">{t('All measurements')}</h4>
      <div className="list">
        {all.map(m => {
          const line = filled(m).slice(0, 4).map(f => `${labelOf(f.id)} ${fmtNum(m[f.id])}`).join(' · ')
          return <button key={m.d} className="item" onClick={() => ui().openSheet(close => <EntrySheet entry={m} close={close} />)}>
            <span className="lrow-i"><Icon name="target" /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{fmtDate(m.d, true)}</div>
              <div className="dim small" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line}</div>
            </div>
            <Icon name="chevronRight" className="chev" />
          </button>
        })}
      </div>
    </>}
    <div style={{ height: 24 }} />
  </div>
}
