import { describe, it, expect, vi } from 'vitest'
// api.js reads navigator.userAgent at import, so a navigator has to exist first.
globalThis.navigator = { userAgent: '' }
const { clearNotifications } = await import('./push.js')

function fakeRegistration(list) {
  return {
    getNotifications: vi.fn(async ({ tag } = {}) => list.filter(n => !tag || n.tag === tag))
  }
}
const note = tag => ({ tag, closed: false, close() { this.closed = true } })

describe('clearing the rest notification on return to the app', () => {
  it('closes only the rest-timer notifications, nothing else', async () => {
    const rest = note('rest-timer'), other = note('day-reminder')
    const reg = fakeRegistration([rest, other])
    globalThis.navigator = { userAgent: '', serviceWorker: { getRegistration: async () => reg } }
    await clearNotifications('rest-timer')
    expect(rest.closed).toBe(true)
    expect(other.closed).toBe(false)
  })
  it('does nothing — and does not throw — where notifications cannot be listed', async () => {
    globalThis.navigator = { userAgent: '', serviceWorker: { getRegistration: async () => ({}) } }
    await expect(clearNotifications('rest-timer')).resolves.toBeUndefined()
    globalThis.navigator = { userAgent: '' }
    await expect(clearNotifications('rest-timer')).resolves.toBeUndefined()
  })
})
