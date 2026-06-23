// Map a backend ShotScript (free-text cinematic dimensions, often Chinese) into the
// intent-to-cinema Plan/Shot model (numeric SevenDims) so the editor + ShotStrip can drive it.
import type { Plan, Shot, SevenDims, MoveType, ShotSize } from '../api/types'
import type { ShotScript, SchemeShot, PatchOp } from '../api/backend'
import { zoneOf, levelOf } from './dims'
import { shotSizeMeaning, angleMeaning, focalMeaning, dofMeaning, colorMeaning, moveMeaning } from './semantics'

const has = (s: string, ...keys: string[]) => keys.some((k) => s.includes(k))
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))

function baseDims(): SevenDims {
  return {
    distanceM: 8,
    shotSize: 'Medium',
    angle: { yaw: 0, pitch: 0, level: 'Eye' },
    composition: { rule: 'center', focus: { x: 0.5, y: 0.5 }, headroom: 0.5, leadRoom: 0.5, balance: 0, zoom: 1, preset: 'center' },
    movement: { type: 'Static', durationSec: 3, easing: 'ease-in-out' },
    rhythm: { curve: [{ x: 0, y: 0.3 }, { x: 0.5, y: 0.7 }, { x: 1, y: 0.3 }] },
    lighting: { direction: 'Backlight', keyPct: 60, ratio: 4, pos: { x: 0.5, y: 0.18 }, softness: 0.5, temperature: 0.5, spread: 0.4 },
    color: { look: 'Cool', contrast: 10, saturation: 0 },
    focal: { mm: 35, dof: 0.5 },
  }
}

function distFromSize(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '大特', 'extreme close')) return 1.5
  if (has(t, '特写', 'close-up', 'closeup', 'close up')) return 3
  if (has(t, '中近', 'medium close')) return 5
  if (has(t, '中景', 'medium', 'mid')) return 8
  if (has(t, '大远', '远景', 'extreme wide', 'very wide')) return 24
  if (has(t, '全景', 'wide', 'long shot')) return 15
  return 8
}
function pitchFromAngle(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '俯', '高角', 'high angle', 'overhead', 'top-down', 'down')) return 28
  if (has(t, '仰', '低角', 'low angle', 'up angle', 'worm')) return -28
  return 0
}
function moveFromText(s: string): MoveType {
  const t = s.toLowerCase()
  if (has(t, '推', 'dolly in', 'push in', 'push-in')) return 'Dolly In'
  if (has(t, '拉', 'dolly out', 'pull out', 'pull-back', 'pullback')) return 'Dolly Out'
  if (has(t, '摇', 'pan')) return 'Pan'
  if (has(t, '移', 'truck', 'track', 'tracking')) return 'Truck'
  if (has(t, '跟', 'follow')) return 'Follow'
  if (has(t, '升', '降', '吊', 'crane', 'jib', 'boom')) return 'Crane'
  return 'Static'
}
function mmFromFocal(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)\s*mm/i) || s.match(/(\d+(?:\.\d+)?)/)
  if (m) return clamp(parseFloat(m[1]!), 12, 200)
  const t = s.toLowerCase()
  if (has(t, '广角', 'wide')) return 24
  if (has(t, '长焦', '望远', 'tele')) return 85
  return 35
}
function dofFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '浅', 'shallow', '虚化', 'bokeh')) return 0.2
  if (has(t, '深', 'deep', '全清')) return 0.8
  return 0.5
}
function durFromText(s: string): number {
  const m = s.match(/(\d+(?:\.\d+)?)/)
  return m ? clamp(parseFloat(m[1]!), 0.5, 12) : 3
}
function lookFromTone(s: string): string {
  const t = s.toLowerCase()
  if (has(t, '青橙', 'teal')) return 'Teal & Orange'
  if (has(t, '暖', 'warm', '金', '橙')) return 'Warm'
  if (has(t, '冷', 'cool', '蓝', '青')) return 'Cool'
  if (has(t, '胶片', 'film')) return 'Film Emulation'
  return s || 'Cool'
}

function shotToDims(sh: SchemeShot): SevenDims {
  const d = baseDims()
  d.distanceM = distFromSize(sh.shot_size)
  d.angle.pitch = pitchFromAngle(sh.angle)
  d.angle.level = levelOf(d.angle.pitch)
  d.movement.type = moveFromText(sh.movement)
  d.movement.durationSec = durFromText(sh.duration)
  d.focal.mm = mmFromFocal(sh.focal_length)
  d.composition.zoom = clamp(Math.round((d.focal.mm / 35) * 100) / 100, 0.5, 4)
  d.focal.dof = dofFromText(sh.depth_of_field)
  d.color.look = lookFromTone(sh.color_tone)
  d.shotSize = zoneOf(d.distanceM / (d.composition.zoom ?? 1))
  return d
}

