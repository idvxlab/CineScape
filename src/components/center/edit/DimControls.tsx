import { useRef, useState } from 'react'
import type { SevenDims, MoveType, ShotSize } from '../../../api/types'
import { ANCHOR_CELLS, nearestCell, COMP_PRESETS, headroomOf, leadRoomOf, deriveMoveEnd } from '../../../lib/dims'
import { shotSizeMeaning, angleMeaning, dofMeaning, focalMeaning, moveMeaning, colorMeaning, lightMeaning, compMeaning, timeMeaning } from '../../../lib/semantics'

interface Props {
  dims: SevenDims
  compMode?: boolean
  moveMode?: boolean
  lightMode?: boolean
  onToggleComp?: () => void
  onToggleMove?: () => void
  onToggleLight?: () => void
  onChange(p: Partial<SevenDims>): void
  onCommit(): void
}

type DimId = 'shot' | 'dof' | 'angle' | 'comp' | 'move' | 'rhythm' | 'time' | 'light' | 'color'

const LOOKS = ['Cool', 'Teal & Orange', 'Warm', 'Film Emulation']
const MOVES: MoveType[] = ['Static', 'Dolly In', 'Dolly Out', 'Pan', 'Truck', 'Crane', 'Custom']
// Shot size → representative distance (falls within that shot size's distance range, drives distanceM)
const SHOT_SIZES: ShotSize[] = ['Extreme Wide', 'Wide', 'Medium', 'Medium Close-Up', 'Close-Up', 'Extreme Close-Up']
const SIZE_DIST: Record<ShotSize, number> = { 'Extreme Wide': 24, Wide: 15, Medium: 8, 'Medium Close-Up': 5, 'Close-Up': 3, 'Extreme Close-Up': 1.5 }

const pill = (active: boolean) =>
  `rounded-lg px-2.5 py-1 text-[12px] transition ${active
    ? 'bg-brand text-white shadow-sm'
    : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/80 border border-slate-200/70'}`

