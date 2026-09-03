/* Team — a training group that shares its schemes and can see how everyone is doing.
 *
 * Everything on this screen is other people's data, fetched live and never merged into the
 * local state blob. The one thing that crosses over is a shared scheme, and it crosses
 * through the plan-share import that already exists: taking a teammate's plan ADDS routines
 * to yours, exactly as importing their plan file would, so nothing you built is overwritten.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fmtDate, fmtNum, fmtVol, todayISO } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { buildPlanBundle, parsePlan } from '../lib/plan-share.js'
import { confirmSheet, planImportSheet } from '../sheets.jsx'
import * as T from '../lib/team-api.js'
import { useTeam } from '../lib/team-api.js'
import Icon from '../components/Icon.jsx'
import { Button, TextField, Segmented } from '../components/ui.jsx'

const ui = () => useUI.getState()

/** "2h ago" — teams are read at a glance; an exact timestamp is noise here. */
function rel(iso) {
  if (!iso) return null
  const days = Math.round((new Date(todayISO()) - new Date(iso)) / 86400000)
  if (days <= 0) return t('today')
  if (days === 1) return t('yesterday')
  if (days < 7) return t('{0}d ago', days)
  return fmtDate(iso)
}

/* ============================ no team yet ============================ */

function Start({ onTeam }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useUI(s => s.toast)

  const run = (fn, arg) => {
    if (busy) return
    setBusy(true)
    fn(arg).then(({ team }) => onTeam(team)).catch(e => toast(e.message)).finally(() => setBusy(false))
  }

  return <>
    <div className="empty">
      <div className="ico"><Icon name="personCircle" /></div>
      {t('Train with other people. Share the schemes you write, and see what everyone actually logged.')}
    </div>
    <div className="card">
      <h4 style={{ marginBottom: 8 }}>{t('Start a team')}</h4>
      <TextField value={name} onChange={e => setName(e.target.value)} placeholder={t('Team name')} maxLength={40} />
      <div style={{ height: 10 }} />
      <Button variant="primary" icon="plus" disabled={!name.trim() || busy} onClick={() => run(T.createTeam, name.trim())}>{t('Create team')}</Button>
      <div className="dim small" style={{ margin: '7px 2px 0', lineHeight: 1.4 }}>{t('You get a join code to pass around. Anyone with it is in.')}</div>
    </div>
    <div className="card">
      <h4 style={{ marginBottom: 8 }}>{t('Got a code?')}</h4>
      <TextField value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABC123"
        autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={12} />
      <div style={{ height: 10 }} />
      <Button variant="tinted" icon="link" disabled={code.trim().length < 4 || busy} onClick={() => run(T.joinTeam, code.trim())}>{t('Join team')}</Button>
    </div>
  </>
}

/* ============================ members ============================ */

function MemberRow({ m, onOpen }) {
  return <button className="item" onClick={() => onOpen(m)}>
    <span className="lrow-i" style={{ background: m.live ? 'var(--orange)' : 'var(--surface-3)' }}>
      <Icon name={m.live ? 'timer' : 'person'} />
    </span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="row" style={{ gap: 6 }}>
        <span style={{ fontWeight: 600 }} className="capitalize">{m.name}</span>
        {m.you && <span className="tag">{t('you')}</span>}
      </div>
      <div className="dim small" style={{ marginTop: 2 }}>
        {m.live
          ? t('training now · {0} of {1} exercises', (m.live.exIdx ?? 0) + 1, m.live.exTotal || '?')
          : m.last
            ? t(m.week === 1 ? '{0} session this week · last {1}' : '{0} sessions this week · last {1}', m.week, rel(m.last))
            : t('no sessions logged yet')}
      </div>
    </div>
    <div style={{ textAlign: 'right' }}>
      {m.streak > 0 && <div className="row" style={{ gap: 4, justifyContent: 'flex-end', color: 'var(--orange)', fontWeight: 600 }}>
        <Icon name="flame" style={{ fontSize: 13 }} />{m.streak}
      </div>}
      <div className="dim" style={{ fontSize: '.72rem', marginTop: 2 }}>{m.vol7 ? fmtVol(m.vol7, m.unit) : '—'}</div>
    </div>
  </button>
}

