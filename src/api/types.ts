// ===== Seven-dimensional cinematic language (technique layer, read/written by the editor) =====
export type ShotSize = 'Extreme Wide' | 'Wide' | 'Medium' | 'Medium Close-Up' | 'Close-Up' | 'Extreme Close-Up'
export type MoveType = 'Static' | 'Dolly In' | 'Dolly Out' | 'Pan' | 'Truck' | 'Follow' | 'Crane' | 'Custom'
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
export type Level = 'High' | 'Eye' | 'Low'
// Composition presets
export type CompPreset = 'center' | 'left-third' | 'right-third' | 'dynamics' | 'negative-space'

export interface SevenDims {
  distanceM: number // anchor → camera distance (continuous, primary editor control)
  shotSize: ShotSize // derived from distanceM
  angle: { yaw: number; pitch: number; level: Level }
  // focus: normalized subject position within the frame (0–1); composition controls it independently, without affecting the camera's orbit center (anchor)
  // headroom/leadRoom: top/front empty-space ratios derived from focus; balance is reserved
  // focus: subject position inside the framing box (composition); zoom: framing / field-of-view (1 = base, >1 = tighter)
  composition: { rule: 'center' | 'thirds' | 'lead-room'; focus: { x: number; y: number }; headroom: number; leadRoom: number; balance: number; zoom?: number; preset?: CompPreset }
  // start/end: first-frame/last-frame camera pose (set via orbit/tilt/distance then confirmed); interpolation between the two poses = motion trajectory
  // endAuto: whether the last frame is auto-derived from the movement-type preset (true = can be overridden by manual confirmation; false = manually confirmed)
  // path: recorded camera poses (Record → drag the camera → Done); start/end kept = path ends, for compatibility
  movement: { type: MoveType; durationSec: number; easing: Easing; start?: { yaw: number; dist: number; pitch: number }; end?: { yaw: number; dist: number; pitch: number }; endAuto?: boolean; path?: { yaw: number; dist: number; pitch: number }[] }
  // rhythm: speed-time curve (x = time 0–1, y = speed 0–1; draggable control points)
  rhythm: { curve: { x: number; y: number }[] }
  // pos: light position on canvas (normalized); softness 0=hard→1=soft; temperature 0=cool→1=warm; spread 0=spot→1=flood
  lighting: { direction: string; keyPct: number; ratio: number; pos?: { x: number; y: number }; softness?: number; temperature?: number; spread?: number }
  color: { look: string; contrast: number; saturation: number; tint?: number } // tint: −50 绿 ↔ +50 品红
  focal: { mm: number; dof: number } // dof: 0 shallow depth of field → 1 deep depth of field
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Anchor { point2d: { x: number; y: number }; depthM: number; liftM?: number; bbox?: Rect } // liftM: subject's vertical lift off the ground (m), 0 = standing

export interface Shot {
  id: string
  index: number
  label: string
  startSec: number
  endSec: number
  thumbnailUrl?: string
  description: string
  anchor: Anchor // what the camera orbits around (initial value = backend detection; adjustments affect only this shot)
  dims: SevenDims
  promptSummary: string
  role?: string // narrative function in the story (establish / advance / detail) — drives a differentiated look
  serves?: string[] // v3 design-space sub-intent codes this shot serves (from the backend scheme)
}

export interface IntentTag { code: string; name: string; nameEn?: string; group: string }

export interface Plan {
  id: string
  variant: 'A' | 'B' | 'C'
  title: string
  shots: Shot[]
  rationale: string[]
  totalSec: number
  shotCount: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: string
  highlights?: string[]
}

export type VideoStatus = 'idle' | 'queued' | 'running' | 'done' | 'error'
export interface VideoJob { id: string; status: VideoStatus; progress: number; url?: string }

export interface Source { url: string; type: 'video' | 'image'; durationSec?: number; detectedAnchor: Anchor }

export interface Project {
  id: string
  source: Source
  chat: ChatMessage[]
  intents: IntentTag[]
  plans: Plan[]
  activePlanId: string
  activeShotId: string
  video: VideoJob
  updatedAt: string
}
