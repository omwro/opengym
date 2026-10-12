// Beeps + haptics.
//
// Two things the gym needs from a beep: it has to be heard over music, and it should make the
// music step aside for a moment rather than compete with it.
//
// Loudness: a soft-clipped tone near full scale, in the 1–3 kHz band where the ear is most
// sensitive and where music on earbuds leaves the most room. The old pure sine at 35% gain was
// the polite version of this and disappeared under a playlist.
//
// Ducking: a web page cannot hold audio focus directly, but the platforms will do it for short
// sounds played the right way:
//   · iOS / Safari — navigator.audioSession.type = 'transient' asks the system to duck other
//     audio while ours plays.
//   · Android / Chrome — a short clip played through an <audio> element requests transient,
//     may-duck audio focus, so Spotify and friends lower their volume for it. Web Audio does not
//     request focus at all, which is why the beep used to play underneath the music.
// So every beep pattern is rendered to one short WAV and played as an <audio> element, with Web
// Audio kept only as the fallback when that is refused (autoplay rules, an old browser).

const RATE = 22050

// Calls made in the same tick are one pattern ("beep, beep, BEEP") — rendered and played as a
// single clip, so it is one focus request and one dip in the music, not three.
let pending = []
let scheduled = false

export function beep(enabled, freq, dur, when) {
  if (!enabled) return
  pending.push({ freq: freq || 880, dur: dur || 0.18, when: when || 0 })
  if (!scheduled) { scheduled = true; queueMicrotask(flush) }
}

function flush() {
  const parts = pending; pending = []; scheduled = false
  if (!parts.length) return
  claimTransientAudio()
  const url = clipUrl(parts)
  try {
    const a = new Audio(url)
    a.volume = 1
    const p = a.play()
    if (p && p.catch) p.catch(() => webAudioFallback(parts))
  } catch { webAudioFallback(parts) }
}

/** iOS: ask for the session type that ducks other audio. Harmless where unsupported. */
function claimTransientAudio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'transient') navigator.audioSession.type = 'transient' } catch { /* */ }
}

/* ---------- rendering ---------- */
const cache = new Map()

/** One WAV holding every tone of a pattern at its offset. Cached: the same patterns repeat. */
function clipUrl(parts) {
  const key = parts.map(p => `${p.freq}:${p.dur}:${p.when}`).join('|')
  if (cache.has(key)) return cache.get(key)
  const url = URL.createObjectURL(new Blob([renderWav(parts)], { type: 'audio/wav' }))
  cache.set(key, url)
  return url
}

export function renderSamples(parts) {
  const end = Math.max(...parts.map(p => p.when + p.dur)) + 0.04
  const out = new Float32Array(Math.ceil(end * RATE))
  for (const { freq, dur, when } of parts) {
    const start = Math.floor(when * RATE)
    const n = Math.floor(dur * RATE)
    const attack = Math.floor(0.006 * RATE), release = Math.floor(0.03 * RATE)
    for (let i = 0; i < n && start + i < out.length; i++) {
      const env = i < attack ? i / attack : i > n - release ? Math.max(0, (n - i) / release) : 1
      const ph = 2 * Math.PI * freq * (i / RATE)
      // fundamental plus a touch of the octave, then soft-clipped: louder and brighter than a
      // pure sine at the same peak, without the harshness of a raw square wave
      const raw = Math.sin(ph) + 0.35 * Math.sin(2 * ph)
      out[start + i] += Math.tanh(2.2 * raw) * env
    }
  }
  // normalise to just under full scale
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const k = peak > 0 ? 0.95 / peak : 0
  for (let i = 0; i < out.length; i++) out[i] *= k
  return out
}

function renderWav(parts) {
  const s = renderSamples(parts)
  const buf = new ArrayBuffer(44 + s.length * 2)
  const v = new DataView(buf)
  const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + s.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, s.length * 2, true)
  for (let i = 0; i < s.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s[i])) * 0x7fff, true)
  return buf
}

/* ---------- fallback ---------- */
let audioCtx = null
function webAudioFallback(parts) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const comp = audioCtx.createDynamicsCompressor()
    comp.connect(audioCtx.destination)
    for (const { freq, dur, when } of parts) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain()
      o.connect(g); g.connect(comp)
      o.frequency.value = freq; o.type = 'triangle'
      const t0 = audioCtx.currentTime + when
      g.gain.setValueAtTime(0.001, t0)
      g.gain.exponentialRampToValueAtTime(1, t0 + 0.01)
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
      o.start(t0); o.stop(t0 + dur + 0.05)
    }
  } catch { /* */ }
}

export function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p) } catch (e) { /* */ } }
