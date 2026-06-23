import type { ShotSize, Level, MoveType, Easing, SevenDims, Anchor, CompPreset } from '../api/types'

// ===== Composition =====
// Subject Anchor 3×3 grid → normalized subject position in the frame (point2d)
// 3×3 anchor points aligned to the rule-of-thirds lines (+ center)
export const ANCHOR_COLS = [1 / 3, 0.5, 2 / 3]
export const ANCHOR_ROWS = [1 / 3, 0.5, 2 / 3]
export const ANCHOR_CELLS: { x: number; y: number }[] = ANCHOR_ROWS.flatMap((y) =>
  ANCHOR_COLS.map((x) => ({ x, y })),
)
// Nearest grid cell (used to highlight the cell the subject currently sits in)
export function nearestCell(p: { x: number; y: number }): number {
  let best = 0, bd = Infinity
  ANCHOR_CELLS.forEach((c, i) => {
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2
    if (d < bd) { bd = d; best = i }
  })
  return best
}

// Composition preset: one click sets the in-frame subject focus + rule (headroom/leadRoom derived from focus)
export interface CompPresetDef {
  id: CompPreset
  label: string
  focus: { x: number; y: number }
  rule: SevenDims['composition']['rule']
}
// Composition presets sit exactly on the center + the four rule-of-thirds intersections
export const COMP_PRESETS: CompPresetDef[] = [
  { id: 'center', label: 'Center', focus: { x: 0.5, y: 0.5 }, rule: 'center' },
  { id: 'left-third', label: 'Left Third', focus: { x: 1 / 3, y: 1 / 3 }, rule: 'thirds' },
  { id: 'right-third', label: 'Right Third', focus: { x: 2 / 3, y: 1 / 3 }, rule: 'thirds' },
  { id: 'dynamics', label: 'Dynamics', focus: { x: 1 / 3, y: 2 / 3 }, rule: 'thirds' },
  { id: 'negative-space', label: 'Negative Space', focus: { x: 2 / 3, y: 2 / 3 }, rule: 'lead-room' },
]
// focus → headroom (top empty space = focus.y) / leadRoom (front empty space ≈ 1 - focus.x)
export const headroomOf = (focus: { x: number; y: number }) => focus.y
export const leadRoomOf = (focus: { x: number; y: number }) => 1 - focus.x

// ===== Camera movement: type → last frame derived from the first-frame pose (determines trajectory shape) =====
export interface CamPose { yaw: number; dist: number; pitch: number }
const clampN = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
export function deriveMoveEnd(type: MoveType, start?: CamPose): CamPose | undefined {
  if (!start) return undefined
  switch (type) {
    case 'Static': return undefined // no movement: no last frame
    case 'Custom': return undefined // keyframes are recorded by the user, not derived
    case 'Dolly In': return { ...start, dist: clampN(start.dist * 0.5, DIST_MIN, DIST_MAX) } // straight toward the subject
    case 'Dolly Out': return { ...start, dist: clampN(start.dist * 1.7, DIST_MIN, DIST_MAX) } // straight away
    case 'Pan': return { ...start, yaw: start.yaw + 45 } // rotate along the orbit
    case 'Truck': return { ...start, yaw: start.yaw - 35 } // lateral move
    case 'Follow': return { ...start, yaw: start.yaw + 20, dist: clampN(start.dist * 0.85, DIST_MIN, DIST_MAX) }
    case 'Crane': return { ...start, pitch: clampN(start.pitch + 35, PITCH_MIN, PITCH_MAX) } // vertical move
    default: return start
  }
}
// Whether this type allows a custom last frame (Static does not)
export const movePathEditable = (type: MoveType) => type !== 'Static'

// ===== Display labels =====
// Vertical camera angle
export const LEVEL_EN: Record<Level, string> = { High: 'High Angle', Eye: 'Eye Level', Low: 'Low Angle' }
export function easeEn(e: Easing) {
  return e === 'ease-in-out' ? 'Ease In-Out' : e === 'ease-in' ? 'Ease In' : e === 'ease-out' ? 'Ease Out' : 'Linear'
}

// Distance threshold → shot size (illustrative, tunable)
const ZONES: { max: number; size: ShotSize }[] = [
  { max: 2, size: 'Extreme Close-Up' },
  { max: 4, size: 'Close-Up' },
  { max: 6, size: 'Medium Close-Up' },
  { max: 10, size: 'Medium' },
  { max: 20, size: 'Wide' },
  { max: Infinity, size: 'Extreme Wide' },
]
export const DIST_MIN = 1
export const DIST_MAX = 26
export const PITCH_MIN = -90
export const PITCH_MAX = 90

export function zoneOf(distanceM: number): ShotSize {
  return ZONES.find((z) => distanceM <= z.max)!.size
}
// Convention: pitch>0 = camera raised (high position → looking down); pitch<0 = camera lowered (low position → looking up)
export function levelOf(pitch: number): Level {
  if (pitch > 5) return 'High'
  if (pitch < -5) return 'Low'
  return 'Eye'
}

// Concentric shot-size rings (radius uses distance directly as meters, scaled at render time)
export const SHOT_RINGS: { size: ShotSize; r: number }[] = [
  { size: 'Close-Up', r: 4 },
  { size: 'Medium Close-Up', r: 6 },
  { size: 'Medium', r: 10 },
  { size: 'Wide', r: 20 },
]

// Movement type: inferred automatically from the start→end pose difference (MVP uses distance delta only)
export function inferMove(startD: number, endD: number): SevenDims['movement']['type'] {
  if (Math.abs(endD - startD) < 0.3) return 'Static'
  return endD > startD ? 'Dolly Out' : 'Dolly In'
}

// ===== Seven dims + anchor → one-line Prompt (mock; production version compiled by the backend's compile-prompt) =====
export function mockCompilePrompt(dims: SevenDims, _anchor: Anchor): string {
  const mv = dims.movement
  const move =
    mv.type === 'Static'
      ? 'Static frame'
      : `${mv.type} (${mv.durationSec.toFixed(1)}s, ${easeEn(mv.easing)})`
  const dof = dims.focal.dof < 0.4 ? 'shallow DoF' : dims.focal.dof > 0.6 ? 'deep DoF' : 'medium DoF'
  const angle =
    dims.angle.level === 'High'
      ? `high angle ${Math.abs(dims.angle.pitch)}°`
      : dims.angle.level === 'Low'
        ? `low angle ${Math.abs(dims.angle.pitch)}°`
        : 'eye level'
  return `${move}, ${dof}, ${dims.shotSize}, ${angle}, ${dims.color.look}, contrast ${signed(dims.color.contrast)} / saturation ${signed(dims.color.saturation)}, cinematic.`
}

function signed(n: number) {
  return n >= 0 ? `+${n}` : `${n}`
}
