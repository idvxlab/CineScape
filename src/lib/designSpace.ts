// The director-intent design space (导演意图 v3): FIXED, not editable here.
// A shot lists the sub-dimensions it serves; those expressible as a bipolar control get a slider
// that drives camera params, the rest are listed read-only. (intent ↔ params is many-to-many.)
import type { SevenDims } from '../api/types'
import { zoneOf, DIST_MIN, DIST_MAX } from './dims'

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// full v3 codebook (编号 → 一级 / 二级) — read-only reference
export const CODEBOOK: Record<string, { l1: string; l2: string }> = {
  '1.1': { l1: '情绪唤起', l2: '恐惧/惊恐' }, '1.2': { l1: '情绪唤起', l2: '紧张/焦虑' }, '1.3': { l1: '情绪唤起', l2: '厌恶/反感' }, '1.4': { l1: '情绪唤起', l2: '悲伤/忧郁' }, '1.5': { l1: '情绪唤起', l2: '愉悦/欣喜' }, '1.6': { l1: '情绪唤起', l2: '愤怒/义愤' }, '1.7': { l1: '情绪唤起', l2: '敬畏/崇高' },
  '2.1': { l1: '注意引导', l2: '强调主体/细节' }, '2.2': { l1: '注意引导', l2: '引导注视路径' }, '2.3': { l1: '注意引导', l2: '弱化/隐藏' }, '2.4': { l1: '注意引导', l2: '注意重定向' },
  '3.1': { l1: '氛围营造', l2: '紧张/压抑/不祥' }, '3.2': { l1: '氛围营造', l2: '不安/失稳/眩晕' }, '3.3': { l1: '氛围营造', l2: '阴郁/忧伤' }, '3.4': { l1: '氛围营造', l2: '神秘/孤寂/疏离' }, '3.5': { l1: '氛围营造', l2: '温馨/温暖' }, '3.6': { l1: '氛围营造', l2: '浪漫/抒情' }, '3.7': { l1: '氛围营造', l2: '欢快/轻松' }, '3.8': { l1: '氛围营造', l2: '宁静/平和' }, '3.9': { l1: '氛围营造', l2: '梦幻/超现实' }, '3.10': { l1: '氛围营造', l2: '沉浸/卷入' }, '3.11': { l1: '氛围营造', l2: '真实/纪实感' },
  '4.1': { l1: '视点/认同', l2: '主观/代入' }, '4.2': { l1: '视点/认同', l2: '客观/中立旁观' }, '4.3': { l1: '视点/认同', l2: '全知/上帝视角' }, '4.4': { l1: '视点/认同', l2: '认同调节' },
  '5.1': { l1: '人物塑造', l2: '权力/地位' }, '5.2': { l1: '人物塑造', l2: '内心/情感/动机' }, '5.3': { l1: '人物塑造', l2: '人物关系' }, '5.4': { l1: '人物塑造', l2: '性格/身份' },
  '6.1': { l1: '节奏调控', l2: '加速/紧迫' }, '6.2': { l1: '节奏调控', l2: '放缓/凝滞' }, '6.3': { l1: '节奏调控', l2: '表现时间流逝' }, '6.4': { l1: '节奏调控', l2: '节奏同步/情绪曲线' },
  '7.1': { l1: '共情建立', l2: '亲密/拉近' }, '7.2': { l1: '共情建立', l2: '情感卷入/共鸣' }, '7.3': { l1: '共情建立', l2: '心智化/理解角色心理' }, '7.4': { l1: '共情建立', l2: '同情/道德结盟' },
  '8.1': { l1: '信息管理', l2: '揭示/解惑' }, '8.2': { l1: '信息管理', l2: '好奇' }, '8.3': { l1: '信息管理', l2: '悬念' }, '8.4': { l1: '信息管理', l2: '惊讶' },
  '9.1': { l1: '情境交代', l2: '交代地点/时空' }, '9.2': { l1: '情境交代', l2: '建立场景地理' }, '9.3': { l1: '情境交代', l2: '交代背景/情境信息' },
  '10.1': { l1: '空间表征', l2: '主体—环境关系' }, '10.2': { l1: '空间表征', l2: '渺小/被吞没' }, '10.3': { l1: '空间表征', l2: '规模/体量' }, '10.4': { l1: '空间表征', l2: '人物间空间关系' },
  '11.1': { l1: '构图美学', l2: '平衡/稳定' }, '11.2': { l1: '构图美学', l2: '失衡/视觉张力' }, '11.3': { l1: '构图美学', l2: '形式美/趣味' }, '11.4': { l1: '构图美学', l2: '作者风格/统一性' },
  '12.1': { l1: '主题表意', l2: '视觉隐喻/象征' }, '12.2': { l1: '主题表意', l2: '母题/重复意象' }, '12.3': { l1: '主题表意', l2: '区分/界定叙事段落' },
}