export function schemeToPlan(scheme: ShotScript, variant: 'A' | 'B' | 'C', imageUrl?: string): Plan {
  let t = 0
  const shots: Shot[] = scheme.shots.map((sh, i) => {
    const dims = shotToDims(sh)
    const startSec = t
    t += dims.movement.durationSec
    return {
      id: `${variant}-s${sh.order ?? i + 1}`,
      index: i + 1,
      label: `${sh.shot_size || 'Shot'}`.slice(0, 24),
      startSec,
      endSec: t,
      thumbnailUrl: imageUrl,
      description: sh.rationale || '',
      anchor: { point2d: { x: 0.5, y: 0.6 }, depthM: 8.5 },
      dims,
      promptSummary: sh.rationale || '',
    }
  })
  return {
    id: `scheme-${variant}`,
    variant,
    title: `Scheme ${variant} · ${scheme.strategy}`.slice(0, 60),
    shots,
    rationale: scheme.overall_rationale ? [scheme.overall_rationale] : [],
    totalSec: Math.round(t),
    shotCount: shots.length,
  }
}

export function schemesToPlans(schemes: ShotScript[], imageUrl?: string): Plan[] {
  const V: ('A' | 'B' | 'C')[] = ['A', 'B', 'C']
  return schemes.slice(0, 3).map((s, i) => schemeToPlan(s, V[i]!, imageUrl))
}

const SIZE_CN: Record<ShotSize, string> = {
  'Extreme Wide': '大远景', Wide: '全景', Medium: '中景', 'Medium Close-Up': '中近景', 'Close-Up': '近景', 'Extreme Close-Up': '大特写',
}

// at Generate: refresh the card TITLE (shot size) + prompt from the edited dims.
// The agent's reasoning narrative (description) is kept untouched.
export function shotReading(d: SevenDims): { label: string; prompt: string } {
  return {
    label: SIZE_CN[d.shotSize] ?? d.shotSize,
    prompt: `${d.shotSize} · ${d.angle.pitch}° · ${Math.round(d.focal.mm)}mm · DoF ${d.focal.dof.toFixed(2)} · ${d.color.look} · ${d.movement.type} · ${d.movement.durationSec.toFixed(1)}s`,
  }
}

// reverse map: an edited shot's SevenDims → backend patch ops (text fields), so a re-render reflects edits
export function dimsToPatch(d: SevenDims, order: number): PatchOp[] {
  const p = (field: string, value: string): PatchOp => ({ shot_order: order, field, value })
  const angle = d.angle.pitch > 5 ? `俯拍 高角度 ${d.angle.pitch}°` : d.angle.pitch < -5 ? `仰拍 低角度 ${d.angle.pitch}°` : '平视'
  const dof = d.focal.dof < 0.4 ? '浅景深 背景虚化' : d.focal.dof > 0.6 ? '深景深 前后清晰' : '中等景深'
  const focusX = d.composition.focus?.x ?? 0.5
  const comp = Math.abs(focusX - 0.5) < 0.12 ? '中心构图' : focusX < 0.5 ? '主体偏左 三分构图' : '主体偏右 三分构图'
  // render() prefers frame_edit_hint over the dim fields, so rebuild it from the edited dims —
  // otherwise the stale original hint wins and edits don't show in the rendered keyframe.
  const hint = `以电影摄影方式重摄此画面:${SIZE_CN[d.shotSize] ?? d.shotSize}景别、${angle}、${comp}、${Math.round(d.focal.mm)}mm焦距、${dof}、${d.color.look}色调。保持人物身份与场景元素一致(同一主体、同一空间),按上述镜头语言重新取景与调度(机位/景别/构图/景深/光色),景别变化需真实改变取景范围。`
  return [
    p('shot_size', d.shotSize),
    p('angle', angle),
    p('composition', comp),
    p('movement', d.movement.type),
    p('focal_length', `${Math.round(d.focal.mm)}mm`),
    p('depth_of_field', dof),
    p('color_tone', d.color.look),
    p('duration', `${d.movement.durationSec.toFixed(1)}s`),
    p('frame_edit_hint', hint),
  ]
}
