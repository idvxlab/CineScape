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
    key: 'proximity', name: '观众与人物的关系', left: '旁观疏离', right: '靠近亲密',
    read: (d) => 1 - (clamp(d.distanceM, DIST_MIN, DIST_MAX) - DIST_MIN) / (DIST_MAX - DIST_MIN),
    label: (v) => (v < 0.25 ? '疏离' : v < 0.45 ? '旁观' : v < 0.6 ? '中性' : v < 0.8 ? '靠近' : '亲密'),
    apply: (d, v) => {
      const dist = Math.round(lerp(DIST_MAX, DIST_MIN, v))
      return { ...d, distanceM: dist, shotSize: zoneOf(dist / (d.composition.zoom ?? 1)) }
    },
  },
  viewpos: {
    key: 'viewpos', name: '观看位置', left: '俯视脆弱', right: '平视陪伴',
    read: (d) => clamp((30 - d.angle.pitch) / 60, 0, 1),
    label: (v) => (v < 0.4 ? '俯视·人物显小' : v < 0.62 ? '平视·平等陪伴' : '仰视·人物有力'),
    apply: (d, v) => {
      const pitch = Math.round(lerp(30, -30, v))
      return { ...d, angle: { ...d.angle, pitch, level: levelOf(pitch) } }
    },
  },
  attention: {
    key: 'attention', name: '叙事关注点', left: '空间处境', right: '人物内心',
    read: (d) => 1 - (d.focal.dof ?? 0.5),
    label: (v) => (v < 0.4 ? '偏环境' : v < 0.6 ? '平衡偏人物' : '聚焦内心'),
    apply: (d, v) => ({ ...d, focal: { ...d.focal, dof: Math.round((1 - v) * 100) / 100 } }),
  },
  readability: {
    key: 'readability', name: '人物的可感性', left: '难以辨认', right: '情绪可读',
    read: (d) => clamp((d.lighting.keyPct ?? 60) / 100, 0, 1),
    label: (v) => (v < 0.4 ? '较暗·难辨' : v < 0.65 ? '较高' : '清晰可读'),
    apply: (d, v) => ({ ...d, lighting: { ...d.lighting, keyPct: Math.round(v * 100) } }),
  },
  tension: {
    key: 'tension', name: '情绪张力', left: '平静克制', right: '紧张失衡',
    read: (d) => clamp((d.color.contrast + 10) / 50, 0, 1),
    label: (v) => (v < 0.4 ? '平静' : v < 0.6 ? '中性' : '紧张·失衡'),
    apply: (d, v) => ({ ...d, color: { ...d.color, contrast: Math.round(lerp(-10, 40, v)) } }),
  },
  warmth: {
    key: 'warmth', name: '光色情绪', left: '冷峻保留', right: '温暖靠近',
    read: (d) => d.lighting.temperature ?? 0.5,
    label: (v) => (v < 0.4 ? '偏冷峻' : v < 0.6 ? '中性' : '偏温暖'),
    apply: (d, v) => ({
      ...d,
      lighting: { ...d.lighting, temperature: Math.round(v * 100) / 100 },
      color: { ...d.color, look: v < 0.38 ? 'Cool' : v > 0.62 ? 'Warm' : 'Teal & Orange' },
    }),
  },
  pace: {
    key: 'pace', name: '运动节奏', left: '凝滞克制', right: '推进流动',
    read: (d) => (d.movement.type === 'Static' ? 0.15 : d.movement.type === 'Dolly In' || d.movement.type === 'Dolly Out' ? 0.6 : 0.85),
    label: (v) => (v < 0.35 ? '固定·凝滞' : v < 0.7 ? '缓慢推进' : '明显运动'),
    apply: (d, v) => ({ ...d, movement: { ...d.movement, type: v < 0.35 ? 'Static' : v < 0.7 ? 'Dolly In' : 'Truck' } }),
  },
}

export const ALL_PARAM_KEYS = Object.keys(PARAMS)

// dims → a plain-language "how it's realized" descriptor line (实现方式)
export function realizationLine(d: SevenDims): string {
  const sizeCN = ({ 'Extreme Wide': '大远景', Wide: '全景', Medium: '中景', 'Medium Close-Up': '中近景', 'Close-Up': '近景', 'Extreme Close-Up': '大特写' } as Record<string, string>)[d.shotSize] ?? d.shotSize
  const view = d.angle.pitch > 8 ? '俯视' : d.angle.pitch < -8 ? '仰视' : '平视'
  const dofW = d.focal.dof < 0.4 ? '浅景深' : d.focal.dof > 0.6 ? '深景深' : '中景深'
  const move = d.movement.type === 'Static' ? '稳定机位' : d.movement.type === 'Dolly In' ? '缓慢推进' : d.movement.type === 'Dolly Out' ? '缓慢拉远' : `${d.movement.type}`
  const comp = (d.composition.focus?.x ?? 0.5) < 0.42 ? '人物偏左构图' : (d.composition.focus?.x ?? 0.5) > 0.58 ? '人物偏右构图' : '人物居中构图'
  const color = (d.color.look || '').toLowerCase().includes('warm') ? '暖色调' : (d.color.look || '').toLowerCase().includes('teal') ? '青橙调' : '冷色调'
  const con = d.color.contrast > 15 ? '高对比' : d.color.contrast < -15 ? '低对比' : '中对比'
  const blur = d.focal.dof < 0.35 ? '背景强虚化' : d.focal.dof < 0.6 ? '轻微背景虚化' : '前后清晰'
  return [sizeCN, view, dofW, move, '焦点在人物', comp, color, con, blur].join('，')
}