// the full codebook organized by 一级意图 (for the complete design-space browser)
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
    code: '5.1', param: 'pitch', left: '弱势·脆弱', right: '强势·有力',
    read: (d) => clamp((30 - d.angle.pitch) / 60, 0, 1),
    label: (v) => (v < 0.4 ? '俯视·显弱' : v < 0.62 ? '平视·对等' : '仰视·显强'),
    apply: (d, v) => { const pitch = Math.round(lerp(30, -30, v)); return { ...d, angle: { ...d.angle, pitch, level: pitch > 5 ? 'High' : pitch < -5 ? 'Low' : 'Eye' } } },
  },
  '10.2': {
    code: '10.2', param: 'dist', left: '渺小·被吞没', right: '主体·突出',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.3 ? '被空间吞没' : v < 0.6 ? '中性' : '主体突出'),
  },
  '5.3': {
    code: '5.3', param: 'dist', left: '孤立·疏离', right: '亲密·联结',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.35 ? '孤立疏离' : v < 0.6 ? '中性' : '亲密靠近'),
  },
  '7.1': {
    code: '7.1', param: 'dist', left: '保持距离', right: '亲密拉近',
    read: distRead, apply: distApply,
    label: (v) => (v < 0.4 ? '距离感' : v < 0.65 ? '中性' : '拉近'),
  },
  '2.1': {
    code: '2.1', param: 'dof', left: '交代环境', right: '强调主体',
    read: (d) => 1 - (d.focal.dof ?? 0.5),
    label: (v) => (v < 0.4 ? '偏环境' : v < 0.6 ? '平衡' : '聚焦主体'),
    apply: (d, v) => ({ ...d, focal: { ...d.focal, dof: Math.round((1 - v) * 100) / 100 } }),
  },
  '6.1': {
    code: '6.1', param: 'pace', left: '放缓·凝滞', right: '加速·紧迫',
    read: (d) => clamp((8 - d.movement.durationSec) / 7.5, 0, 1),
    label: (v) => (v < 0.4 ? '放缓凝滞' : v < 0.65 ? '中速' : '加速紧迫'),
    apply: (d, v) => ({ ...d, movement: { ...d.movement, durationSec: Math.round((8 - v * 7.5) * 2) / 2 } }),
  },
  '11.1': {
    code: '11.1', param: 'tension', left: '平衡·稳定', right: '失衡·张力',
    read: (d) => clamp((d.color.contrast + 10) / 50, 0, 1),
    label: (v) => (v < 0.4 ? '平衡稳定' : v < 0.6 ? '中性' : '失衡张力'),
    apply: (d, v) => ({ ...d, color: { ...d.color, contrast: Math.round(lerp(-10, 40, v)) } }),
  },
  '3.4': {
    code: '3.4', param: 'warmth', left: '冷峻·孤寂', right: '温暖·亲近',
    read: (d) => d.lighting.temperature ?? 0.5,
    label: (v) => (v < 0.4 ? '偏冷·孤寂' : v < 0.6 ? '中性' : '偏暖·温馨'),
    apply: (d, v) => ({ ...d, lighting: { ...d.lighting, temperature: Math.round(v * 100) / 100 }, color: { ...d.color, look: v < 0.38 ? 'Cool' : v > 0.62 ? 'Warm' : 'Teal & Orange' } }),
  },
}
// 参数 → 为什么能产生该语义/意图(作用机制),按 param 索引。用于"为什么这样拍"推理。
export const AXIS_MECHANISM: Record<string, string> = {
  pitch: '机位高度改变观众的俯仰视角:仰角把主体抬高、显得高大有压迫力;俯角把主体压低、显得弱小脆弱;平视则客观对等。',
  dist: '相机与主体的距离决定主体在画面中的占比:拉远→被环境包围、显得渺小疏离;贴近→充满画面、亲密而强烈。',
  dof: '景深控制清晰范围:浅景深虚化背景、把注意力逼向主体;深景深前后皆清、交代环境信息。',
  pace: '镜头时长与运动速度决定节奏:越短越快越紧迫逼人;时长拉长则凝滞,给情绪沉淀的空间。',
  tension: '反差与构图平衡决定视觉张力:高反差/失衡构图制造不安与张力;低反差/平衡构图带来稳定与克制。',
  warmth: '色温冷暖决定情绪基调:暖色(偏橙黄)亲近温馨;冷色(偏蓝青)疏离孤寂、清冷。',
}

// 某轴当前的"实测参数值"短语(给推理用,显示真实数值而非抽象方向)
export function axisParamPhrase(ax: DimAxis, d: SevenDims): string {
  switch (ax.param) {
    case 'pitch': return `俯仰角 ${d.angle.pitch}°`
    case 'dist': return `相机距主体 ${d.distanceM.toFixed(1)}m · ${d.shotSize}`
    case 'dof': return `景深 ${(d.focal.dof ?? 0.5).toFixed(2)}(0 极浅虚化 … 1 全清)`
    case 'pace': return `镜头时长 ${d.movement.durationSec.toFixed(1)}s`
    case 'tension': return `对比度 ${d.color.contrast >= 0 ? '+' : ''}${d.color.contrast}`
    case 'warmth': {
      const t = d.lighting.temperature ?? 0.5
      return `色温 ${t < 0.4 ? '偏冷' : t > 0.62 ? '偏暖' : '中性'} · 约 ${Math.round(7000 - t * 3800)}K`
    }
    default: return ''
  }
}

// opposite poles / sibling atmospheres of the same bipolar axes → reuse the same control
DIM_AXES['6.2'] = DIM_AXES['6.1']!
DIM_AXES['10.3'] = DIM_AXES['10.2']!
DIM_AXES['11.2'] = DIM_AXES['11.1']!
DIM_AXES['3.5'] = DIM_AXES['3.4']! // 温馨/温暖 = warm pole of the same 冷↔暖 axis
DIM_AXES['3.1'] = DIM_AXES['3.4']! // 压抑(冷) 也用冷暖轴
DIM_AXES['3.3'] = DIM_AXES['3.4']! // 阴郁
