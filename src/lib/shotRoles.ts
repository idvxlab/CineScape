// Shot ROLE layer: the story intent stays shared across shots, but each shot carries a different
// narrative function and therefore a different SPATIAL expression (size/angle/composition/focus/motion).
// Role only sets the spatial starting point — color/lighting (the intent mood) are left intact.
import type { SevenDims, Shot } from '../api/types'
import { zoneOf, levelOf } from './dims'

// a task-relevant semantic axis projected for a role (references a DesignParam, with role-framed labels)
export interface TaskAxis { param: string; name: string; left: string; right: string }

export interface ShotRole {
  key: string
  name: string
  desc: string
  advance: string // how this shot advances the story
  taskAxes: TaskAxis[] // the small task-relevant subset of the design space surfaced for this role
  apply(d: SevenDims): SevenDims // differentiated starting point for this role
}

const spatial = (d: SevenDims, p: { dist: number; pitch: number; yaw?: number; mm: number; dof: number; fx: number; fy: number; move: SevenDims['movement']['type']; dur: number }): SevenDims => {
  const zoom = d.composition.zoom ?? 1
  return {
    ...d,
    distanceM: p.dist,
    shotSize: zoneOf(p.dist / zoom),
    angle: { ...d.angle, yaw: p.yaw ?? d.angle.yaw, pitch: p.pitch, level: levelOf(p.pitch) },
    focal: { ...d.focal, mm: p.mm, dof: p.dof },
    composition: { ...d.composition, focus: { x: p.fx, y: p.fy } },
    movement: { ...d.movement, type: p.move, durationSec: p.dur },
    // color + lighting deliberately untouched → shared story mood persists
  }
}

export const ROLES: ShotRole[] = [
  {
    key: 'establish',
    name: 'Establish situation',
    desc: 'Let the audience see the character–space relation — solitude comes from "space"',
    advance: 'Establish spatial pressure first, reserving emotional tension for the next "approach the character" shot.',
    taskAxes: [
      { param: 'proximity', name: 'Spatial relation', left: 'Enveloped by environment', right: 'Subject stands out' },
      { param: 'viewpos', name: 'Viewing position', left: 'High angle · vulnerable', right: 'Eye level · companion' },
      { param: 'attention', name: 'Narrative attention', left: 'Spatial situation', right: 'Inner self' },
    ],
    apply: (d) => spatial(d, { dist: 20, pitch: 16, mm: 24, dof: 0.8, fx: 0.3, fy: 0.42, move: 'Static', dur: 4 }),
  },
  {
    key: 'advance',
    name: 'Advance feeling',
    desc: 'Move the audience from "observing" to "entering the character\'s emotion".',
    advance: 'Carry the audience from observer into the character\'s inner world, building toward the emotional detail in the next shot.',
    taskAxes: [
      { param: 'proximity', name: 'Viewer–subject relation', left: 'Detached observer', right: 'Close & intimate' },
      { param: 'attention', name: 'Narrative focus', left: 'Spatial situation', right: 'Inner self' },
      { param: 'readability', name: 'Character legibility', left: 'Hard to read', right: 'Emotionally legible' },
    ],
    apply: (d) => spatial(d, { dist: 5, pitch: 0, mm: 50, dof: 0.28, fx: 0.5, fy: 0.5, move: 'Dolly In', dur: 4 }),
  },
  {
    key: 'detail',
    name: 'Emotional landing',
    desc: 'Land on hands/eyes/details, emotion internalized not erupting — solitude comes from "emotional detail"',
    advance: 'Let the emotion settle into the details without erupting, leaving an aftertaste to close the sequence.',
    taskAxes: [
      { param: 'proximity', name: 'Local detail', left: 'Whole environment', right: 'Local detail' },
      { param: 'tension', name: 'Emotional tension', left: 'Calm restraint', right: 'Tense · unbalanced' },
      { param: 'warmth', name: 'Light-color mood', left: 'Cool · reserved', right: 'Warm · close' },
    ],
    apply: (d) => spatial(d, { dist: 2.5, pitch: 8, yaw: 40, mm: 85, dof: 0.12, fx: 0.42, fy: 0.55, move: 'Static', dur: 5 }),
  },
]

export const roleByKey = (k?: string) => ROLES.find((r) => r.key === k)
export const defaultRoleKey = (index: number) => ROLES[Math.min(index, ROLES.length - 1)]?.key ?? 'advance'
export const shotRoleKey = (s: Shot, index: number) => s.role ?? defaultRoleKey(index)

// ---- group analysis: per-shot aspect for the trajectory + adjacent-similarity warnings ----
export interface ShotAspect { size: string; view: string; focus: string }
export function shotAspect(d: SevenDims): ShotAspect {
  const sz = d.distanceM > 14 ? 'Wide' : d.distanceM > 6 ? 'Medium' : d.distanceM > 3 ? 'Med-Close' : 'Close'
  const v = d.angle.pitch > 8 ? 'High' : d.angle.pitch < -8 ? 'Low' : Math.abs(((d.angle.yaw % 360) + 360) % 360 - 180) < 60 ? 'Behind' : 'Eye'
  const f = d.focal.dof > 0.6 ? 'Environment' : d.focal.dof < 0.35 ? 'Detail' : 'Subject'
  return { size: sz, view: v, focus: f }
}

// compare adjacent shots; if too many key dims coincide → a "shots too similar" warning
export function similarityWarnings(shots: Shot[]): { i: number; j: number; shared: string[] }[] {
  const out: { i: number; j: number; shared: string[] }[] = []
  for (let i = 0; i < shots.length - 1; i++) {
    const a = shotAspect(shots[i]!.dims), b = shotAspect(shots[i + 1]!.dims)
    const shared: string[] = []
    if (a.size === b.size) shared.push('Size')
    if (a.view === b.view) shared.push('View')
    if (a.focus === b.focus) shared.push('Focus')
    if (shared.length >= 2) out.push({ i, j: i + 1, shared })
  }
  return out
}