function MemberSheet({ id, close }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { T.getMember(id).then(r => setD(r.member)).catch(e => setErr(e.message)) }, [id])
  if (err) return <div className="empty small">{err}</div>
  if (!d) return <div className="muted small">{t('Loading…')}</div>
  const recent = (d.history || []).slice(0, 20)   // the server sends it newest-first
  return <>
    <h3 className="capitalize">{d.name}</h3>
    <div className="tiles" style={{ textAlign: 'left', marginTop: 12 }}>
      <div className="tile"><div className="l">{t('Sessions')}</div><div className="v" style={{ fontSize: '1.3rem' }}>{d.workouts}</div></div>
      <div className="tile"><div className="l">{t('Week streak')}</div><div className="v" style={{ fontSize: '1.3rem' }}>{d.streak}</div></div>
      <div className="tile"><div className="l">{t('Volume, 30d')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{fmtVol(d.vol30, d.unit)}</div></div>
      <div className="tile"><div className="l">{t('PRs, 30d')}</div><div className="v" style={{ fontSize: '1.3rem' }}>{d.prs30}</div></div>
    </div>
    {d.bw && <div className="muted small" style={{ marginBottom: 4 }}>
      {t('Body weight')} · {fmtNum(d.bw.w)} {d.unit} · {fmtDate(d.bw.d, true)}
    </div>}
    <h4 className="sec">{t('Recent sessions')}</h4>
    {recent.length ? <div className="list" style={{ gap: 0 }}>
      {recent.map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div>
          <div className="small" style={{ fontWeight: 600 }}>{w.name || t('Workout')}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)}{w.prs?.length ? ' · ' + t(w.prs.length === 1 ? '{0} PR' : '{0} PRs', w.prs.length) : ''}</div>
        </div>
        <span className="small muted">{fmtVol(Math.round(w.vol || 0), d.unit)}</span>
      </div>)}
    </div> : <div className="empty small">{t('Nothing logged yet.')}</div>}
  </>
}

/* ============================ shared schemes ============================ */

