// The director-intent design space (Director Intent v3): FIXED, not editable here.
// A shot lists the sub-dimensions it serves; those expressible as a bipolar control get a slider
// that drives camera params, the rest are listed read-only. (intent ↔ params is many-to-many.)
import type { SevenDims } from '../api/types'
import { zoneOf, DIST_MIN, DIST_MAX } from './dims'

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// full v3 codebook (code → L1 / L2) — read-only reference
export const CODEBOOK: Record<string, { l1: string; l2: string }> = {
  '1.1': { l1: 'Emotion Evocation', l2: 'Fear/Terror' }, '1.2': { l1: 'Emotion Evocation', l2: 'Tension/Anxiety' }, '1.3': { l1: 'Emotion Evocation', l2: 'Disgust/Aversion' }, '1.4': { l1: 'Emotion Evocation', l2: 'Sadness/Melancholy' }, '1.5': { l1: 'Emotion Evocation', l2: 'Joy/Delight' }, '1.6': { l1: 'Emotion Evocation', l2: 'Anger/Indignation' }, '1.7': { l1: 'Emotion Evocation', l2: 'Awe/Sublime' },
  '2.1': { l1: 'Attention Guidance', l2: 'Emphasize subject/detail' }, '2.2': { l1: 'Attention Guidance', l2: 'Guide gaze path' }, '2.3': { l1: 'Attention Guidance', l2: 'De-emphasize/Hide' }, '2.4': { l1: 'Attention Guidance', l2: 'Attention redirect' },
  '3.1': { l1: 'Atmosphere', l2: 'Tense/Oppressive/Ominous' }, '3.2': { l1: 'Atmosphere', l2: 'Unease/Instability/Vertigo' }, '3.3': { l1: 'Atmosphere', l2: 'Gloomy/Sorrowful' }, '3.4': { l1: 'Atmosphere', l2: 'Mysterious/Solitary/Detached' }, '3.5': { l1: 'Atmosphere', l2: 'Warm/Cozy' }, '3.6': { l1: 'Atmosphere', l2: 'Romantic/Lyrical' }, '3.7': { l1: 'Atmosphere', l2: 'Cheerful/Light' }, '3.8': { l1: 'Atmosphere', l2: 'Serene/Peaceful' }, '3.9': { l1: 'Atmosphere', l2: 'Dreamlike/Surreal' }, '3.10': { l1: 'Atmosphere', l2: 'Immersive/Absorbing' }, '3.11': { l1: 'Atmosphere', l2: 'Authentic/Documentary' },
  '4.1': { l1: 'Viewpoint/Alignment', l2: 'Subjective/POV' }, '4.2': { l1: 'Viewpoint/Alignment', l2: 'Objective/Neutral observer' }, '4.3': { l1: 'Viewpoint/Alignment', l2: "Omniscient/God's-eye" }, '4.4': { l1: 'Viewpoint/Alignment', l2: 'Alignment modulation' },
  '5.1': { l1: 'Characterization', l2: 'Power/Status' }, '5.2': { l1: 'Characterization', l2: 'Inner/Emotion/Motivation' }, '5.3': { l1: 'Characterization', l2: 'Character relations' }, '5.4': { l1: 'Characterization', l2: 'Personality/Identity' },
  '6.1': { l1: 'Pacing', l2: 'Accelerate/Urgent' }, '6.2': { l1: 'Pacing', l2: 'Slow/Stagnant' }, '6.3': { l1: 'Pacing', l2: 'Show passage of time' }, '6.4': { l1: 'Pacing', l2: 'Rhythm sync/Emotion curve' },
  '7.1': { l1: 'Empathy', l2: 'Intimacy/Closeness' }, '7.2': { l1: 'Empathy', l2: 'Emotional involvement/Resonance' }, '7.3': { l1: 'Empathy', l2: 'Mentalizing/Understanding character' }, '7.4': { l1: 'Empathy', l2: 'Sympathy/Moral alliance' },
  '8.1': { l1: 'Information Management', l2: 'Reveal/Clarify' }, '8.2': { l1: 'Information Management', l2: 'Curiosity' }, '8.3': { l1: 'Information Management', l2: 'Suspense' }, '8.4': { l1: 'Information Management', l2: 'Surprise' },
  '9.1': { l1: 'Exposition', l2: 'Establish place/time' }, '9.2': { l1: 'Exposition', l2: 'Establish scene geography' }, '9.3': { l1: 'Exposition', l2: 'Convey background/context' },
  '10.1': { l1: 'Spatial Representation', l2: 'Subject–environment relation' }, '10.2': { l1: 'Spatial Representation', l2: 'Tiny/Engulfed' }, '10.3': { l1: 'Spatial Representation', l2: 'Scale/Magnitude' }, '10.4': { l1: 'Spatial Representation', l2: 'Inter-character spatial relation' },
  '11.1': { l1: 'Compositional Aesthetics', l2: 'Balance/Stability' }, '11.2': { l1: 'Compositional Aesthetics', l2: 'Imbalance/Visual tension' }, '11.3': { l1: 'Compositional Aesthetics', l2: 'Formal beauty/Interest' }, '11.4': { l1: 'Compositional Aesthetics', l2: 'Authorial style/Unity' },
  '12.1': { l1: 'Thematic Meaning', l2: 'Visual metaphor/Symbol' }, '12.2': { l1: 'Thematic Meaning', l2: 'Motif/Recurring imagery' }, '12.3': { l1: 'Thematic Meaning', l2: 'Demarcate narrative segments' },
}

