// The team's note on an exercise — handles, machine, seat height. One note per exercise,
// shared by everyone on the server (lib/notes.js), shown wherever the exercise is: during a
// workout, and in Plan when you set the exercise up. Whoever works it out once saves everyone
// else the same fiddling, and a correction made in one place is the note everywhere.
import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { useNotes, notesAvailable } from '../lib/notes.js'
import { exOr } from '../lib/exercises.js'
import { fmtDate } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

function NoteEditor({ exId, note, close }) {
  const save = useNotes(s => s.save)
  const toast = useUI(s => s.toast)
  const [text, setText] = useState(note?.text || '')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await save(exId, text); close(); toast(text.trim() ? t('Note saved for everyone') : t('Note removed')) }
    catch (e) { toast(e.message || t('Could not save the note')) }
    finally { setBusy(false) }
  }
  return <>
    <h3 className="capitalize">{exOr(exId).n}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Shared with everyone on this server — which handle, which machine, seat height. Leave it empty to remove it.')}</div>
    <textarea className="input" rows={4} maxLength={500} value={text} autoFocus
      placeholder={t('e.g. V-handle, seat on 4, the machine by the window')}
      onChange={e => setText(e.target.value)} style={{ resize: 'vertical', minHeight: 96 }} />
    {note && <div className="dim small" style={{ marginTop: 6 }}>{t('Last edited by {0}', note.byName)}</div>}
    <div style={{ height: 12 }} />
    <Button variant="primary" icon="check" disabled={busy} onClick={go}>{t('Save')}</Button>
  </>
}

/** Open the editor for an exercise's note (the current note, or a new one). */
export const noteSheet = (exId, note) => useUI.getState().openSheet(close => <NoteEditor exId={exId} note={note} close={close} />)

/**
 * The note as a tappable card, or an "add a note" link when there is none. Renders nothing for
 * a guest or an instance without teams — notes live on the server.
 */
export default function ExerciseNote({ exId, style }) {
  const note = useNotes(st => st.notes[exId])
  // Fetched when a screen that shows a note opens, so a note added on someone else's phone
  // since is there — the load is a single small request and is skipped without a server.
  useEffect(() => { if (notesAvailable()) useNotes.getState().load({ maxAge: 60000 }) }, [])
  if (!notesAvailable()) return null
  return note
    ? <button className="exnote tappable" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, ...style }} onClick={() => noteSheet(exId, note)}>
        <span className="row" style={{ gap: 6, alignItems: 'flex-start' }}><Icon name="pencil" style={{ flex: 'none', marginTop: 2, fontSize: 13 }} /><span style={{ whiteSpace: 'pre-wrap' }}>{note.text}</span></span>
        <span className="dim" style={{ display: 'block', fontSize: '.72rem', marginTop: 4 }}>{note.byName} · {fmtDate(new Date(note.at).toISOString().slice(0, 10), true)}</span>
      </button>
    : <button className="dim small" style={{ marginBottom: 8, padding: '2px 0', ...style }} onClick={() => noteSheet(exId, null)}>+ {t('Add a note for everyone (handles, machine, settings)')}</button>
}
