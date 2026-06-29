// Map a backend ShotScript (free-text cinematic dimensions, often Chinese) into the
// intent-to-cinema Plan/Shot model (numeric SevenDims) so the editor + ShotStrip can drive it.
import type { Plan, Shot, SevenDims, MoveType, ShotSize } from '../api/types'
import type { ShotScript, SchemeShot, PatchOp } from '../api/backend'
import { zoneOf, levelOf } from './dims'
import { defaultRoleKey } from './shotRoles'

// Chinese cinematic-semantic phrases kept on purpose for the (Chinese) Dreamina image model in dimsToPatch.
const moveCN = (type: string): string => ({ 'Dolly In': '推进·逼近', 'Dolly Out': '拉远·抽离', Pan: '横摇·环视', Truck: '平移·伴随', Follow: '跟随·代入', Crane: '升降·宏大' } as Record<string, string>)[type] ?? '固定·凝滞'
const timeCN = (sec: number): string => (sec <= 2 ? '急促·紧张' : sec >= 6 ? '舒缓·凝滞' : '平稳·叙事')

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
  if (has(t, '大远', '远景', 'extreme wide', 'very wide')) return 34
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
// 色温 0冷..1暖(色调描述里常含冷暖)
function tempFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '暖', 'warm', '金', '橙', '黄', '日落', '烛')) return 0.75
  if (has(t, '冷', 'cool', '蓝', '青', '月', '日光灯')) return 0.25
  return 0.5
}
function contrastFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '高对比', '强对比', '反差大', 'high contrast', 'contrasty')) return 30
  if (has(t, '低对比', '低反差', '平淡', '柔和', 'low contrast', 'flat')) return -25
  return 0
}
function satFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '高饱和', '浓烈', '艳', '饱满', 'saturated', 'vivid')) return 30
  if (has(t, '低饱和', '克制', '淡', '褪色', '去色', 'desaturat', 'muted')) return -25
  return 0
}
function tintFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '品红', '洋红', '紫', 'magenta')) return 20
  if (has(t, '偏绿', '绿', 'green')) return -20
  return 0
}
// 主光强度(明暗): 28低调 / 60中性 / 82高调
function keyFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '低调', '暗', '压抑', '幽暗', 'low key', 'low-key', 'dark')) return 28
  if (has(t, '高调', '明亮', '通透', '亮', 'high key', 'high-key', 'bright')) return 82
  return 60
}
// 软硬 0硬..1柔
function softFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '硬光', '硬', '锐利', 'hard')) return 0.2
  if (has(t, '柔光', '柔', '漫射', '柔和', 'soft', 'diffus')) return 0.8
  return 0.5
}
// 扩散 0聚光..1泛光
function spreadFromText(s: string): number {
  const t = s.toLowerCase()
  if (has(t, '聚光', '点光', '束', 'spot')) return 0.2
  if (has(t, '泛光', '环境光', '漫天', 'flood', 'ambient')) return 0.8
  return 0.4
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
  // 色调:不止 look,把对比/饱和/色调(品红绿)与色温也从方案文本里同步进来,
  // 否则其余值停在 baseDims 默认,改别的参数重渲染时会把 LLM 的色调覆盖成中性默认。
  const tone = sh.color_tone || ''
  d.color.look = lookFromTone(tone)
  d.color.contrast = contrastFromText(tone)
  d.color.saturation = satFromText(tone)
  d.color.tint = tintFromText(tone)
  // 光照:强度/软硬/扩散从 lighting 文本解析;色温综合色调+光照描述(冷暖)
  const light = sh.lighting || ''
  d.lighting.keyPct = keyFromText(light)
  d.lighting.softness = softFromText(light)
  d.lighting.spread = spreadFromText(light)
  d.lighting.temperature = tempFromText(`${tone} ${light}`)
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
      role: defaultRoleKey(i), // narrative function per shot position
      serves: sh.serves ?? [], // v3 design-space dims this shot serves
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
    label: d.shotSize,
    prompt: `${d.shotSize} · ${d.angle.pitch}° · ${Math.round(d.focal.mm)}mm · DoF ${d.focal.dof.toFixed(2)} · ${d.color.look} · ${d.movement.type} · ${d.movement.durationSec.toFixed(1)}s`,
  }
}