function PlanSheet({ plan, onChanged, close }) {
  const [full, setFull] = useState(null)
  const [err, setErr] = useState(null)
  const st = useStore(s => s.S)
  const toast = useUI(s => s.toast)
  useEffect(() => { T.getPlan(plan.id).then(r => setFull(r.plan)).catch(e => setErr(e.message)) }, [plan.id])

  // Taking a scheme goes through the same import the plan-file flow uses — same preview,
  // same "also set my week" choice, same merge that never overwrites your own routines.
  const take = () => {
    try {
      const parsed = parsePlan(full.bundle)
      close()
      planImportSheet(parsed)
    } catch (e) { toast(t('Import failed: {0}', e.message)) }
  }
  // Publishing over it keeps the scheme's identity, so the team has one plan that moved on
  // rather than two plans with the same name.
  const replace = () => {
    T.updatePlan({ id: plan.id, bundle: buildPlanBundle(st, plan.name) })
      .then(({ team }) => { close(); onChanged(team); toast(t('Shared plan updated')) })
      .catch(e => toast(e.message))
  }
  const remove = () => confirmSheet({
    title: t('Remove {0}?', plan.name),
    message: t('It disappears for everyone in the team. Routines anyone already took stay in their own plan.'),
    confirmText: t('Remove'), danger: true,
    onConfirm: () => T.removePlan(plan.id).then(({ team }) => { close(); onChanged(team); toast(t('Plan removed')) }).catch(e => toast(e.message))
  })

  if (err) return <div className="empty small">{err}</div>
  return <>
    <h3>{plan.name}</h3>
    <div className="muted small" style={{ marginTop: 4, marginBottom: 14 }}>
      {t('Shared by {0}', plan.byName)} · {t(plan.routines === 1 ? '{0} routine' : '{0} routines', plan.routines)}{plan.days ? ' · ' + t(plan.days === 1 ? '{0} training day' : '{0} training days', plan.days) : ''}
    </div>
    {plan.note && <div className="card small" style={{ lineHeight: 1.45 }}>{plan.note}</div>}
    {!full ? <div className="muted small">{t('Loading…')}</div> : <>
      <div className="list" style={{ gap: 0, marginBottom: 14 }}>
        {(full.bundle.routines || []).map(r => <div key={r.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
          <span className="small" style={{ fontWeight: 600 }}>{r.name}</span>
          <span className="dim small">{t((r.ex || []).length === 1 ? '{0} exercise' : '{0} exercises', (r.ex || []).length)}</span>
        </div>)}
      </div>
      <Button variant="primary" icon="download" onClick={take}>{t('Add to my plan')}</Button>
      <div className="dim small" style={{ margin: '7px 2px 14px', lineHeight: 1.4 }}>
        {t('Adds these routines alongside your own — nothing you have is replaced.')}
      </div>
      <Button variant="ghost" icon="upload" onClick={replace}>{t('Replace with my current plan')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="danger" icon="trash" onClick={remove}>{t('Remove from team')}</Button>
    </>}
  </>
}

function ShareSheet({ onChanged, close }) {
  const st = useStore(s => s.S)
  const user = useStore(s => s.user)
  const [name, setName] = useState(user?.name ? t('{0}’s plan', user.name) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useUI(s => s.toast)
  const routines = (st.routines || []).filter(r => r.ex && r.ex.length)

  const share = () => {
    setBusy(true)
    T.publishPlan({ name: name.trim(), note: note.trim(), bundle: buildPlanBundle(st, name.trim()) })
      .then(({ team }) => { close(); onChanged(team); toast(t('Shared with your team')) })
      .catch(e => toast(e.message))
      .finally(() => setBusy(false))
  }

  return <>
    <h3>{t('Share your plan')}</h3>
    <div className="muted small" style={{ margin: '4px 0 14px', lineHeight: 1.45 }}>
      {t('Your routines and week schedule go to the team. Your workouts and weigh-ins do not.')}
    </div>
    <TextField value={name} onChange={e => setName(e.target.value)} placeholder={t('Name this plan')} maxLength={40} />
    <div style={{ height: 10 }} />
    <TextField value={note} onChange={e => setNote(e.target.value)} placeholder={t('A note for the team (optional)')} maxLength={200} />
    <div style={{ height: 14 }} />
    <Button variant="primary" icon="upload" disabled={!routines.length || busy} onClick={share}>
      {t(routines.length === 1 ? 'Share {0} routine' : 'Share {0} routines', routines.length)}
    </Button>
    {!routines.length && <div className="dim small" style={{ margin: '10px 2px 0' }}>
      {t('Add an exercise to a routine first — an empty plan has nothing to share.')}
    </div>}
  </>
}

/* ============================ feed ============================ */

function Feed({ enabled }) {
  const [feed, setFeed] = useState(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    T.getFeed(40).then(r => { if (live) setFeed(r.feed) }).catch(() => { if (live) setFeed([]) })
    return () => { live = false }
  }, [enabled])
  if (!feed) return <div className="muted small">{t('Loading…')}</div>
  if (!feed.length) return <div className="empty small">{t('No sessions from the team yet.')}</div>
  return <div className="list" style={{ gap: 0 }}>
    {feed.map(f => <div key={f.uid + f.id} className="row between" style={{ padding: '10px 2px', borderBottom: '1px solid var(--sep)' }}>
      <div style={{ minWidth: 0 }}>
        <div className="small" style={{ fontWeight: 600 }}>
          <span className="capitalize">{f.who}</span>{f.name ? ' · ' + f.name : ''}
        </div>
        <div className="dim" style={{ fontSize: '.72rem', marginTop: 1 }}>
          {rel(f.d)} · {t(f.sets === 1 ? '{0} set' : '{0} sets', f.sets)}{f.min ? ' · ' + t('{0} min', f.min) : ''}
          {f.prs?.length ? ' · ' : ''}
          {f.prs?.length ? <span style={{ color: 'var(--yellow)' }}>{t(f.prs.length === 1 ? '{0} PR' : '{0} PRs', f.prs.length)}</span> : null}
        </div>
      </div>
      <span className="small muted">{f.vol ? fmtVol(f.vol, f.unit) : ''}</span>
    </div>)}
  </div>
}

/* ============================ screen ============================ */

export default function Team() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const setUser = useStore(s => s.setUser)
  const toast = useUI(s => s.toast)
  const enabled = T.teamsAvailable(user)
  const { team, loading, setTeam } = useTeam(enabled)
  const [tab, setTab] = useState('members')

  // The store's copy of `user` carries teamId (Home reads it to decide whether to show the
  // team card), so joining or leaving here has to update it too.
  const adopt = next => {
    setTeam(next)
    if (user && (user.teamId || null) !== (next?.id || null)) setUser({ ...user, teamId: next?.id || null })
  }

  if (!enabled) return <div className="narrow">
    <div className="hdr"><h1>{t('Team')}</h1></div>
    <div className="empty">{t('Teams need a server — sign in to your instance to train with other people.')}</div>
  </div>

  if (loading && !team) return <div className="narrow"><div className="hdr"><h1>{t('Team')}</h1></div><div className="muted small">{t('Loading…')}</div></div>

  if (!team) return <div className="narrow">
    <div className="hdr">
      <div><h1>{t('Team')}</h1><div className="sub">{t('Not in a team yet')}</div></div>
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="house" /></button>
    </div>
    <Start onTeam={adopt} />
  </div>

  const copyCode = () => {
    navigator.clipboard?.writeText(team.code).catch(() => {})
    toast(t('Code {0} copied', team.code))
  }
  const leave = () => confirmSheet({
    title: t('Leave {0}?', team.name),
    message: t('You stop seeing the team and it stops seeing you. Your own training and any routines you took are untouched.'),
    confirmText: t('Leave'), danger: true,
    onConfirm: () => T.leaveTeam().then(() => adopt(null)).catch(e => toast(e.message))
  })
  const openMember = m => ui().openSheet(close => <MemberSheet id={m.id} close={close} />)
  const openPlan = p => ui().openSheet(close => <PlanSheet plan={p} onChanged={adopt} close={close} />)
  const share = () => ui().openSheet(close => <ShareSheet onChanged={adopt} close={close} />)

  const members = [...team.members].sort((a, b) =>
    (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.vol7 - a.vol7 || a.name.localeCompare(b.name))
  const liveNow = members.filter(m => m.live && !m.you)

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{team.name}</h1><div className="sub">{t(team.members.length === 1 ? '{0} member' : '{0} members', team.members.length)}</div></div>
      <button className="iconbtn" onClick={leave} aria-label={t('Leave team')}><Icon name="signOut" /></button>
    </div>

    <button className="card tappable row between" style={{ width: '100%', cursor: 'pointer' }} onClick={copyCode}>
      <div style={{ textAlign: 'left' }}>
        <div className="lbl2">{t('Join code')}</div>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '.12em' }}>{team.code}</div>
      </div>
      <Icon name="link" className="chev" style={{ fontSize: 20 }} />
    </button>

    {liveNow.length > 0 && <div className="card" style={{ borderColor: 'var(--orange)' }}>
      <div className="row" style={{ gap: 9 }}>
        <span className="lrow-i" style={{ background: 'var(--orange)' }}><Icon name="timer" /></span>
        <div>
          <div className="lbl2">{t('Training right now')}</div>
          <div className="ttl capitalize">{liveNow.map(m => m.name).join(', ')}</div>
        </div>
      </div>
    </div>}

    <div style={{ margin: '4px 0 12px' }}>
      <Segmented value={tab} onChange={setTab} options={[
        { value: 'members', label: t('Members') },
        { value: 'plans', label: t('Plans') },
        { value: 'feed', label: t('Activity') }
      ]} />
    </div>

    {tab === 'members' && <div className="list">
      {members.map(m => <MemberRow key={m.id} m={m} onOpen={openMember} />)}
    </div>}

    {tab === 'plans' && <>
      <Button variant="primary" icon="upload" onClick={share}>{t('Share my plan')}</Button>
      <div style={{ height: 14 }} />
      {team.plans.length ? <div className="list">
        {team.plans.map(p => <button key={p.id} className="item" onClick={() => openPlan(p)}>
          <span className="lrow-i"><Icon name="clipboard" /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
            <div className="dim small" style={{ marginTop: 2 }}>
              {t('by {0}', p.byName)} · {t(p.routines === 1 ? '{0} routine' : '{0} routines', p.routines)}{p.days ? ' · ' + t(p.days === 1 ? '{0} training day' : '{0} training days', p.days) : ''}
            </div>
          </div>
          <Icon name="chevronRight" className="chev" />
        </button>)}
      </div> : <div className="empty small">{t('Nobody has shared a plan yet. Yours could be the first.')}</div>}
    </>}

    {tab === 'feed' && <Feed enabled />}

    <div style={{ height: 24 }} />
  </div>
}
