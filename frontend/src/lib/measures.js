// Body measurements — circumferences over time, and what can be derived from them.
//
// Weight deliberately is NOT one of these. openGym already owns body weight: it has its own
// log, its own goal line, and it is asked for before every workout. A second weight field here
// would be a second source of truth that quietly disagrees with the first. Where a calculation
// needs weight (lean mass, FFMI) it is taken from the weigh-in nearest the measurement date.
//
// Left and right are kept apart on purpose. A 2 cm difference between arms is real information
// about how you train; averaged into one number it disappears.
import { t } from './i18n.js'

export const FIELDS = [
  { id: 'neck', label: 'Neck' },
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'chest', label: 'Chest' },
  { id: 'waist', label: 'Waist' },
  { id: 'hips', label: 'Hips' },
  { id: 'bicepsL', label: 'Left biceps', group: 'Biceps', side: 'L' },
  { id: 'bicepsR', label: 'Right biceps', group: 'Biceps', side: 'R' },
  { id: 'forearmL', label: 'Left forearm', group: 'Forearm', side: 'L' },
  { id: 'forearmR', label: 'Right forearm', group: 'Forearm', side: 'R' },
  { id: 'thighL', label: 'Left thigh', group: 'Thigh', side: 'L' },
  { id: 'thighR', label: 'Right thigh', group: 'Thigh', side: 'R' },
  { id: 'calfL', label: 'Left calf', group: 'Calf', side: 'L' },
  { id: 'calfR', label: 'Right calf', group: 'Calf', side: 'R' }
]

export const SINGLES = FIELDS.filter(f => !f.group)
export const PAIRS = [...new Set(FIELDS.filter(f => f.group).map(f => f.group))].map(group => ({
  group,
  left: FIELDS.find(f => f.group === group && f.side === 'L'),
  right: FIELDS.find(f => f.group === group && f.side === 'R')
}))
export const FIELD = Object.fromEntries(FIELDS.map(f => [f.id, f]))
export const labelOf = id => t(FIELD[id]?.label || id)

// Lengths follow the profile's unit system rather than adding a setting of their own: someone
// logging kilos thinks in centimetres, someone logging pounds thinks in inches.
export const lengthUnit = S => (S?.unit === 'lb' ? 'in' : 'cm')
const CM_PER_IN = 2.54
export const toCm = (v, unit) => (unit === 'in' ? v * CM_PER_IN : v)

/** Measurements newest-first. Stored order is never assumed. */
export const sorted = S => [...(S?.measures || [])].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))

/** Which fields this entry actually carries, in display order. */
export const filled = m => FIELDS.filter(f => Number.isFinite(m?.[f.id]));

/** The weigh-in closest in time to a measurement — for the calculations that need weight. */
export function weightAt(S, iso) {
  const bw = S?.bodyweight || [];
  if (!bw.length || !iso) return null;
  const target = new Date(iso).getTime();
  let best = null, bestGap = Infinity;
  for (const b of bw) {
    const gap = Math.abs(new Date(b.d).getTime() - target);
    if (gap < bestGap) { bestGap = gap; best = b; }
  }
  // A weigh-in from three months either side says nothing about the body being measured.
  return best && bestGap <= 30 * 86400000 ? best.w : null;
}

/**
 * Body fat by the US Navy method. Needs height, neck and waist — and the hip measurement too
 * for a female figure, which is what the formula was fitted on.
 *
 * Returns null rather than a guess whenever an input is missing: a number here that silently
 * meant "we assumed something" would be tracked over time as if it were measured.
 */
export function bodyFat(S, m) {
  const unit = lengthUnit(S);
  const h = toCm(Number(S?.height) || 0, unit);
  const neck = toCm(Number(m?.neck) || 0, unit);
  const waist = toCm(Number(m?.waist) || 0, unit);
  const hips = toCm(Number(m?.hips) || 0, unit);
  if (!h || !neck || !waist) return null;
  const female = S?.body === 'female';
  let bf;
  if (female) {
    if (!hips) return null;
    const d = waist + hips - neck;
    if (d <= 0) return null;
    bf = 495 / (1.29579 - 0.35004 * Math.log10(d) + 0.221 * Math.log10(h)) - 450;
  } else {
    const d = waist - neck;
    if (d <= 0) return null;   // a waist no bigger than the neck breaks the log
    bf = 495 / (1.0324 - 0.19077 * Math.log10(d) + 0.15456 * Math.log10(h)) - 450;
  }
  return bf > 0 && bf < 70 ? Math.round(bf * 10) / 10 : null;
}

const round1 = v => Math.round(v * 10) / 10;

/** Everything derived from one measurement: body fat, lean mass, FFMI, waist-to-height. */
export function stats(S, m) {
  const bf = bodyFat(S, m);
  const w = weightAt(S, m?.d);
  const unit = lengthUnit(S);
  const hCm = toCm(Number(S?.height) || 0, unit);
  // Lean mass and FFMI are mass figures, so they stay in the profile's weight unit.
  const lean = w != null && bf != null ? round1(w * (1 - bf / 100)) : null;
  let ffmi = null;
  if (lean != null && hCm) {
    const kg = S?.unit === 'lb' ? lean * 0.45359237 : lean;
    ffmi = round1(kg / ((hCm / 100) ** 2));
  }
  const waist = Number(m?.waist);
  const whtr = hCm && Number.isFinite(waist) && waist > 0 ? Math.round((toCm(waist, unit) / hCm) * 100) / 100 : null;
  return { bodyFat: bf, weight: w, lean, ffmi, whtr };
}

