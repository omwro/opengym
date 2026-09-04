import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutine, effectiveRoutineId, streakWeeks, setsDoneActive } from '../lib/history.js'
import { fmtNum, fmtDate, todayISO, isoOf, weekKey, DAYS } from '../lib/format.js'
import { t, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, dayOverrideSheet, calendarSheet, startFlow, loadStarterPlan } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf } from '../lib/glyphs.js'
import { coachAvailable, hasConsent } from '../lib/coach.js'
import { teamsAvailable, useTeam } from '../lib/team-api.js'
import { WEIGHT, metric, metricIds, changeColor } from '../lib/measures.js'
import { measureSheet, measureGoalSheet } from './Measures.jsx'
import { useCoachStatus } from '../lib/coach-api.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'

// A job in flight or a proposal waiting is the only reason the Coach interrupts Home. When it
// has nothing to say it renders nothing at all — and it only polls while Home is on screen.
function CoachCard({ nav }) {
  const S = useStore(s => s.S)
  const { job, pending } = useCoachStatus(hasConsent(S))
  if (!hasConsent(S) || (!job && !pending)) return null
  const ready = !!pending
  return <div className="card" style={ready ? { borderColor: 'var(--acc)' } : null}>
    <div className="today-row" onClick={() => nav(ready ? '/coach/proposal' : '/coach')}>
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <span className="lrow-i" style={{ background: ready ? 'var(--acc)' : 'var(--orange)' }}><Icon name="sparkles" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{t('Coach')}</div>
          <div className="ttl">{ready
            ? (pending.kind === 'create'
              ? t('Your plan is ready')
              : t(pending.changes?.length === 1 ? '{0} suggestion for you' : '{0} suggestions for you', pending.changes?.length || 0))
            : t('Reading your training…')}</div>
        </div>
      </div>
      {ready ? <span className="tag acc">{t('Review')}</span> : <Icon name="chevronRight" className="chev" />}
    </div>
  </div>
}

// Who else is training, at a glance. Silent when there is no server or no team — the app
// looks exactly as it did before teams existed until you are actually in one.
function TeamCard({ nav }) {
  const user = useStore(s => s.user)
  const { team } = useTeam(teamsAvailable(user))
  if (!team) return null
  const live = team.members.filter(m => m.live && !m.you)
  const thisWeek = team.members.reduce((n, m) => n + m.week, 0)
  return <div className="card" style={live.length ? { borderColor: 'var(--orange)' } : null}>
    <div className="today-row" onClick={() => nav('/team')}>
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <span className="lrow-i" style={{ background: live.length ? 'var(--orange)' : 'var(--surface-3)' }}>
          <Icon name={live.length ? 'timer' : 'personCircle'} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{team.name}</div>
          {/* no `capitalize` here: the line is a sentence, and the class title-cases it */}
          <div className="ttl">{live.length
            ? t(live.length === 1 ? '{0} is training now' : '{0} are training now', live.map(m => m.name).join(', '))
            : t(thisWeek === 1 ? '{0} session from the team this week' : '{0} sessions from the team this week', thisWeek)}</div>
        </div>
      </div>
      <Icon name="chevronRight" className="chev" />
    </div>
  </div>
}

