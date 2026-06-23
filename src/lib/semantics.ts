// Reverse mapping: cinematic PARAMETERS → INTENT / meaning.
// The editor is a semantic editor — every number is annotated with what it expresses.
import type { SevenDims, ShotSize } from '../api/types'

const SHOT: Record<ShotSize, string> = {
  'Extreme Wide': '孤寂 · 渺小',
  Wide: '疏离 · 客观',
  Medium: '平实 · 叙事',
  'Medium Close-Up': '靠近 · 关注',
  'Close-Up': '亲密 · 情绪',
  'Extreme Close-Up': '紧张 · 强烈',
}
export const shotSizeMeaning = (d: SevenDims): string => SHOT[d.shotSize] ?? '叙事'

// pitch>0 = camera high, looking down → subject small;  pitch<0 = low, looking up → subject powerful
export const angleMeaning = (pitch: number): string =>
  pitch < -5 ? '仰视 · 权力 高大' : pitch > 5 ? '俯视 · 渺小 脆弱' : '平视 · 客观 平等'

export const orbitMeaning = (yaw: number): string => {
  const a = Math.abs(((yaw % 360) + 360) % 360)
  const aa = a > 180 ? 360 - a : a
  if (aa < 30) return '正面 · 直面 对峙'
  if (aa < 110) return '侧面 · 旁观 疏离'
  return '背向 · 反观 跟随'
}

export const dofMeaning = (dof: number): string =>
  dof < 0.4 ? '浅景深 · 聚焦 情绪隔离' : dof > 0.6 ? '深景深 · 交代环境 客观' : '中景深 · 平衡'

export const focalMeaning = (mm: number): string =>
  mm <= 28 ? '广角 · 张力 夸张纵深' : mm >= 70 ? '长焦 · 压缩 凝视疏离' : '标准 · 自然真实'

export const moveMeaning = (type: string): string => {
  switch (type) {
    case 'Dolly In': return '推进 · 逼近 介入情绪'
    case 'Dolly Out': return '拉远 · 抽离 走向孤寂'
    case 'Pan': return '横摇 · 环视 揭示'
    case 'Truck': return '平移 · 伴随'
    case 'Follow': return '跟随 · 代入'
    case 'Crane': return '升降 · 抒情 宏大'
    default: return '固定 · 凝滞 客观'
  }
}

export const lookMeaning = (look: string): string => {
  const l = (look || '').toLowerCase()
  if (l.includes('warm')) return '暖调 · 温暖 欢快'
  if (l.includes('teal')) return '青橙 · 张力 戏剧'
  if (l.includes('film')) return '胶片 · 怀旧 质感'
  return '冷调 · 疏离 忧郁'
}
export const colorMeaning = (d: SevenDims): string => lookMeaning(d.color?.look || '')

export const timeMeaning = (sec: number): string =>
  sec <= 2 ? '急促 · 紧张 凌厉' : sec >= 6 ? '舒缓 · 沉思 凝滞' : '平稳 · 自然叙事'

export const lightMeaning = (l: SevenDims['lighting']): string => {
  const key = l.keyPct ?? 60
  const warm = l.temperature ?? 0.5
  const tone = key < 40 ? '低调 · 压抑神秘' : key > 75 ? '高调 · 明快通透' : '中性光 · 平实'
  return tone + (warm > 0.66 ? ' 暖' : warm < 0.34 ? ' 冷' : '')
}

export const compMeaning = (c: SevenDims['composition']): string => {
  const fx = c.focus?.x ?? 0.5
  return Math.abs(fx - 0.5) < 0.12 ? '居中 · 稳定 对称' : '偏置 · 留白 张力'
}