export function DimControls({ dims, compMode = false, moveMode = false, lightMode = false, onToggleComp, onToggleMove, onToggleLight, onChange, onCommit }: Props) {
  const [open, setOpen] = useState<DimId | null>(null)
  const comp = dims.composition
  const activeCell = nearestCell(comp.focus)
  const setComp = (p: Partial<SevenDims['composition']>) =>
    onChange({ composition: { ...comp, preset: undefined, ...p } })
  const setFocus = (x: number, y: number) =>
    setComp({ focus: { x, y }, headroom: headroomOf({ x, y }), leadRoom: leadRoomOf({ x, y }) })

  const dofTxt = dims.focal.dof < 0.4 ? 'Shallow' : dims.focal.dof > 0.6 ? 'Deep' : 'Mid'
  const soft = dims.lighting.softness ?? 0.5
  const warm = dims.lighting.temperature ?? 0.5
  const softTxt = soft < 0.34 ? 'Hard' : soft > 0.66 ? 'Soft' : 'Medium'
  const warmTxt = warm < 0.34 ? 'Cool' : warm > 0.66 ? 'Warm' : 'Neutral'
  const spread = dims.lighting.spread ?? 0.4
  const spreadTxt = spread < 0.34 ? 'Spot' : spread > 0.66 ? 'Flood' : 'Medium'
  const compVal = comp.preset ? COMP_PRESETS.find((p) => p.id === comp.preset)?.label ?? 'Custom' : 'Custom'
  const setRhythm = (curve: { x: number; y: number }[]) => onChange({ rhythm: { curve } })

  const chips: { id: DimId; icon: string; label: string; value: string; meaning?: string }[] = [
    { id: 'shot', icon: '⬚', label: 'Shot Size', value: dims.shotSize, meaning: shotSizeMeaning(dims) },
    { id: 'comp', icon: '⊞', label: 'Composition', value: compMode ? 'Editing…' : compVal, meaning: compMeaning(comp) },
    { id: 'angle', icon: '⤡', label: 'Vertical Angle', value: `${dims.angle.pitch}°`, meaning: angleMeaning(dims.angle.pitch) },
    { id: 'dof', icon: '◐', label: 'Focal · DoF', value: `${Math.round(dims.focal.mm)}mm · ${dofTxt}`, meaning: focalMeaning(dims.focal.mm) },
    { id: 'move', icon: '⇄', label: 'Camera Movement', value: moveMode ? 'Editing…' : dims.movement.type, meaning: moveMeaning(dims.movement.type) },
    { id: 'rhythm', icon: '∿', label: 'Rhythm', value: 'Speed curve' },
    { id: 'time', icon: '⏱', label: 'Time', value: `${dims.movement.durationSec.toFixed(1)}s` },
    { id: 'light', icon: '☀', label: 'Lighting', value: lightMode ? 'Editing…' : `${dims.lighting.keyPct}% · ${warmTxt}`, meaning: lightMeaning(dims.lighting) },
    { id: 'color', icon: '◑', label: 'Color Grade', value: dims.color.look, meaning: colorMeaning(dims) },
  ]

  const toggle = (id: DimId) => setOpen((o) => (o === id ? null : id))

  return (
    <div className="absolute bottom-3 right-3 top-3 z-10 flex items-start gap-2">
      {/* Popover for a single control (to the left of the dock) */}
      {open && (
        <div className="max-h-full w-[210px] space-y-2 overflow-y-auto rounded-2xl border border-white/70 bg-white/80 p-3 text-[12px] text-slate-700 shadow-xl backdrop-blur-md">
          {open === 'dof' && (
            <Group label="Lens">
              <Labeled label={`Focal Length · ${Math.round(dims.focal.mm)}mm`}>
                <div className="mb-1 text-[11px] font-semibold text-brand">{focalMeaning(dims.focal.mm)}</div>
                <Range min={16} max={135} step={1} value={dims.focal.mm}
                  onChange={(v) => onChange({ focal: { ...dims.focal, mm: v }, composition: { ...dims.composition, zoom: clampN(Math.round((v / 35) * 100) / 100, 0.5, 4) } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Wide · tension</span><span>Tele · gaze</span></div>
              </Labeled>
              <Labeled label={`Depth of Field · ${dofTxt}`}>
                <div className="mb-1 text-[11px] font-semibold text-brand">{dofMeaning(dims.focal.dof)}</div>
                <Range min={0} max={1} step={0.05} value={dims.focal.dof}
                  onChange={(v) => onChange({ focal: { ...dims.focal, dof: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Shallow · emotion</span><span>Deep · context</span></div>
              </Labeled>
            </Group>
          )}

          {open === 'angle' && (
            <Group label={`Vertical Angle ${dims.angle.pitch}°`}>
              <div className="mb-1 text-[12px] font-semibold text-brand">{angleMeaning(dims.angle.pitch)}</div>
              <Range min={-90} max={90} step={1} value={dims.angle.pitch}
                onChange={(v) => onChange({ angle: { ...dims.angle, pitch: v } })} onCommit={onCommit} />
              <div className="flex justify-between text-[10px] text-slate-400">
                <span>Low · power</span><span>Eye · objective</span><span>High · small</span>
              </div>
            </Group>
          )}

          {open === 'shot' && (
            <Group label="Shot Size">
              <div className="text-[12px] font-semibold text-brand">{shotSizeMeaning(dims)}</div>
              <div className="flex flex-wrap gap-1.5">
                {SHOT_SIZES.map((s) => (
                  <button key={s} onClick={() => { onChange({ distanceM: SIZE_DIST[s] }); onCommit() }}
                    className={pill(dims.shotSize === s)}>{s}</button>
                ))}
              </div>
              <div className="text-[10px] text-slate-400">Far → solitary · small, near → intimate · emotional; set by camera distance</div>
            </Group>
          )}

          {open === 'move' && (
            <Group label="Camera Movement">
              <div className="text-[12px] font-semibold text-brand">{moveMeaning(dims.movement.type)}</div>
              <div className="flex flex-wrap gap-1.5">
                {MOVES.map((m) => (
                  <button key={m} onClick={() => {
                    if (m === 'Custom') {
                      onChange({ movement: { ...dims.movement, type: 'Custom' } })
                    } else {
                      // Preset: seed keyframes from the current camera pose so it's editable on the canvas too
                      const start = { yaw: dims.angle.yaw, dist: dims.distanceM, pitch: dims.angle.pitch }
                      const end = deriveMoveEnd(m, start)
                      onChange({ movement: { ...dims.movement, type: m, start, end, endAuto: true, path: end ? [start, end] : [start] } })
                    }
                    onCommit()
                  }}
                    className={pill(dims.movement.type === m)}>{m}</button>
                ))}
              </div>
              {dims.movement.type !== 'Static' && (
                <button onClick={onToggleMove}
                  className={`w-full rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${moveMode
                    ? 'bg-brand text-white' : 'bg-brand/10 text-brand hover:bg-brand/20'}`}>
                  {moveMode ? '✓ Editing keyframes on the canvas · click to exit' : 'Edit keyframes on the canvas ▸'}
                </button>
              )}
            </Group>
          )}

          {open === 'rhythm' && (
            <Group label="Rhythm · Speed Curve">
              <CurveEditor curve={dims.rhythm.curve} onChange={setRhythm} onCommit={onCommit} />
              <div className="text-[10px] text-slate-400">Y axis = speed · X axis = time; drag control points to shape pacing</div>
            </Group>
          )}

          {open === 'time' && (
            <Group label={`Time · ${dims.movement.durationSec.toFixed(1)}s`}>
              <div className="mb-1 text-[12px] font-semibold text-brand">{timeMeaning(dims.movement.durationSec)}</div>
              <Range min={0.5} max={12} step={0.5} value={dims.movement.durationSec}
                onChange={(v) => onChange({ movement: { ...dims.movement, durationSec: v } })} onCommit={onCommit} />
              <div className="flex justify-between text-[10px] text-slate-400"><span>Rapid · tense</span><span>Slow · reflective</span></div>
            </Group>
          )}

          {open === 'light' && (
            <Group label="Lighting">
              <button onClick={onToggleLight}
                className={`w-full rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${lightMode
                  ? 'bg-brand text-white' : 'bg-brand/10 text-brand hover:bg-brand/20'}`}>
                {lightMode ? '✓ Placing light on the canvas · click to exit' : 'Place light on the canvas ▸'}
              </button>
              <div className="text-[12px] font-semibold text-brand">{lightMeaning(dims.lighting)}</div>
              <Labeled label={`Intensity ${dims.lighting.keyPct}%`}>
                <Range min={0} max={100} step={1} value={dims.lighting.keyPct}
                  onChange={(v) => onChange({ lighting: { ...dims.lighting, keyPct: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Low key · oppressive</span><span>High key · clear</span></div>
              </Labeled>
              <Labeled label={`Beam · ${spreadTxt}`}>
                <Range min={0} max={1} step={0.05} value={spread}
                  onChange={(v) => onChange({ lighting: { ...dims.lighting, spread: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Spot · dramatic</span><span>Flood · everyday</span></div>
              </Labeled>
              <Labeled label={`Softness · ${softTxt}`}>
                <Range min={0} max={1} step={0.05} value={soft}
                  onChange={(v) => onChange({ lighting: { ...dims.lighting, softness: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Hard · sharp</span><span>Soft · gentle</span></div>
              </Labeled>
              <Labeled label={`Warmth · ${warmTxt}`}>
                <Range min={0} max={1} step={0.05} value={warm}
                  onChange={(v) => onChange({ lighting: { ...dims.lighting, temperature: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Cool · detached</span><span>Warm · cheerful</span></div>
              </Labeled>
            </Group>
          )}

          {open === 'color' && (
            <Group label="Color Grade">
              <div className="text-[12px] font-semibold text-brand">{colorMeaning(dims)}</div>
              <div className="flex flex-wrap gap-1.5">
                {LOOKS.map((l) => (
                  <button key={l} onClick={() => { onChange({ color: { ...dims.color, look: l } }); onCommit() }}
                    className={pill(dims.color.look === l)}>{l}</button>
                ))}
              </div>
              <Labeled label={`Color Temp / WB · ${warmTxt}`}>
                <Range min={0} max={1} step={0.05} value={dims.lighting.temperature ?? 0.5}
                  onChange={(v) => onChange({ lighting: { ...dims.lighting, temperature: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Cool · blue</span><span>Warm · orange</span></div>
              </Labeled>
              <Labeled label={`Hue / Tint ${signed(dims.color.tint ?? 0)}`}>
                <Range min={-50} max={50} step={1} value={dims.color.tint ?? 0}
                  onChange={(v) => onChange({ color: { ...dims.color, tint: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Green</span><span>Magenta</span></div>
              </Labeled>
              <Labeled label={`Contrast ${signed(dims.color.contrast)}`}>
                <Range min={-50} max={50} step={1} value={dims.color.contrast}
                  onChange={(v) => onChange({ color: { ...dims.color, contrast: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Flat · soft</span><span>Strong · dramatic</span></div>
              </Labeled>
              <Labeled label={`Saturation ${signed(dims.color.saturation)}`}>
                <Range min={-50} max={50} step={1} value={dims.color.saturation}
                  onChange={(v) => onChange({ color: { ...dims.color, saturation: v } })} onCommit={onCommit} />
                <div className="flex justify-between text-[10px] text-slate-400"><span>Low sat · restrained</span><span>High sat · intense</span></div>
              </Labeled>
            </Group>
          )}

          {open === 'comp' && (
            <Group label="Composition">
              <div className="text-[12px] font-semibold text-brand">{compMeaning(comp)}</div>
              <button onClick={onToggleComp}
                className={`w-full rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${compMode
                  ? 'bg-brand text-white' : 'bg-brand/10 text-brand hover:bg-brand/20'}`}>
                {compMode ? '✓ Editing on the canvas · click to exit' : 'Drag the focus on the canvas ▸'}
              </button>
              <div className="flex gap-2.5">
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400">Subject Anchor</div>
                  <div className="grid grid-cols-3 gap-[3px]">
                    {ANCHOR_CELLS.map((cell, i) => (
                      <button key={i} title="Focus position"
                        onClick={() => { setFocus(cell.x, cell.y); onCommit() }}
                        className={`grid h-[18px] w-[18px] place-items-center rounded-[4px] border transition ${i === activeCell
                          ? 'border-brand bg-brand/15' : 'border-slate-200 bg-white/70 hover:bg-slate-100'}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${i === activeCell ? 'bg-brand' : 'bg-slate-300'}`} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Labeled label={`Headroom ${Math.round(comp.focus.y * 100)}%`}>
                    <Range min={0.05} max={0.6} step={0.01} value={comp.focus.y}
                      onChange={(v) => setFocus(comp.focus.x, v)} onCommit={onCommit} />
                  </Labeled>
                  <Labeled label={`Lead Room ${Math.round((1 - comp.focus.x) * 100)}%`}>
                    <Range min={0.1} max={0.7} step={0.01} value={1 - comp.focus.x}
                      onChange={(v) => setFocus(1 - v, comp.focus.y)} onCommit={onCommit} />
                  </Labeled>
                </div>
              </div>
            </Group>
          )}
        </div>
      )}

      {/* dock: compact chip column on the right; clicking a chip opens its popover */}
      <div className="flex max-h-full flex-col gap-1.5 overflow-y-auto pr-0.5">
        {chips.map((c) => {
          const active = open === c.id || (c.id === 'comp' && compMode) || (c.id === 'move' && moveMode) || (c.id === 'light' && lightMode)
          return (
            <button key={c.id} onClick={() => toggle(c.id)}
              className={`flex w-[152px] items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left shadow-md backdrop-blur-md transition ${active
                ? 'border-brand bg-white ring-1 ring-brand/40' : 'border-white/70 bg-white/90 hover:bg-white'}`}>
              <span className="grid h-6 w-6 flex-none place-items-center rounded-lg bg-slate-100 text-[12px] text-slate-600">{c.icon}</span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500">{c.label}</span>
                {c.meaning ? (
                  <>
                    <span className="block truncate text-[12px] font-semibold text-brand">{c.meaning}</span>
                    <span className="block truncate text-[10px] text-slate-500">{c.value}</span>
                  </>
                ) : (
                  <span className="block truncate text-[12px] font-semibold text-slate-800">{c.value}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  )
}
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] text-slate-400">{label}</div>
      {children}
    </div>
  )
}
function Range({ min, max, step, value, onChange, onCommit }: {
  min: number; max: number; step: number; value: number; onChange(v: number): void; onCommit(): void
}) {
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onPointerUp={onCommit}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand"
    />
  )
}
function signed(n: number) { return n >= 0 ? `+${n}` : `${n}` }
function clampN(n: number, a: number, b: number) { return Math.min(b, Math.max(a, n)) }

// Rhythm curve editor: Y axis = speed, X axis = time; control points drag up/down (like a speed graph in editing software)
function CurveEditor({ curve, onChange, onCommit }: {
  curve: { x: number; y: number }[]; onChange(c: { x: number; y: number }[]): void; onCommit(): void
}) {
  const ref = useRef<SVGSVGElement>(null)
  const W = 184, H = 98, PAD = 8
  const iw = W - PAD * 2, ih = H - PAD * 2
  const sx = (x: number) => PAD + x * iw
  const sy = (y: number) => PAD + (1 - y) * ih
  const pts = curve.map((p) => ({ x: sx(p.x), y: sy(p.y) }))
  const path = smoothPath(pts)

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect()
      const vy = ((ev.clientY - r.top) / r.height) * H
      const ny = clampN(1 - (vy - PAD) / ih, 0, 1)
      onChange(curve.map((p, k) => (k === i ? { ...p, y: ny } : p)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full select-none rounded-lg bg-slate-50" style={{ aspectRatio: `${W} / ${H}` }}>
      <g stroke="#e2e8f0" strokeWidth={0.7}>
        {[0.25, 0.5, 0.75].map((f) => <line key={'h' + f} x1={PAD} y1={sy(f)} x2={W - PAD} y2={sy(f)} />)}
        {[0.25, 0.5, 0.75].map((f) => <line key={'v' + f} x1={sx(f)} y1={PAD} x2={sx(f)} y2={H - PAD} />)}
      </g>
      <text x={PAD + 1} y={PAD + 7} fontSize={6.5} fill="#94a3b8">fast</text>
      <text x={PAD + 1} y={H - PAD - 1.5} fontSize={6.5} fill="#94a3b8">slow</text>
      <text x={W - PAD - 18} y={H - PAD - 1.5} fontSize={6.5} fill="#94a3b8">time →</text>
      <path d={`${path} L ${sx(1).toFixed(1)} ${sy(0).toFixed(1)} L ${sx(0).toFixed(1)} ${sy(0).toFixed(1)} Z`} fill="#6366f1" opacity={0.08} />
      <path d={path} fill="none" stroke="#6366f1" strokeWidth={1.8} />
      {pts.map((p, i) => (
        <g key={i} style={{ cursor: 'ns-resize' }} onPointerDown={startDrag(i)}>
          <circle cx={p.x} cy={p.y} r={8} fill="#000" opacity={0} />
          <circle cx={p.x} cy={p.y} r={3.4} fill="#fff" stroke="#6366f1" strokeWidth={1.8} />
        </g>
      ))}
    </svg>
  )
}
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return ''
  const at = (k: number) => pts[Math.max(0, Math.min(pts.length - 1, k))]!
  let d = `M ${at(0).x.toFixed(1)} ${at(0).y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}
