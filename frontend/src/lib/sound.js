// Beeps + haptics.
//
// Two things the gym needs from a beep: it has to be heard over music, and it should make the
// music step aside for a moment rather than compete with it.
//
// Character: a chime, not an alarm. A flat tone that stops dead, heavily clipped, repeated on
// one pitch is what makes a beep sound like a warning. Here each note strikes and then decays
// like a small bell, the timbre is a clean fundamental with soft overtones, and the final cue
// is a rising major chord — "done", not "danger". It still sits in the 0.8–1.6 kHz range where
// the ear is most sensitive and music leaves room, and is normalised to near full scale.
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
  play(parts)
}

function play(parts) {
  claimTransientAudio()
  const url = clipUrl(parts)
  try {
    const a = new Audio(url)
    a.volume = 1
    const p = a.play()
    if (p && p.catch) p.catch(() => webAudioFallback(parts))
    return a
  } catch { webAudioFallback(parts); return null }
}

/* ---------- the end-of-rest countdown, as one clip ----------
   Ducking lasts exactly as long as our audio is playing. Played as separate clips, the 3-2-1
   beeps let the music come back up to full volume in every gap between them — exactly the
   moment you are listening for the next beep. So the whole countdown, gaps included, is one
   clip: the music stays down from the first beep until the last one has rung out.

   Kept under five seconds on purpose — Android treats longer media as something to pause the
   music for rather than to duck under. */
// C6 – E6 – G6: a rising major chord reads as "done". Each note rings longer than the gap to
// the next, so they blend into one chime instead of three separate beeps.
export const FINAL = [{ freq: 1047, dur: 0.45, at: 0 }, { freq: 1319, dur: 0.45, at: 0.14 }, { freq: 1568, dur: 0.7, at: 0.28 }]
// A short, soft G5 for 3-2-1: noticeable, not insistent.
export const TICK = { freq: 784, dur: 0.22 }

/** The finishing chime on its own, for when no countdown clip carried it. */
export function chime(enabled) { for (const f of FINAL) beep(enabled, f.freq, f.dur, f.at) }

/** The parts of a countdown clip that ends `endsIn` seconds from now. */
export function countdownParts(endsIn) {
  const parts = []
  for (const k of [3, 2, 1]) {
    const when = endsIn - k
    if (when >= -0.05) parts.push({ freq: TICK.freq, dur: TICK.dur, when: Math.max(0, when) })
  }
  for (const f of FINAL) parts.push({ freq: f.freq, dur: f.dur, when: Math.max(0, endsIn) + f.at })
  return parts
}

/** Play the countdown for a timer ending `endsIn` seconds from now; returns a stop handle. */
export function countdown(enabled, endsIn) {
  if (!enabled) return { stop() {} }
  const a = play(countdownParts(endsIn))
  return { stop() { try { if (a) { a.pause(); a.currentTime = 0 } } catch { /* */ } } }
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
  const end = Math.max(...parts.map(p => p.when + p.dur)) + 0.05
  const out = new Float32Array(Math.ceil(end * RATE))
  for (const { freq, dur, when } of parts) {
    const start = Math.floor(when * RATE)
    const n = Math.floor(dur * RATE)
    const attack = Math.floor(0.008 * RATE)        // soft strike, no click
    const tau = dur * 0.38                          // bell-like decay over the note
    const tail = Math.floor(0.012 * RATE)           // fade the last few ms so it never clips off
    for (let i = 0; i < n && start + i < out.length; i++) {
      const sec = i / RATE
      let env = Math.exp(-sec / tau)
      if (i < attack) env *= i / attack
      if (i > n - tail) env *= Math.max(0, (n - i) / tail)
      const ph = 2 * Math.PI * freq * sec
      // clean fundamental, a soft octave and a faint twelfth: warm, chime-like, not buzzy
      const raw = Math.sin(ph) + 0.28 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph)
      out[start + i] += Math.tanh(1.3 * raw) * env
    }
  }
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
