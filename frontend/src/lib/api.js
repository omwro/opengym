// Backend helpers.
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)

export async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

/* ---------- sign-in ---------- */
// One password for the instance, and a profile picked from a list. No passkeys, no per-user
// credentials: everyone who trains here shares the password, and the profile only says whose
// log you are opening.

/** Names for the sign-in picker. Public — it has to work before anyone is signed in. */
export const listProfiles = () => api('/api/profiles')

export async function login(id, password) {
  const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify({ id, password }) })
  return user
}

/**
 * Add a profile. Signed in, the password is not needed and your own session is left alone —
 * you are setting someone else up. On an instance with no profiles at all the password stands
 * in for the session that cannot exist yet, and the new profile is signed straight in.
 */
export async function createProfile(name, password) {
  const { user } = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(password ? { name, password } : { name })
  })
  return user
}