/** What is still missing before a body-fat figure can be produced. */
export function missingForBodyFat(S, m) {
  const need = [];
  if (!Number(S?.height)) need.push(t('height'));
  if (!Number(m?.neck)) need.push(t('neck'));
  if (!Number(m?.waist)) need.push(t('waist'));
  if (S?.body === 'female' && !Number(m?.hips)) need.push(t('hips'));
  return need;
}

/* ---------- goals ---------- */
// Which direction counts as progress is never assumed. A waist is not always meant to shrink
// and a thigh is not always meant to grow — it depends on whether someone is cutting, bulking
// or rehabbing an imbalance. The goal itself settles it: it sits above or below where you are
// now, and that is the direction. Same rule body weight already uses.

export const goalOf = (S, id) => {
  const g = S?.measureGoals?.[id];
  return Number.isFinite(g) && g > 0 ? g : null;
};

/** The latest value recorded for a field, or null. */
export function currentOf(S, id) {
  const hit = sorted(S).find(m => Number.isFinite(m[id]));
  return hit ? hit[id] : null;
}

/**
 * How a field stands against its goal. `up` is whether the goal is above today's value, so a
 * gain counts as progress; `remaining` is what is left either way.
 */
export function goalProgress(S, id) {
  const goal = goalOf(S, id);
  const current = currentOf(S, id);
  if (goal == null || current == null) return null;
  const diff = Math.round((goal - current) * 10) / 10;
  return { goal, current, remaining: Math.abs(diff), up: diff > 0, reached: Math.abs(diff) < 0.05 };
}

/** Colour for a change: toward the goal or away from it. Neutral when there is no goal. */
export function deltaColor(S, id, change) {
  if (!change) return 'var(--label-2)';
  const p = goalProgress(S, id);
  if (!p) return 'var(--label)';
  return (change > 0) === p.up ? 'var(--acc)' : 'var(--red)';
}

/** Points for one field's chart, oldest-first. */
export const series = (S, id) => sorted(S).slice().reverse()
  .filter(m => Number.isFinite(m[id]))
  .map(m => ({ t: new Date(m.d).getTime(), y: m[id], d: m.d }));

/** Change in a field between the two most recent entries that both have it. */
export function delta(S, id) {
  const withField = sorted(S).filter(m => Number.isFinite(m[id]));
  if (withField.length < 2) return null;
  return round1(withField[0][id] - withField[1][id]);
}

/** The left/right gap for a paired field, if both sides were measured. */
export function sideGap(m, group) {
  const pair = PAIRS.find(p => p.group === group);
  if (!pair) return null;
  const l = m?.[pair.left.id], r = m?.[pair.right.id];
  if (!Number.isFinite(l) || !Number.isFinite(r)) return null;
  return round1(r - l);
}

/* ---------- one shape for every body metric ---------- */
// Body weight and a tape measurement answer the same question and deserve one card, not two
// near-identical ones stacked. They are stored differently though — weight has its own log,
// its own goal field and is asked for before every workout — so this is where the difference
// is absorbed: everything below returns the same descriptor, and the UI has a single path.

export const WEIGHT = 'weight';

/** Every metric this profile has data for, weight first. */
export function metricIds(S) {
  const ids = [];
  if ((S?.bodyweight || []).length) ids.push(WEIGHT);
  for (const f of FIELDS) if (series(S, f.id).length) ids.push(f.id);
  return ids;
}

/**
 * One metric, uniform: label, unit, chart points, latest value, change since the previous
 * entry, and the goal expressed the same way for both kinds.
 */
export function metric(S, id) {
  if (id === WEIGHT) {
    const log = S?.bodyweight || [];
    const last = log.length ? log[log.length - 1] : null;
    const prev = log.length > 1 ? log[log.length - 2] : null;
    const goal = Number.isFinite(S?.targetW) && S.targetW > 0 ? S.targetW : null;
    const current = last ? last.w : null;
    return {
      id: WEIGHT, label: t('Body weight'), unit: S?.unit || 'kg',
      current, date: last ? last.d : null,
      change: last && prev ? Math.round((last.w - prev.w) * 10) / 10 : null,
      points: log.map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d })),
      goal: goal == null || current == null ? null : {
        goal, current, remaining: Math.abs(Math.round((goal - current) * 10) / 10),
        up: goal > current, reached: Math.abs(goal - current) < 0.05
      }
    };
  }
  const entry = sorted(S).find(m => Number.isFinite(m[id]));
  return {
    id, label: labelOf(id), unit: lengthUnit(S),
    current: currentOf(S, id), date: entry ? entry.d : null,
    change: delta(S, id), points: series(S, id), goal: goalProgress(S, id)
  };
}

/** Colour for a metric's change: toward its goal, away from it, or neutral without one. */
export function changeColor(m) {
  if (!m?.change) return 'var(--label-2)';
  if (!m.goal) return 'var(--label)';
  return (m.change > 0) === m.goal.up ? 'var(--acc)' : 'var(--red)';
}

/** Keep only real numbers, so a half-filled form never stores empty strings or NaN. */
export function clean(values, iso) {
  const out = { d: iso };
  for (const f of FIELDS) {
    const v = values[f.id];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[f.id] = Math.round(n * 10) / 10;
  }
  return out;
}
export const isEmpty = entry => filled(entry).length === 0;
