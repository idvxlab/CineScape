// Reverse mapping: cinematic PARAMETERS → INTENT / meaning.
// The editor is a semantic editor — every number is annotated with what it expresses.
import type { SevenDims, ShotSize } from '../api/types'

const SHOT: Record<ShotSize, string> = {
  'Extreme Wide': 'Solitude · Tiny',
  Wide: 'Detached · Objective',
  Medium: 'Plain · Narrative',
  'Medium Close-Up': 'Closer · Attentive',
  'Close-Up': 'Intimate · Emotional',
  'Extreme Close-Up': 'Tense · Intense',
}
export const shotSizeMeaning = (d: SevenDims): string => SHOT[d.shotSize] ?? 'Narrative'

// pitch>0 = camera high, looking down → subject small;  pitch<0 = low, looking up → subject powerful
export const angleMeaning = (pitch: number): string =>
  pitch < -5 ? 'Low angle · Power · Imposing' : pitch > 5 ? 'High angle · Tiny · Vulnerable' : 'Eye level · Objective · Equal'

export const orbitMeaning = (yaw: number): string => {
  const a = Math.abs(((yaw % 360) + 360) % 360)
  const aa = a > 180 ? 360 - a : a
  if (aa < 30) return 'Frontal · Direct · Confronting'
  if (aa < 110) return 'Side · Observing · Detached'
  return 'Behind · Reverse · Following'
}

export const dofMeaning = (dof: number): string =>
  dof < 0.4 ? 'Shallow DoF · Focus · Emotional isolation' : dof > 0.6 ? 'Deep DoF · Context · Objective' : 'Medium DoF · Balanced'

export const focalMeaning = (mm: number): string =>
  mm <= 28 ? 'Wide · Tension · Exaggerated depth' : mm >= 70 ? 'Telephoto · Compression · Detached gaze' : 'Standard · Natural'

export const moveMeaning = (type: string): string => {
  switch (type) {
    case 'Dolly In': return 'Push in · Approaching · Emotional involvement'
    case 'Dolly Out': return 'Pull out · Detaching · Toward solitude'
    case 'Pan': return 'Pan · Scanning · Reveal'
    case 'Truck': return 'Truck · Accompanying'
    case 'Follow': return 'Follow · Immersion'
    case 'Crane': return 'Crane · Lyrical · Grand'
    default: return 'Static · Held · Objective'
  }
}

export const lookMeaning = (look: string): string => {
  const l = (look || '').toLowerCase()
  if (l.includes('warm')) return 'Warm · Cozy · Cheerful'
  if (l.includes('teal')) return 'Teal & Orange · Tension · Dramatic'
  if (l.includes('film')) return 'Film · Nostalgic · Textured'
  return 'Cool · Detached · Melancholic'
}
export const colorMeaning = (d: SevenDims): string => lookMeaning(d.color?.look || '')

export const timeMeaning = (sec: number): string =>
  sec <= 2 ? 'Rapid · Tense · Sharp' : sec >= 6 ? 'Slow · Reflective · Held' : 'Steady · Natural narrative'

export const lightMeaning = (l: SevenDims['lighting']): string => {
  const key = l.keyPct ?? 60
  const warm = l.temperature ?? 0.5
  const tone = key < 40 ? 'Low key · Oppressive · Mysterious' : key > 75 ? 'High key · Bright · Clear' : 'Neutral light · Plain'
  return tone + (warm > 0.66 ? ' · Warm' : warm < 0.34 ? ' · Cool' : '')
}

export const compMeaning = (c: SevenDims['composition']): string => {
  const fx = c.focus?.x ?? 0.5
  return Math.abs(fx - 0.5) < 0.12 ? 'Centered · Stable · Symmetric' : 'Offset · Negative space · Tension'
}