// One card for the whole body, not two nearly identical ones stacked. Weight and a tape
// measurement answer the same question — how is this body changing — and only differ in where
// they are stored, which lib/measures.js already flattens away. So: one chart, one Goal
// button, one Log button, and a row of chips to choose what you are looking at.
//
// Weight leads because it is the one thing every profile has: it is asked for before every
// workout, so the card is never empty for someone who only trains.
function BodyCard({ nav }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const ids = metricIds(S)
  // Fall back rather than blank out: the remembered metric may be one this profile does not
  // log (or stopped logging), and an empty card would look broken.
  const id = ids.includes(S.measureFocus) ? S.measureFocus : ids[0]
  const m = id ? metric(S, id) : null

  // The two actions dispatch on the metric — the only place the difference still shows.
  const log = () => (id === WEIGHT ? bwSheet() : measureSheet())
  const setGoal = () => (id === WEIGHT ? goalSheet() : measureGoalSheet(id))

  if (!m || m.current == null) return <div className="card">
    <div className="row between" style={{ marginBottom: 6 }}>
      <h2 style={{ margin: 0 }}>{t('Body')}</h2>
      <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
    </div>
    <div className="muted small">
      {t('Weight, chest, arms, waist — logged here, and the weigh-in is asked before every workout.')}
    </div>
  </div>

  return <div className="card">
    <div className="row between" style={{ marginBottom: 6 }}>
      <h2 style={{ margin: 0 }}>{m.label}</h2>
      <div className="row" style={{ gap: 8 }}>
        <Button size="sm" icon="target" style={m.goal ? { color: 'var(--yellow)' } : undefined}
          onClick={setGoal}>{m.goal ? fmtNum(m.goal.goal) : t('Goal')}</Button>
        <Button size="sm" icon="plus" onClick={log}>{t('Log')}</Button>
      </div>
    </div>

    <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
      <div className="big">{fmtNum(m.current)} <span className="muted" style={{ fontSize: '1rem' }}>{m.unit}</span></div>
      {/* only when it actually moved — an unchanged value used to read as "- 0" */}
      {!!m.change && <span className="small row" style={{ gap: 2, fontWeight: 500, color: changeColor(m) }}>
        <Icon name={m.change > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 12 }} />
        {fmtNum(Math.abs(m.change))}
      </span>}
      <span className="dim small" style={{ marginLeft: 'auto' }}>{fmtDate(m.date, true)}</span>
    </div>

    {m.goal && <div className="small row" style={{ color: 'var(--yellow)', marginTop: 4, gap: 5 }}>
      <Icon name="target" style={{ fontSize: 13 }} />
      <span>{t('Goal')} {fmtNum(m.goal.goal)} {m.unit} · {m.goal.reached
        ? t('reached!')
        : t(m.goal.up ? '{0} to gain' : '{0} to lose', fmtNum(m.goal.remaining) + ' ' + m.unit)}</span>
    </div>}

    {m.points.length > 1 && <div className="chart" style={{ marginTop: 8 }}>
      <LineChart points={m.points} h={130} unit={m.unit} goal={m.goal?.goal ?? null} />
    </div>}

    {ids.length > 1 && <div className="chips" style={{ marginTop: 10 }}>
      {ids.map(x => <button key={x} className={'chip' + (x === id ? ' on' : '')}
        onClick={() => update(s => { s.measureFocus = x })}>{metric(S, x).label}</button>)}
    </div>}

    <div className="dim small tappable" style={{ marginTop: 10, cursor: 'pointer' }} onClick={() => nav('/measures')}>
      {t('All measurements')} →
    </div>
  </div>
}