// the full codebook organized by L1 intent (for the complete design-space browser)
export const CATEGORIES: { l1: string; codes: string[] }[] = (() => {
  const out: { l1: string; codes: string[] }[] = []
  const idx = new Map<string, number>()
  for (const [code, { l1 }] of Object.entries(CODEBOOK)) {
    if (!idx.has(l1)) { idx.set(l1, out.length); out.push({ l1, codes: [] }) }
    out[idx.get(l1)!]!.codes.push(code)
  }
  return out
})()

// expressible dims → a bipolar slider that drives camera params. `param` dedupes axes sharing a control.
export interface DimAxis { code: string; param: string; left: string; right: string; read(d: SevenDims): number; label(v: number): string; apply(d: SevenDims, v: number): SevenDims }
const distRead = (d: SevenDims) => 1 - (clamp(d.distanceM, DIST_MIN, DIST_MAX) - DIST_MIN) / (DIST_MAX - DIST_MIN)
const distApply = (d: SevenDims, v: number): SevenDims => { const dist = Math.round(lerp(DIST_MAX, DIST_MIN, v)); return { ...d, distanceM: dist, shotSize: zoneOf(dist / (d.composition.zoom ?? 1)) } }

export const DIM_AXES: Record<string, DimAxis> = {
  '5.1': {
    code: '5.1', param: 'pitch', left: 'Weak · vulnerable', right: 'Dominant · powerful',
    read: (d) => clamp((30 - d.angle.pitch) / 60, 0, 1),
    label: (v) => (v < 0.4 ? 'High angle · weak' : v < 0.62 ? 'Eye level · equal' : 'Low angle · strong'),
    apply: (d, v) => { const pitch = Math.round(lerp(30, -30, v)); return { ...d, angle: { ...d.angle, pitch, level: pitch > 5 ? 'High' : pitch < -5 ? 'Low' : 'Eye' } } },
  },
  '10.2': {
    code: '10.2', param: 'dist', left: 'Tiny · engulfed', right: 'Subject · prominent',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.3 ? 'Engulfed by space' : v < 0.6 ? 'Neutral' : 'Subject prominent'),
  },
  '5.3': {
    code: '5.3', param: 'dist', left: 'Isolated · detached', right: 'Intimate · connected',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.35 ? 'Isolated · detached' : v < 0.6 ? 'Neutral' : 'Close'),
  },
  '7.1': {
    code: '7.1', param: 'dist', left: 'Keep distance', right: 'Intimate closeness',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.4 ? 'Distant' : v < 0.65 ? 'Neutral' : 'Closer'),
  },
  '2.1': {
    code: '2.1', param: 'dof', left: 'Show environment', right: 'Emphasize subject',
    read: (d) => 1 - (d.focal.dof ?? 0.5),
    label: (v) => (v < 0.4 ? 'Toward environment' : v < 0.6 ? 'Balanced' : 'Focus subject'),
    apply: (d, v) => ({ ...d, focal: { ...d.focal, dof: Math.round((1 - v) * 100) / 100 } }),
  },
  '6.1': {
    code: '6.1', param: 'pace', left: 'Slow · stagnant', right: 'Fast · urgent',
    read: (d) => clamp((8 - d.movement.durationSec) / 7.5, 0, 1),
    label: (v) => (v < 0.4 ? 'Slow · stagnant' : v < 0.65 ? 'Medium' : 'Fast · urgent'),
    apply: (d, v) => ({ ...d, movement: { ...d.movement, durationSec: Math.round((8 - v * 7.5) * 2) / 2 } }),
  },
  '11.1': {
    code: '11.1', param: 'tension', left: 'Balanced · stable', right: 'Unbalanced · tension',
    read: (d) => clamp((d.color.contrast + 10) / 50, 0, 1),
    label: (v) => (v < 0.4 ? 'Balanced · stable' : v < 0.6 ? 'Neutral' : 'Unbalanced · tension'),
    apply: (d, v) => ({ ...d, color: { ...d.color, contrast: Math.round(lerp(-10, 40, v)) } }),
  },
  '3.4': {
    code: '3.4', param: 'warmth', left: 'Cold · solitary', right: 'Warm · close',
    read: (d) => d.lighting.temperature ?? 0.5,
    label: (v) => (v < 0.4 ? 'Cooler · solitary' : v < 0.6 ? 'Neutral' : 'Warmer · cozy'),
    apply: (d, v) => ({ ...d, lighting: { ...d.lighting, temperature: Math.round(v * 100) / 100 }, color: { ...d.color, look: v < 0.38 ? 'Cool' : v > 0.62 ? 'Warm' : 'Teal & Orange' } }),
  },
}
// param → why it produces that meaning/intent (mechanism), keyed by param. Used by "why shot this way".
export const AXIS_MECHANISM: Record<string, string> = {
  pitch: "Camera height changes the audience's up/down vantage: a low angle lifts the subject, making them tall and imposing; a high angle presses them down, making them small and fragile; eye level reads objective and equal.",
  dist: 'The camera-to-subject distance sets how much of the frame the subject fills: pulling back → surrounded by environment, small and detached; moving close → filling the frame, intimate and intense.',
  dof: 'Depth of field controls the zone of sharpness: shallow DoF blurs the background and forces attention onto the subject; deep DoF keeps front-to-back sharp and conveys the environment.',
  pace: 'Shot duration and motion speed set the rhythm: shorter and faster feels more urgent and pressing; a longer duration stalls time, giving emotion room to settle.',
  tension: 'Contrast and compositional balance set the visual tension: high contrast / unbalanced composition creates unease and tension; low contrast / balanced composition brings stability and restraint.',
  warmth: 'Color temperature sets the emotional key: warm (toward orange-yellow) feels close and cozy; cool (toward blue-cyan) feels detached, solitary and cold.',
}

