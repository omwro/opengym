// "What's new" — the changelog entries this device has not seen yet, shown once when the app
// opens after an update, and the whole recent list from Settings. See lib/changelog.js.
import { useEffect } from 'react'
import entries from 'virtual:changelog'
import { useUI } from '../store/useUI.js'
import { blocksOf, unseenEntries } from '../lib/changelog.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

const KEY = 'gym_seen_changes'
const readSeen = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : null } catch { return null } }
const writeSeen = ids => { try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* private mode: shown again next time, harmless */ } }

const Runs = ({ runs }) => runs.map((r, i) => r.b ? <b key={i}>{r.t}</b> : r.i ? <i key={i}>{r.t}</i> : r.code ? <code key={i}>{r.t}</code> : <span key={i}>{r.t}</span>)

function Entry({ e }) {
  return <div style={{ marginBottom: 18 }}>
    <h4 style={{ margin: '0 0 6px', fontSize: 16 }}>{e.title}</h4>
    {blocksOf(e.body).map((b, i) => b.type === 'ul'
      ? <ul key={i} className="small" style={{ margin: '0 0 8px', paddingLeft: 18, lineHeight: 1.45 }}>{b.items.map((it, k) => <li key={k} style={{ marginBottom: 4 }}><Runs runs={it} /></li>)}</ul>
      : <p key={i} className="small" style={{ margin: '0 0 8px', lineHeight: 1.45 }}><Runs runs={b.runs} /></p>)}
  </div>
}

function WhatsNew({ list, fresh, close }) {
  return <>
    <h3 className="row" style={{ gap: 8 }}><Icon name="sparkles" style={{ color: 'var(--acc)' }} />{t('What’s new')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {fresh ? t('openGym was updated since you last opened it.') : t('The latest changes to openGym.')}
    </div>
    {list.length ? list.map(e => <Entry key={e.id} e={e} />) : <div className="empty small">{t('Nothing to show.')}</div>}
    <Button variant="primary" onClick={close}>{t('Got it')}</Button>
  </>
}

/** The whole recent changelog, from Settings. */
export const whatsNewSheet = () => useUI.getState().openSheet(close => <WhatsNew list={entries} close={close} />)

/**
 * Once per app start: if this device has not seen some entries, show them — but never over a
 * running workout, and never on a fresh install. Seen is stored as soon as the sheet opens, so
 * closing the app with it open does not bring it back.
 */
export function useWhatsNew(enabled) {
  useEffect(() => {
    if (!enabled) return
    const { show, remember } = unseenEntries(entries, readSeen())
    if (!show.length) { writeSeen(remember); return }
    // After the first screen has settled, so it does not land on a loading state. Seen is
    // written when the sheet actually opens: an effect that is cleaned up and run again in the
    // meantime (React's dev double-run, `enabled` flickering) must still find it unseen.
    const tm = setTimeout(() => {
      writeSeen(remember)
      useUI.getState().openSheet(close => <WhatsNew list={show} fresh close={close} />)
    }, 600)
    return () => clearTimeout(tm)
  }, [enabled])
}