// Home = what to do now + a quick glance. Deep charts & history live in Stats.
export default function Home() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const [weekOffset, setWeekOffset] = useState(0)
  const coachOn = coachAvailable(config, user, { demo: DEMO, mobile: MOBILE })
  const teamOn = teamsAvailable(user)

  const today = new Date()
  const routine = effectiveRoutine(S, todayISO())
  const todayOvr = S.dayPlan[todayISO()] !== undefined

  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7)
  const doneDays = new Set(S.workouts.map(w => w.d))
  const strip = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i)
    const iso = isoOf(d)
    const eff = effectiveRoutineId(S, iso), ovr = S.dayPlan[iso] !== undefined, done = doneDays.has(iso)
    const dot = done ? ' done' : ovr && eff ? ' ovr' : eff ? ' plan' : ''
    strip.push(<div key={i} className={'wday' + (iso === todayISO() ? ' today' : '')} onClick={() => dayOverrideSheet(iso)}>
      <div className="lbl">{t(DAYS[d.getDay()])}</div><div className="num">{d.getDate()}</div><div className={'dot' + dot} /></div>)
  }
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  const wkLabel = weekOffset === 0 ? t('This week') : `${monday.getDate()} ${monday.toLocaleDateString(dateLocale(), { month: 'short' })} – ${sunday.getDate()} ${sunday.toLocaleDateString(dateLocale(), { month: 'short' })}`

  const wThisWeek = S.workouts.filter(w => weekKey(w.d) === weekKey(todayISO())).length
  const plannedPerWeek = Object.keys(S.week).filter(k => S.week[k]).length

  // today's session shown right under the week strip
  const onToday = () => { if (S.active) nav('/workout'); else if (routine) startFlow(routine.id); else dayOverrideSheet(todayISO()) }

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{user ? t('Hi {0}', user.name) : 'openGym'}</h1><div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <div className="row" style={{ gap: 8 }}>
        {teamOn && <button className="iconbtn" onClick={() => nav('/team')} aria-label={t('Team')}><Icon name="personCircle" /></button>}
        <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="gear" /></button>
      </div>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week"><Icon name="chevronLeft" /></button>
        <div className="small muted" style={{ fontWeight: 500 }}>{wkLabel}</div>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week"><Icon name="chevronRight" /></button>
      </div>
      <div className="week">{strip}</div>
      <div className="today-row" onClick={onToday}>
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="lrow-i" style={{ background: S.active ? 'var(--orange)' : routine ? 'var(--acc)' : 'var(--surface-3)' }}>
            <Icon name={S.active ? 'timer' : routine ? glyphOf(routine.emoji) : 'moon'} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{t('Today')}</div>
            <div className="ttl">{S.active ? t('{0} — in progress', S.active.name) : routine ? routine.name : t('Rest day')}{todayOvr && routine ? ' · ' + t('rescheduled') : ''}</div>
          </div>
        </div>
        {S.active ? <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 16%,transparent)' }}>{t('Resume')}</span>
          : routine ? <span className="tag acc">{t('Start')}</span>
          : <Icon name="plus" className="chev" />}
      </div>
    </div>

    {coachOn && <CoachCard nav={nav} />}
    {teamOn && <TeamCard nav={nav} />}

    {!S.routines.length && !S.active && (
      <div className="card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="lrow-i"><Icon name="sparkles" /></span>
          <div className="big" style={{ fontSize: 22 }}>{t('Welcome!')}</div>
        </div>
        <div className="muted small" style={{ marginBottom: 12 }}>{t('Set up your weekly routine to get going — or load a ready-made Push / Pull / Legs plan.')}</div>
        {coachOn && <>
          <Button variant="primary" icon="sparkles" onClick={() => nav(hasConsent(S) ? '/coach/intake' : '/coach')}>{t('Let the Coach build it')}</Button>
          <div style={{ height: 8 }} />
        </>}
        <Button variant={coachOn ? 'plain' : 'primary'} icon="sparkles" onClick={loadStarterPlan}>{t('Load starter plan (PPL)')}</Button>
        <div style={{ height: 8 }} /><Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
      </div>
    )}

    <BodyCard nav={nav} />

    <div className="card tappable" style={{ cursor: 'pointer' }} onClick={() => calendarSheet()}>
      <div className="row between">
        <div>
          <div className="row" style={{ gap: 7, fontSize: 22, fontWeight: 600, letterSpacing: '-.021em' }}>
            <Icon name="flame" style={{ color: 'var(--orange)' }} />
            {t('{0} week streak', streakWeeks(S))}
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>{wThisWeek}{plannedPerWeek ? ' / ' + plannedPerWeek : ''} {t('this week')} · {t(S.workouts.length === 1 ? '{0} workout total' : '{0} workouts total', S.workouts.length)}</div>
        </div>
        <Icon name="calendar" className="chev" style={{ fontSize: 20 }} />
      </div>
    </div>
  </div>
}
