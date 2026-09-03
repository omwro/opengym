// Team backend calls + the polling hook the Team screen and the Home card share.
//
// A team is a thin server-side thing: membership, published schemes, and a summary of every
// member's training derived from their own state. Nothing here is cached into the local
// state blob — the team is other people's data, and stale copies of it in localStorage would
// outlive membership.
import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'

/** Teams need a server. The demo and the standalone mobile build have none. */
export const teamsAvailable = user => !!user && !DEMO && !MOBILE

export const getTeam = () => api('/api/team')
export const createTeam = name => api('/api/team/create', { method: 'POST', body: JSON.stringify({ name }) })
export const joinTeam = code => api('/api/team/join', { method: 'POST', body: JSON.stringify({ code }) })
export const leaveTeam = () => api('/api/team/leave', { method: 'POST', body: '{}' })
export const renameTeam = name => api('/api/team/rename', { method: 'POST', body: JSON.stringify({ name }) })
export const getFeed = (limit = 60) => api('/api/team/feed?limit=' + limit)
export const getMember = id => api('/api/team/member?id=' + encodeURIComponent(id))
export const getPlan = id => api('/api/team/plan?id=' + encodeURIComponent(id))
export const publishPlan = body => api('/api/team/plans', { method: 'POST', body: JSON.stringify(body) })
export const updatePlan = body => api('/api/team/plans/update', { method: 'POST', body: JSON.stringify(body) })
export const removePlan = id => api('/api/team/plans/remove', { method: 'POST', body: JSON.stringify({ id }) })

/**
 * Poll the team while the screen that wants it is on. Two reasons it polls rather than
 * fetching once: a teammate's session appears as `live` only while they are mid-workout,
 * and their totals move as they log sets. It stops entirely while the tab is hidden, so a
 * phone in a pocket during a workout is not sending a request every 20 seconds.
 */
export function useTeam(enabled, everyMs = 20000) {
  const [team, setTeam] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(!!enabled)
  const timer = useRef(null)

  const load = useRef(async () => {})
  load.current = async () => {
    try { setTeam((await getTeam()).team); setError(null) }
    // A failed refresh keeps whatever is already on screen: offline mid-workout should not
    // blank out the team you were looking at a second ago.
    catch (e) { setError(e) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    if (!enabled) { setTeam(null); setLoading(false); return }
    let stopped = false
    const tick = () => { if (!stopped && document.visibilityState === 'visible') load.current() }
    tick()
    timer.current = setInterval(tick, everyMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(timer.current)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, everyMs])

  return { team, error, loading, reload: () => load.current(), setTeam }
}
