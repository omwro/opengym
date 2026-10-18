// Web Push subscribe/unsubscribe — requires a signed-in profile (subscriptions are stored
// server-side per user, same as everything else under /api).
import { api, IS_APPLE } from './api.js'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const pushPermission = () => (pushSupported() ? Notification.permission : 'unsupported')

/** Running as an installed app (home screen), not a browser tab. */
export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true

/**
 * Why push is not available here, in terms of what the person can do about it. On an iPhone
 * the answer is nearly always "open it from the home screen": Safari only exposes push to an
 * installed web app, so in a browser tab the feature simply does not exist.
 */
export function pushUnavailableReason() {
  if (pushSupported()) return null
  if (IS_APPLE && /iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandalone()) return 'ios-install'
  return 'unsupported'
}

const urlBase64ToUint8Array = b64 => {
  const padded = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}
const sameKey = (buf, b64) => {
  if (!buf) return false
  const a = new Uint8Array(buf), b = urlBase64ToUint8Array(b64)
  return a.length === b.length && a.every((v, i) => v === b[i])
}

async function subscribeFresh(reg, key) {
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) })
  return subscription
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Push notifications are not supported in this browser')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications permission was not granted')
  const reg = await navigator.serviceWorker.ready
  const { key } = await api('/api/push/public-key')
  const existing = await reg.pushManager.getSubscription()
  // A subscription made against a different server key cannot receive anything from this
  // server — the push service rejects every message. Replace it rather than reuse it.
  if (existing && !sameKey(existing.options?.applicationServerKey, key)) await existing.unsubscribe()
  await subscribeFresh(reg, key)
}

/**
 * Keep this device's subscription and the server's record of it in step, on every start.
 *
 * Subscriptions drift: the server drops one a push service reported as gone, a browser rotates
 * its endpoint, a phone subscribed while the server had different keys. Any of those leaves the
 * switch showing "on" while nothing is delivered. Re-registering is idempotent, so it is simply
 * done each time the app opens with permission already granted.
 */
export async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    const { key } = await api('/api/push/public-key')
    if (!sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); await subscribeFresh(reg, key); return }
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) })
  } catch { /* offline, or not signed in — try again next start */ }
}

export async function disablePush() {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await sub.unsubscribe()
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
}

export const sendTestPush = () => api('/api/push/test', { method: 'POST', body: '{}' })

/**
 * Take a notification back once it has done its job. "Rest over" is only useful while the app
 * is out of sight; once you are looking at the app again it is clutter in the notification
 * shade, so it is cleared when the app opens or comes back to the foreground.
 */
export async function clearNotifications(tag) {
  try {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg?.getNotifications) return
    for (const n of await reg.getNotifications({ tag })) n.close()
  } catch { /* not supported here — nothing to clear */ }
}