// the axis's current measured-parameter phrase (for reasoning — shows real numbers, not abstract direction)
export function axisParamPhrase(ax: DimAxis, d: SevenDims): string {
  switch (ax.param) {
    case 'pitch': return `Pitch ${d.angle.pitch}°`
    case 'dist': return `Camera-to-subject ${d.distanceM.toFixed(1)}m · ${d.shotSize}`
    case 'dof': return `Depth of field ${(d.focal.dof ?? 0.5).toFixed(2)} (0 very shallow … 1 all sharp)`
    case 'pace': return `Shot length ${d.movement.durationSec.toFixed(1)}s`
    case 'tension': return `Contrast ${d.color.contrast >= 0 ? '+' : ''}${d.color.contrast}`
    case 'warmth': {
      const t = d.lighting.temperature ?? 0.5
      return `Color temp ${t < 0.4 ? 'cool' : t > 0.62 ? 'warm' : 'neutral'} · ~${Math.round(7000 - t * 3800)}K`
    }
    default: return ''
  }
}

// opposite poles / sibling atmospheres of the same bipolar axes → reuse the same control
DIM_AXES['6.2'] = DIM_AXES['6.1']!
DIM_AXES['10.3'] = DIM_AXES['10.2']!
DIM_AXES['11.2'] = DIM_AXES['11.1']!
DIM_AXES['3.5'] = DIM_AXES['3.4']! // Warm/Cozy = warm pole of the same cool↔warm axis
DIM_AXES['3.1'] = DIM_AXES['3.4']! // Oppressive (cool) also uses the cool↔warm axis
DIM_AXES['3.3'] = DIM_AXES['3.4']! // Gloomy
