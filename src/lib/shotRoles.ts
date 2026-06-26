// Shot ROLE layer: the story intent stays shared across shots, but each shot carries a different
// narrative function and therefore a different SPATIAL expression (景别/视角/构图/焦点/运动).
// Role only sets the spatial starting point — color/lighting (the intent mood) are left intact.
import type { SevenDims, Shot } from '../api/types'
import { zoneOf, levelOf } from './dims'

// a task-relevant semantic axis projected for a role (references a DesignParam, with role-framed labels)
export interface TaskAxis { param: string; name: string; left: string; right: string }

export interface ShotRole {
  key: string
  name: string
  desc: string
  advance: string // how this shot advances the story (本镜头如何推进故事)
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
    name: '建立处境',
    desc: '让观众看清人物与空间的关系 —— 孤独来自「空间」',
    advance: '先建立空间压力,为下一镜头"靠近人物"保留情绪张力。',
    taskAxes: [
      { param: 'proximity', name: '空间关系', left: '环境包围', right: '人物突出' },
      { param: 'viewpos', name: '观看位置', left: '俯视脆弱', right: '平视陪伴' },
      { param: 'attention', name: '叙事注意', left: '空间处境', right: '人物内心' },
    ],
    apply: (d) => spatial(d, { dist: 20, pitch: 16, mm: 24, dof: 0.8, fx: 0.3, fy: 0.42, move: 'Static', dur: 4 }),
  },
  {
    key: 'advance',
    name: '推进感受',
    desc: '让观众从"旁观"转为"进入人物情绪"。',
    advance: '把观众从旁观带入人物内心,为下一镜头落到情绪细节蓄力。',
    taskAxes: [
      { param: 'proximity', name: '观众与人物的关系', left: '旁观疏离', right: '靠近亲密' },
      { param: 'attention', name: '叙事关注点', left: '空间处境', right: '人物内心' },
      { param: 'readability', name: '人物的可感性', left: '难以辨认', right: '情绪可读' },
    ],
    apply: (d) => spatial(d, { dist: 5, pitch: 0, mm: 50, dof: 0.28, fx: 0.5, fy: 0.5, move: 'Dolly In', dur: 4 }),
  },
  {
    key: 'detail',
    name: '情绪落点',
    desc: '落到手部/眼神/局部,情绪内化未爆发 —— 孤独来自「情绪细节」',
    advance: '让情绪沉到细节里、不爆发,为整段收束留下余味。',
    taskAxes: [
      { param: 'proximity', name: '局部细节', left: '整体环境', right: '局部细节' },
      { param: 'tension', name: '情绪张力', left: '平静克制', right: '紧张失衡' },
      { param: 'warmth', name: '光色情绪', left: '冷峻保留', right: '温暖靠近' },
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
  const sz = d.distanceM > 14 ? '远景' : d.distanceM > 6 ? '中景' : d.distanceM > 3 ? '中近' : '特写'
  const v = d.angle.pitch > 8 ? '高位' : d.angle.pitch < -8 ? '低位' : Math.abs(((d.angle.yaw % 360) + 360) % 360 - 180) < 60 ? '侧后' : '平视'
  const f = d.focal.dof > 0.6 ? '环境' : d.focal.dof < 0.35 ? '局部' : '人物'
  return { size: sz, view: v, focus: f }
}

// compare adjacent shots; if too many key dims coincide → a "shots too similar" warning
export function similarityWarnings(shots: Shot[]): { i: number; j: number; shared: string[] }[] {
  const out: { i: number; j: number; shared: string[] }[] = []
  for (let i = 0; i < shots.length - 1; i++) {
    const a = shotAspect(shots[i]!.dims), b = shotAspect(shots[i + 1]!.dims)
    const shared: string[] = []
    if (a.size === b.size) shared.push('景别')
    if (a.view === b.view) shared.push('视角')
    if (a.focus === b.focus) shared.push('关注')
    if (shared.length >= 2) out.push({ i, j: i + 1, shared })
  }
  return out
}
