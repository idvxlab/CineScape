// Design-space "atoms": each is one semantic axis with a bidirectional map to camera params.
// The editor never shows all of them — each shot's ROLE projects out a small task-relevant subset
// (task-driven projection of a high-dimensional cinematography design space).
import type { SevenDims } from '../api/types'
import { zoneOf, levelOf, DIST_MIN, DIST_MAX } from './dims'

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface DesignParam {
  key: string
  name: string // default display name (drawer)
  left: string // 0 end
  right: string // 1 end
  read(d: SevenDims): number // current 0..1
  label(v: number): string // current value text
  apply(d: SevenDims, v: number): SevenDims // intent → params
}

export const PARAMS: Record<string, DesignParam> = {
  proximity: {
    key: 'proximity', name: 'Viewer–subject relation', left: 'Detached observer', right: 'Close & intimate',
    read: (d) => 1 - (clamp(d.distanceM, DIST_MIN, DIST_MAX) - DIST_MIN) / (DIST_MAX - DIST_MIN),
    label: (v) => (v < 0.25 ? 'Detached' : v < 0.45 ? 'Observing' : v < 0.6 ? 'Neutral' : v < 0.8 ? 'Closer' : 'Intimate'),
    apply: (d, v) => {
      const dist = Math.round(lerp(DIST_MAX, DIST_MIN, v))
      return { ...d, distanceM: dist, shotSize: zoneOf(dist / (d.composition.zoom ?? 1)) }
    },
  },
  viewpos: {
    key: 'viewpos', name: 'Viewing position', left: 'High angle · vulnerable', right: 'Eye level · companion',
    read: (d) => clamp((30 - d.angle.pitch) / 60, 0, 1),
    label: (v) => (v < 0.4 ? 'High angle · subject small' : v < 0.62 ? 'Eye level · equal companion' : 'Low angle · subject powerful'),
    apply: (d, v) => {
      const pitch = Math.round(lerp(30, -30, v))
      return { ...d, angle: { ...d.angle, pitch, level: levelOf(pitch) } }
    },
  },
  attention: {
    key: 'attention', name: 'Narrative focus', left: 'Spatial situation', right: 'Inner self',
    read: (d) => 1 - (d.focal.dof ?? 0.5),
    label: (v) => (v < 0.4 ? 'Toward environment' : v < 0.6 ? 'Balanced toward subject' : 'Focus on inner self'),
    apply: (d, v) => ({ ...d, focal: { ...d.focal, dof: Math.round((1 - v) * 100) / 100 } }),
  },
  readability: {
    key: 'readability', name: 'Character legibility', left: 'Hard to read', right: 'Emotionally legible',
    read: (d) => clamp((d.lighting.keyPct ?? 60) / 100, 0, 1),
    label: (v) => (v < 0.4 ? 'Dim · hard to read' : v < 0.65 ? 'Brighter' : 'Clear & legible'),
    apply: (d, v) => ({ ...d, lighting: { ...d.lighting, keyPct: Math.round(v * 100) } }),
  },
  tension: {
    key: 'tension', name: 'Emotional tension', left: 'Calm restraint', right: 'Tense · unbalanced',
    read: (d) => clamp((d.color.contrast + 10) / 50, 0, 1),
    label: (v) => (v < 0.4 ? 'Calm' : v < 0.6 ? 'Neutral' : 'Tense · unbalanced'),
    apply: (d, v) => ({ ...d, color: { ...d.color, contrast: Math.round(lerp(-10, 40, v)) } }),
  },
  warmth: {
    key: 'warmth', name: 'Light-color mood', left: 'Cool · reserved', right: 'Warm · close',
    read: (d) => d.lighting.temperature ?? 0.5,
    label: (v) => (v < 0.4 ? 'Cooler' : v < 0.6 ? 'Neutral' : 'Warmer'),
    apply: (d, v) => ({
      ...d,
      lighting: { ...d.lighting, temperature: Math.round(v * 100) / 100 },
      color: { ...d.color, look: v < 0.38 ? 'Cool' : v > 0.62 ? 'Warm' : 'Teal & Orange' },
    }),
  },
  pace: {
    key: 'pace', name: 'Motion pace', left: 'Held · restrained', right: 'Driving · flowing',
    read: (d) => (d.movement.type === 'Static' ? 0.15 : d.movement.type === 'Dolly In' || d.movement.type === 'Dolly Out' ? 0.6 : 0.85),
    label: (v) => (v < 0.35 ? 'Static · held' : v < 0.7 ? 'Slow push-in' : 'Clear motion'),
    apply: (d, v) => ({ ...d, movement: { ...d.movement, type: v < 0.35 ? 'Static' : v < 0.7 ? 'Dolly In' : 'Truck' } }),
  },
}

export const ALL_PARAM_KEYS = Object.keys(PARAMS)

// dims → a plain-language "how it's realized" descriptor line
export function realizationLine(d: SevenDims): string {
  const size = ({ 'Extreme Wide': 'Extreme Wide', Wide: 'Wide', Medium: 'Medium', 'Medium Close-Up': 'Medium Close-Up', 'Close-Up': 'Close-Up', 'Extreme Close-Up': 'Extreme Close-Up' } as Record<string, string>)[d.shotSize] ?? d.shotSize
  const view = d.angle.pitch > 8 ? 'High angle' : d.angle.pitch < -8 ? 'Low angle' : 'Eye level'
  const dofW = d.focal.dof < 0.4 ? 'Shallow DoF' : d.focal.dof > 0.6 ? 'Deep DoF' : 'Medium DoF'
  const move = d.movement.type === 'Static' ? 'Static camera' : d.movement.type === 'Dolly In' ? 'Slow push-in' : d.movement.type === 'Dolly Out' ? 'Slow pull-out' : `${d.movement.type}`
  const comp = (d.composition.focus?.x ?? 0.5) < 0.42 ? 'Subject left' : (d.composition.focus?.x ?? 0.5) > 0.58 ? 'Subject right' : 'Subject centered'
  const color = (d.color.look || '').toLowerCase().includes('warm') ? 'Warm tone' : (d.color.look || '').toLowerCase().includes('teal') ? 'Teal & orange' : 'Cool tone'
  const con = d.color.contrast > 15 ? 'High contrast' : d.color.contrast < -15 ? 'Low contrast' : 'Mid contrast'
  const blur = d.focal.dof < 0.35 ? 'Strong background blur' : d.focal.dof < 0.6 ? 'Slight background blur' : 'Front-to-back sharp'
  return [size, view, dofW, move, 'Focus on subject', comp, color, con, blur].join(', ')
}
