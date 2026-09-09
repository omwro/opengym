import { useState, useRef, useEffect } from 'react'
import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { listProfiles, login, createProfile } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

/* The first profile on a fresh instance.
 *
 * This is the only place a profile can be made without being signed in, because there is
 * nobody to sign in as yet. Every profile after this one is added from inside the app, by
 * somebody already using it. */
function FirstProfileSheet({ onDone, close }) {
  const { setUser, pushState, pullState } = useStore()
  const toast = useUI(s => s.toast)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])

  const go = async () => {
    const n = name.trim()
    if (!n) { toast(t('Enter a name')); return }
    if (!password) { toast(t('Enter the password')); return }
    setBusy(true)
    try {
      const u = await createProfile(n, password)
      setUser(u); close(); onDone?.()
      // Someone who has been training in guest mode keeps what they logged.
      if (hasData(useStore.getState().S)) { await pushState(); toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); toast(t('Welcome, {0}', u.name)) }
    } catch (e) { toast(e.message || t('Could not create the profile')) }
    finally { setBusy(false) }
  }

  return <>
    <h3>{t('Create the first profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('This server has no profiles yet. Once yours exists, everyone else is added from inside the app.')}
    </div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40}
      value={name} onChange={e => setName(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" placeholder={t('Password')} autoComplete="new-password"
      value={password} onChange={e => setPassword(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && go()} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={go}>{t('Create profile')}</Button>
  </>
}

export default function Login() {
  const { setUser, pullState, setGuest } = useStore()
  const toast = useUI(s => s.toast)
  const [profiles, setProfiles] = useState(null)   // null = still loading
  const [empty, setEmpty] = useState(false)
  const [picked, setPicked] = useState(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const pwRef = useRef(null)

  const load = () => listProfiles()
    .then(r => { setProfiles(r.profiles); setEmpty(r.empty) })
    .catch(() => setProfiles([]))
  useEffect(() => { if (!DEMO) load() }, [])
  useEffect(() => { if (picked) setTimeout(() => pwRef.current?.focus(), 120) }, [picked])

  const signIn = async () => {
    if (!password) { toast(t('Enter the password')); return }
    setBusy(true)
    try {
      const u = await login(picked.id, password)
      setUser(u); setPassword('')
      await pullState()
      toast(t('Welcome back, {0}', u.name))
    } catch (e) { toast(e.message || t('Sign-in failed')); setPassword('') }
    finally { setBusy(false) }
  }

  const head = <>
    <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>openGym</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  // A profile is chosen: ask for the password. Kept as a separate step so the picker stays a
  // list of names rather than a wall of inputs, and so the browser can offer to remember it.
  if (picked) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 26 }}>{t('Signing in as {0}', picked.name)}</div>
      <input ref={pwRef} className="input" type="password" placeholder={t('Password')}
        autoComplete="current-password" value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && signIn()} />
      <div style={{ height: 12 }} />
      <Button variant="primary" icon="person" disabled={busy} onClick={signIn}>{t('Sign in')}</Button>
      <div style={{ height: 10 }} />
      <Button variant="ghost" className="dim" onClick={() => { setPicked(null); setPassword('') }}>{t('Pick a different profile')}</Button>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Your workouts. Your weights. Your profile.')}</div>

      {profiles === null
        ? <div className="dim small">{t('Loading…')}</div>
        : empty
          ? <>
              <Button variant="primary" icon="sparkles"
                onClick={() => useUI.getState().openSheet(close => <FirstProfileSheet close={close} onDone={load} />)}>
                {t('Create the first profile')}
              </Button>
              <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
                {t('Nobody has signed up on this server yet. Create your profile, then add the others from inside the app.')}
              </div>
            </>
          : <>
              <div className="lbl2" style={{ marginBottom: 8 }}>{t("Who's training?")}</div>
              <div className="list">
                {profiles.map(p => (
                  <button key={p.id} className="item" onClick={() => setPicked(p)}>
                    <span className="lrow-i"><Icon name="personCircle" /></span>
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'left', fontWeight: 600 }}>{p.name}</div>
                    <Icon name="chevronRight" className="chev" />
                  </button>
                ))}
              </div>
            </>}

      <div style={{ height: 14 }} />
      <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>
        {t('One password for everyone on this server.')}<br />
        {t('Each profile keeps its own plan, workouts & body weight.')}
      </div>
    </div>
  )
}