// ---- fine-grained reverse mapping: continuous SevenDims → precise cinematic text (with numbers) ----
const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22]
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`)

function orbitPhrase(yaw: number): string {
  const aa = ((((yaw % 360) + 360) % 360) + 180) % 360 - 180 // −180..180
  const m = Math.abs(aa), lr = aa >= 0 ? '右' : '左'
  const pos = m < 12 ? '正面' : m < 60 ? `${lr}前方斜侧` : m < 120 ? `${lr}正侧(90°)` : m < 168 ? `${lr}后方` : '正背面(反打视角)'
  return `水平机位${pos}(orbit ${Math.round(aa)}°)`
}
function pitchPhrase(pitch: number): string {
  const m = Math.abs(pitch), deg = m < 5 ? '' : m < 20 ? '轻微' : m < 45 ? '中等' : '大角度'
  const dir = pitch < -4 ? '仰拍·低角度(主体高大/权力)' : pitch > 4 ? '俯拍·高角度(主体渺小/脆弱)' : '平视·客观平等'
  return `垂直角度${deg}${dir}(tilt ${pitch}°)`
}
// 每档景别的视觉化取景描述 — 图像模型靠这个真正改取景,而非抽象的"占画面 X%"
const SIZE_VISUAL: Record<ShotSize, string> = {
  'Extreme Close-Up': '面部局部大特写:眼睛/嘴等五官局部充满整个画面,只见皮肤纹理,背景完全虚化为光斑',
  'Close-Up': '面部特写:整张脸占据画面主体、肩部以上入画,背景明显虚化',
  'Medium Close-Up': '中近景:胸部以上入画,人物占画面大半,少量近景环境可见',
  'Medium': '中景:腰部以上入画,人物与周边环境兼顾',
  'Wide': '全景:人物全身可见,环境占据画面主要面积',
  'Extreme Wide': '大远景:人物在画面中很小,大量环境与空间主导画面',
}
function shotPhrase(d: SevenDims): string {
  const cn = SIZE_CN[d.shotSize] ?? d.shotSize
  const eff = d.distanceM / (d.composition.zoom ?? 1)
  const frac = Math.round(clamp(2.4 / eff, 0.05, 1.7) * 100)
  const v = SIZE_VISUAL[d.shotSize as ShotSize]
  const meta = `相机距主体约${d.distanceM.toFixed(1)}m,主体约占画面高${frac}%`
  return v ? `${cn}——${v}(${meta})` : `${cn}(${meta})`
}
function focalPhrase(mm: number): string {
  const ch = mm <= 24 ? '超广角·强透视纵深' : mm < 35 ? '广角·纵深感强' : mm <= 50 ? '标准·近人眼' : mm <= 85 ? '中长焦·轻压缩(人像)' : '长焦·强空间压缩'
  return `${Math.round(mm)}mm(${ch})`
}
function dofPhrase(dof: number): string {
  const f = F_STOPS[clamp(Math.round(dof * 8), 0, 8)]
  const ch = dof < 0.34 ? '背景强虚化·主体剥离' : dof > 0.66 ? '前后全清·交代环境' : '适度虚化'
  return `约 f/${f}(${ch})`
}
function compPhrase(c: SevenDims['composition']): string {
  const fx = c.focus?.x ?? 0.5, fy = c.focus?.y ?? 0.5
  const hx = fx < 0.4 ? '左三分' : fx > 0.6 ? '右三分' : '横向居中'
  const vy = fy < 0.4 ? '偏上' : fy > 0.6 ? '偏下' : '纵向居中'
  return `主体${hx}·${vy}(横${Math.round(fx * 100)}%/纵${Math.round(fy * 100)}%,上留白${Math.round(fy * 100)}%,前留白${Math.round((1 - fx) * 100)}%)`
}
function lightPhrase(l: SevenDims['lighting']): string {
  const key = l.keyPct ?? 60
  const tone = key < 35 ? '低调(暗部为主·压抑神秘)' : key > 75 ? '高调(明亮通透)' : '中性调'
  const warm = l.temperature ?? 0.5
  const kelvin = Math.round(7000 - warm * 3800)
  const ct = warm < 0.34 ? `冷色温~${kelvin}K` : warm > 0.66 ? `暖色温~${kelvin}K` : `中性~${kelvin}K`
  const soft = l.softness ?? 0.5
  const sf = soft < 0.34 ? '硬光(影硬·戏剧)' : soft > 0.66 ? '柔光(过渡柔和)' : '中等柔度'
  const spread = l.spread ?? 0.4
  const sp = spread < 0.34 ? '聚光' : spread > 0.66 ? '泛光' : '中扩散'
  const pos = l.pos ?? { x: 0.5, y: 0.18 }
  const dir = `${pos.y < 0.34 ? '高位' : pos.y > 0.66 ? '低位' : '平位'}${pos.x < 0.4 ? '左侧' : pos.x > 0.6 ? '右侧' : '正'}`
  return `${tone}·${ct}·${sf}·${sp}·主光${dir}(强度${key}%)`
}
// look → 可执行的视觉调色动作(给即梦的明确颜色指令,而非英文枚举名/心理义)
function lookVisual(look: string): string {
  const l = (look || '').toLowerCase()
  if (l.includes('warm')) return '整体暖色调:画面偏暖金/橙黄,白平衡偏暖,提亮暖色、压低冷蓝'
  if (l.includes('teal')) return '青橙分离调:暗部与背景偏冷青,肤色/高光偏暖橙,冷暖对撞'
  if (l.includes('film')) return '胶片调:轻微褪色、暖灰、低饱和,暗部带青、高光偏暖'
  return '整体冷色调:画面偏冷蓝/青,白平衡偏冷,压低暖黄、增强冷蓝,呈现疏离清冷气氛'
}
function colorPhrase(d: SevenDims): string {
  const c = d.color.contrast, s = d.color.saturation
  const ct = c < -15 ? '低对比·平淡柔和' : c > 15 ? '高对比·强烈戏剧' : '中对比'
  const st = s < -15 ? '低饱和·冷静克制' : s > 15 ? '高饱和·浓烈情绪' : '中饱和'
  // 色温冷暖纳入调色主句(原来只在光照里,易被忽略);明确开尔文方向
  const warm = d.lighting?.temperature ?? 0.5
  const kelvin = Math.round(7000 - warm * 3800)
  const ctemp = warm < 0.4 ? `偏冷~${kelvin}K` : warm > 0.6 ? `偏暖~${kelvin}K` : `中性~${kelvin}K`
  return `${lookVisual(d.color.look)};整体色温${ctemp};${ct}(${signed(c)})、${st}(${signed(s)})。务必真实改变画面整体色调倾向,不要沿用原图色彩`
}
function rhythmPhrase(curve: { x: number; y: number }[] | undefined): string {
  const ys = (curve ?? []).map((p) => p.y)
  if (ys.length < 2) return '匀速·平稳'
  const first = ys[0]!, last = ys[ys.length - 1]!, max = Math.max(...ys), maxi = ys.indexOf(max)
  if (last - first > 0.15) return '渐快·加速推向高潮'
  if (first - last > 0.15) return '渐慢·减速趋于沉静'
  if (maxi > 0 && maxi < ys.length - 1 && max - Math.min(first, last) > 0.15) return '中段加速·两端舒缓'
  return '匀速·平稳'
}

// full-coverage reverse map: every edited dim → a precise text patch op (+ a comprehensive frame_edit_hint
// covering all VISUAL dims, which is what 即梦 image2image actually reads for the keyframe).
// Concise, instruction-style edit prompt for the (Chinese, instruction-edit) Dreamina image2image.
// Lesson (verified): long parametric prompts (78mm / orbit 0° / 占画面170% / 5860K …) drown the core
// edit and Dreamina keeps the original framing. A short natural-language edit ("改成大特写、浅景深、冷调")
// changes framing reliably with the same subject — so distill dims into the few meaningful changes in
// plain cinematic terms, no raw numbers.
function conciseHint(d: SevenDims): string {
  const parts: string[] = []
  const sz = d.shotSize
  parts.push(
    sz === 'Extreme Close-Up' ? '改成大特写，紧紧聚焦画面主体的面部（五官占据画面）'
    : sz === 'Close-Up' ? '改成特写，主体面部、肩部以上入画'
    : sz === 'Medium Close-Up' ? '改成中近景，主体胸部以上入画'
    : sz === 'Medium' ? '改成中景，主体腰部以上入画'
    : sz === 'Wide' ? '改成全景，主体全身入画、环境占主要画面'
    : sz === 'Extreme Wide' ? '改成大远景，主体在画面中很小、环境主导画面'
    : `改成${SIZE_CN[sz] ?? sz}`,
  )
  if (d.focal.dof < 0.34) parts.push('浅景深、背景明显虚化')
  else if (d.focal.dof > 0.66) parts.push('深景深、前后都清晰')
  // 垂直角度(俯仰):分级 + 明确镜头语言
  const p = d.angle.pitch
  if (p <= -22) parts.push('低角度仰拍、镜头明显朝上，强化主体的高大与压迫感')
  else if (p <= -7) parts.push('低角度仰拍')
  else if (p < -3) parts.push('略微仰视')
  else if (p >= 22) parts.push('高角度俯拍、镜头明显朝下，让主体显得渺小')
  else if (p >= 7) parts.push('高角度俯拍')
  else if (p > 3) parts.push('略微俯视')
  // 水平机位(环绕)
  const a = Math.abs(((d.angle.yaw % 360) + 360) % 360); const aa = a > 180 ? 360 - a : a
  if (aa >= 150) parts.push('从主体正后方拍摄')
  else if (aa >= 110) parts.push('侧后方过肩角度')
  else if (aa >= 65) parts.push('从正侧面拍摄（侧脸）')
  else if (aa >= 25) parts.push('斜侧角度（侧前方约 45°）')
  // 构图:主体位置 + 留白 + 三分/失衡(此前完全缺失,是构图不生效的主因)
  const fx = d.composition.focus?.x ?? 0.5, fy = d.composition.focus?.y ?? 0.5
  const thirds = d.composition.rule === 'thirds'
  const comp: string[] = []
  if (fx < 0.4) comp.push(`主体${thirds ? '按三分法' : ''}置于画面左侧、右侧大量留白`)
  else if (fx > 0.6) comp.push(`主体${thirds ? '按三分法' : ''}置于画面右侧、左侧大量留白`)
  else comp.push('主体居中构图')
  if (fy < 0.4) comp.push('主体位置偏上')
  else if (fy > 0.62) comp.push('主体位置偏下、上方留白')
  if (Math.abs(d.composition.balance ?? 0) > 0.3) comp.push('刻意失衡构图、营造视觉张力')
  parts.push(comp.join('、'))
  const look = (d.color.look || '').toLowerCase()
  if (look.includes('warm')) parts.push('整体暖色调（画面偏暖橙、白平衡偏暖）')
  else if (look.includes('teal')) parts.push('青橙色调（暗部冷青、肤色暖橙的冷暖对比）')
  else if (look.includes('film')) parts.push('胶片质感色调（轻微褪色、暖灰）')
  else if (look.includes('cool')) parts.push('整体冷色调（画面偏冷蓝青、压低暖黄、降低肤色暖度）')
  if (d.color.contrast > 18) parts.push('高对比、明暗反差强')
  else if (d.color.contrast < -18) parts.push('低对比、柔和')
  // 把"整体色调影调"明确划入【要改变】项,与【要保持】的人物/场景物体分开 —— 否则即梦会把
  // "保持场景不变"连色彩一起保留,导致调色不生效、镜头间影调不统一。
  return parts.join('，') +
    '。请保持画面中的人物与场景物体本身不变（同一个人、同样相貌与服装、同一空间布置），' +
    '但要真实改变取景、景别、镜头语言，以及【整体色调影调】——上述色调要统一覆盖整个画面（包括人物肤色与背景），不要沿用原图的色彩倾向。'
}

export function dimsToPatch(d: SevenDims, order: number): PatchOp[] {
  const p = (field: string, value: string): PatchOp => ({ shot_order: order, field, value })
  const hint = conciseHint(d)
  return [
    p('shot_size', shotPhrase(d)),
    p('angle', `${orbitPhrase(d.angle.yaw)};${pitchPhrase(d.angle.pitch)}`), // 水平 + 垂直机位(十维无独立水平字段)
    p('composition', compPhrase(d.composition)),
    p('movement', `${d.movement.type}(${moveCN(d.movement.type)})`),
    p('focal_length', focalPhrase(d.focal.mm)),
    p('depth_of_field', dofPhrase(d.focal.dof)),
    p('lighting', lightPhrase(d.lighting)),
    p('color_tone', colorPhrase(d)),
    p('rhythm', `${d.movement.durationSec.toFixed(1)}s · ${rhythmPhrase(d.rhythm?.curve)}`),
    p('duration', `${d.movement.durationSec.toFixed(1)}s(${timeCN(d.movement.durationSec)})`),
    p('frame_edit_hint', hint),
  ]
}
