import { useEffect, useRef, useState } from 'react'
import type { SevenDims, Anchor } from '../../../api/types'
import { SHOT_RINGS, DIST_MIN, DIST_MAX, PITCH_MIN, PITCH_MAX, LEVEL_EN, easeEn } from '../../../lib/dims'

interface Props {
  backdropUrl: string
  dims: SevenDims
  anchor: Anchor
  compMode?: boolean // composition mode: stage shows only a fixed 16:9 grid + draggable focus, all camera elements hidden
  moveMode?: boolean // movement mode: edit start/end + motion trajectory curve
  lightMode?: boolean // lighting mode: drag the light source on the canvas
  onExitComp?: () => void // exit composition mode
  onExitMove?: () => void // exit movement mode
  onExitLight?: () => void // exit lighting mode
  onDraftChange(p: { dims?: Partial<SevenDims>; anchor?: Partial<Anchor> }): void
  onCommit(): void
}

type V = { x: number; y: number }
export const STAGE_W = 1200
export const STAGE_H = 560
const SCALE = 11 // px / m
const FLAT = 0.28 // ground ellipse flattening (lower = flatter, stronger top-down 3D feel)
const PITCH_PX = 0.5 // deg per px (tilt drag sensitivity)
const DOLLY_DRAG_PX = 320 // screen px for the full near→far dolly travel (log-scaled, so close-ups aren't cramped)
const DEPTH_MAX = 20 // max subject→background distance (m); depthM = how far the subject stands from the backdrop

export function CameraStage2D({ backdropUrl, dims, anchor, compMode = false, moveMode = false, lightMode = false, onExitComp, onExitMove, onExitLight, onDraftChange, onCommit }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<'yaw' | 'dist' | 'pitch' | 'anchor' | 'focus' | 'kf' | 'light' | 'zoom' | 'depth' | null>(null)
  const [hover, setHover] = useState<'yaw' | 'dist' | 'pitch' | null>(null)
  const [viewport, setViewport] = useState({ width: STAGE_W, height: STAGE_H })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return

    const update = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.max(Math.round(rect.width), 1)
      const height = Math.max(Math.round(rect.height), 1)
      setViewport((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const vw = viewport.width
  const vh = viewport.height

  const ax = anchor.point2d.x * vw
  const ay = anchor.point2d.y * vh
  const yaw = dims.angle.yaw
  const dist = dims.distanceM
  const pitch = dims.angle.pitch

  const norm = (x: number, y: number): V => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l } }
  const D = 3

  // —— Ground-plane perspective: one depth factor pz (near bigger, far smaller) applied to
  //    BOTH x and y, so ground circles project to natural ellipses and the floor / rings /
  //    orbit / camera arc all share one consistent perspective. ——
  const GROUND_R = 34                 // ground plane radius (world m)
  const KZ = 0.012                    // perspective strength per world-meter of depth
  const pz = (lz: number): number => 1 / (1 - KZ * lz)  // depth factor; lz>0 near, lz<0 far
  // a ground point at world offset (lx = right, lz = depth, +lz = nearer) → screen
  const gp = (lx: number, lz: number): V => {
    const P = pz(lz)
    return { x: ax + lx * SCALE * P, y: ay + lz * SCALE * FLAT * P }
  }
  const ground = (yawDeg: number, d: number): V => {
    const th = (yawDeg * Math.PI) / 180
    return gp(d * Math.cos(th), d * Math.sin(th))
  }
  const elev = (yawDeg: number, d: number, ph: number): V => {
    const t = (yawDeg * Math.PI) / 180, p = (ph * Math.PI) / 180
    const rd = d * Math.cos(p)                 // horizontal radius after tilt
    const P = pz(rd * Math.sin(t))             // depth factor at the camera's ground footing
    return {
      x: ax + rd * Math.cos(t) * SCALE * P,
      y: ay + rd * Math.sin(t) * SCALE * FLAT * P - d * Math.sin(p) * SCALE * P,
    }
  }
  // a ground circle of world-radius r, sampled into a perspective path
  const groundCirclePath = (r: number): string => {
    let s = ''
    for (let a = 0; a <= 360; a += 6) {
      const q = ground(a, r)
      s += `${a === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)} `
    }
    return s + 'Z'
  }
  // screen point → orbit angle; pz cancels in both x and y, so a plain atan2 inverts it
  const angleAt = (p: V): number => Math.atan2((p.y - ay) / FLAT, p.x - ax)

  const cam = elev(yaw, dist, pitch) // camera: rises/lowers along the pink arc with tilt
  const foot = ground(yaw, dist) // base point on the green ring (foot of the pink arc, φ=0)

  // axis directions (true tangents taken at the elevated camera position)
  const yP = elev(yaw + D, dist, pitch), yM = elev(yaw - D, dist, pitch)
  const au = norm(yP.x - yM.x, yP.y - yM.y) // orbit tangent
  const rP = elev(yaw, dist + 1, pitch), rM = elev(yaw, Math.max(dist - 1, 0.2), pitch)
  const ru = norm(rP.x - rM.x, rP.y - rM.y) // distance direction
  const fP = elev(yaw, dist, clamp(pitch + D, PITCH_MIN, PITCH_MAX)), fM = elev(yaw, dist, clamp(pitch - D, PITCH_MIN, PITCH_MAX))
  const pu = norm(fP.x - fM.x, fP.y - fM.y) // tilt tangent (along the pink arc)
  const look = norm(ax - cam.x, ay - cam.y) // lens facing the subject

  // pink arc: rises from the green-ring base point (φ=0); the camera rides at φ=pitch
  const pitchArc = (() => {
    const pts: string[] = []
    for (let b = PITCH_MIN; b <= PITCH_MAX; b += 2) {
      const q = elev(yaw, dist, b)
      pts.push(`${b === PITCH_MIN ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`)
    }
    return pts.join(' ')
  })()

  const toSvg = (cx: number, cy: number): V => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: ((cx - r.left) / r.width) * vw, y: ((cy - r.top) / r.height) * vh }
  }

  // Grab an axis arrow → move only that dimension. Orbit uses "angle around the anchor" (full-circle, follows the cursor without flipping); distance/tilt use projection.
  const startAxisDrag = (axis: 'yaw' | 'dist' | 'pitch', u: V) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag(axis)
    const start = { yaw, dist, pitch }
    const s0 = { x: e.clientX, y: e.clientY }
    const p0 = toSvg(e.clientX, e.clientY)
    const a0 = angleAt(p0)
    const move = (ev: PointerEvent) => {
      if (axis === 'yaw') {
        const p = toSvg(ev.clientX, ev.clientY)
        let dA = ((angleAt(p) - a0) * 180) / Math.PI
        while (dA > 180) dA -= 360
        while (dA < -180) dA += 360
        onDraftChange({ dims: { angle: { ...dims.angle, yaw: Math.round(start.yaw + dA) } } })
      } else {
        const r = svgRef.current!.getBoundingClientRect()
        const dx = ((ev.clientX - s0.x) / r.width) * vw
        const dy = ((ev.clientY - s0.y) / r.height) * vh
        const proj = dx * u.x + dy * u.y
        if (axis === 'dist') {
          // log-scale dolly: equal screen travel per shot-size band, so close-ups aren't cramped
          const lnMin = Math.log(DIST_MIN), lnMax = Math.log(DIST_MAX)
          const su = (Math.log(start.dist) - lnMin) / (lnMax - lnMin)
          const nu = clamp(su + proj / DOLLY_DRAG_PX, 0, 1)
          onDraftChange({ dims: { distanceM: round1(Math.exp(lnMin + nu * (lnMax - lnMin))) } })
        } else {
          onDraftChange({ dims: { angle: { ...dims.angle, pitch: clamp(Math.round(start.pitch + proj * PITCH_PX), PITCH_MIN, PITCH_MAX) } } })
        }
      }
    }
    finish(move)
  }

  const onAnchorDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('anchor')
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      const x = clamp(p.x / vw, 0.05, 0.95), y = clamp(p.y / vh, 0.05, 0.95)
      // yellow focus = subject in frame: keep composition.focus in sync so the viewfinder + composition agree
      onDraftChange({ anchor: { point2d: { x, y } }, dims: { composition: { ...dims.composition, focus: { x, y }, headroom: y, leadRoom: 1 - x } } })
    }
    finish(move)
  }

  // Depth handle: drag the subject toward/away from the backdrop (anchor.depthM) — the actor moving in the scene,
  // not the camera. Changes subject↔background distance (→ depth of field / separation), not its size.
  const onDepthDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('depth')
    const start = anchor.depthM ?? 8.5
    const s0y = e.clientY
    const move = (ev: PointerEvent) => {
      const r = svgRef.current!.getBoundingClientRect()
      const dy = ((ev.clientY - s0y) / r.height) * vh
      onDraftChange({ anchor: { depthM: clamp(round1(start - dy * 0.05), 0, DEPTH_MAX) } }) // drag up = farther from backdrop
    }
    finish(move)
  }

  const finish = (move: (ev: PointerEvent) => void) => {
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dofTxt = dims.focal.dof < 0.4 ? 'Shallow' : dims.focal.dof > 0.6 ? 'Deep' : 'Mid'

  // Movement keyframes: each "Record frame" click appends the CURRENT camera pose as one keyframe;
  // the path is the ordered keyframes (start/end mirror the ends, for compatibility).
  const recPath = dims.movement.path
  const addKeyframe = () => {
    const path = [...(recPath ?? []), { yaw, dist, pitch }]
    onDraftChange({ dims: { movement: { ...dims.movement, type: 'Custom', path, start: path[0], end: path[path.length - 1], endAuto: false } } })
    onCommit()
  }
  const clearKeyframes = () => {
    onDraftChange({ dims: { movement: { ...dims.movement, path: undefined, start: undefined, end: undefined } } })
    onCommit()
  }
  // screen point + yaw → world distance, inverting the perspective (a few iterations)
  const invDist = (p: V, yawDeg: number) => {
    const th = (yawDeg * Math.PI) / 180
    let d = Math.hypot((p.x - ax) / SCALE, (p.y - ay) / (SCALE * FLAT))
    for (let k = 0; k < 3; k++) {
      const P = pz(d * Math.sin(th))
      const dx = Math.cos(th) * SCALE * P, dy = Math.sin(th) * SCALE * FLAT * P
      d = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1), DIST_MIN, DIST_MAX)
    }
    return round1(d)
  }
  // drag a keyframe handle on the ground → change that keyframe's orbit + dist (pitch kept)
  const onKfDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('kf')
    const base = dims.movement.path ?? []
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      const yaw = Math.round((angleAt(p) * 180) / Math.PI)
      const dist = invDist(p, yaw)
      const np = base.map((q, k) => (k === i ? { ...q, yaw, dist } : q))
      onDraftChange({ dims: { movement: { ...dims.movement, path: np, start: np[0], end: np[np.length - 1] } } })
    }
    finish(move)
  }
  const startPose = recPath?.[0] ?? dims.movement.start
  const endPose = recPath?.[recPath.length - 1] ?? dims.movement.end
  const startCam = startPose ? elev(startPose.yaw, startPose.dist, startPose.pitch) : null
  const endCam = endPose ? elev(endPose.yaw, endPose.dist, endPose.pitch) : null
  const trajPts: V[] = (() => {
    // Custom keyframes (≥2): smooth Catmull-Rom spline through every recorded pose
    if (recPath && recPath.length >= 2) {
      const n = recPath.length, out: V[] = [], STEPS = 14
      for (let i = 0; i < n - 1; i++) {
        const a = recPath[Math.max(0, i - 1)]!, b = recPath[i]!, c = recPath[i + 1]!, d = recPath[Math.min(n - 1, i + 2)]!
        for (let s = 0; s < STEPS; s++) {
          const t = s / STEPS
          out.push(elev(cr(a.yaw, b.yaw, c.yaw, d.yaw, t), cr(a.dist, b.dist, c.dist, d.dist, t), cr(a.pitch, b.pitch, c.pitch, d.pitch, t)))
        }
      }
      const last = recPath[n - 1]!
      out.push(elev(last.yaw, last.dist, last.pitch))
      return out
    }
    // Preset move: linear interpolation between derived start/end
    if (startPose && endPose) {
      return Array.from({ length: 25 }, (_, i) => {
        const t = i / 24
        return elev(
          startPose.yaw + (endPose.yaw - startPose.yaw) * t,
          startPose.dist + (endPose.dist - startPose.dist) * t,
          startPose.pitch + (endPose.pitch - startPose.pitch) * t,
        )
      })
    }
    return []
  })()
  const trajPath = trajPts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  // Composition mode: the framing box is placed RELATIVE to the subject (anchor):
  //   box size = base / zoom (zoom = framing/FOV); box positioned so the subject sits at `focus` inside it.
  //   → move subject = box follows (composition kept); move box = recompose (focus); drag corner = zoom.
  const compZoom = dims.composition.zoom ?? 1
  const compBaseW = clamp(vw * 0.42, 300, 760)
  const compFocus = dims.composition.focus
  const compFW = clamp(compBaseW / compZoom, 140, vw * 0.96)
  const compFH = (compFW * 9) / 16
  const compFL = ax - compFocus.x * compFW
  const compFT = ay - compFocus.y * compFH
  // subject sits at (ax, ay) = its `focus` position inside the box
  // drag the box → change where the subject sits in frame (composition)
  const onFrameDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('focus')
    const p0 = toSvg(e.clientX, e.clientY)
    const startL = compFL, startT = compFT
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      const fx = clamp((ax - (startL + (p.x - p0.x))) / compFW, 0, 1)
      const fy = clamp((ay - (startT + (p.y - p0.y))) / compFH, 0, 1)
      onDraftChange({ dims: { composition: { ...dims.composition, focus: { x: fx, y: fy }, headroom: fy, leadRoom: 1 - fx, preset: undefined } } })
    }
    finish(move)
  }
  // drag the bottom-right corner → resize the box around the subject = zoom (FOV)
  const onZoomDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('zoom')
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      const w = clamp((p.x - ax) / Math.max(1 - compFocus.x, 0.15), 140, vw * 0.96)
      onDraftChange({ dims: { composition: { ...dims.composition, zoom: round1(clamp(compBaseW / w, 0.5, 4)) } } })
    }
    finish(move)
  }

  // Lighting: a draggable light source on the canvas; the light shines from pos toward the subject
  const lpos = dims.lighting.pos ?? { x: 0.5, y: 0.18 }
  const lx = lpos.x * vw, ly = lpos.y * vh
  const warmth = dims.lighting.temperature ?? 0.5
  const softness = dims.lighting.softness ?? 0.5
  const lightColor = tempColor(warmth)
  // Beam cone toward the subject: narrow = spot, wide = flood
  const spread = dims.lighting.spread ?? 0.4
  const ldir = norm(ax - lx, ay - ly)
  const beamLen = Math.hypot(ax - lx, ay - ly) * 1.08 || 1
  const intensity = dims.lighting.keyPct / 100
  const halfA = ((6 + spread * 74) * Math.PI) / 180
  const rotV = (v: V, a: number): V => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })
  const beamT1 = { x: lx + rotV(ldir, halfA).x * beamLen, y: ly + rotV(ldir, halfA).y * beamLen }
  const beamT2 = { x: lx + rotV(ldir, -halfA).x * beamLen, y: ly + rotV(ldir, -halfA).y * beamLen }
  const onLightDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag('light')
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY)
      onDraftChange({ dims: { lighting: { ...dims.lighting, pos: { x: clamp(p.x / vw, 0.02, 0.98), y: clamp(p.y / vh, 0.02, 0.98) } } } })
    }
    finish(move)
  }

  return (
    <div ref={stageRef} className="absolute inset-0 overflow-hidden rounded-xl bg-gradient-to-b from-[#aebccb] via-[#92a0af] to-[#67737f]">
      {/* Dark scrim over the gradient background */}
      <div className="pointer-events-none absolute inset-0 bg-black/25" />

      <svg
        ref={svgRef}
        viewBox={`0 0 ${vw} ${vh}`}
        className="absolute inset-0 h-full w-full select-none"
        style={{ cursor: drag ? 'grabbing' : 'default' }}>
        <defs>
          <filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="softglow" x="-90%" y="-90%" width="280%" height="280%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          {/* Beam edge feathering: hard light = sharp, soft light = blurred */}
          <filter id="beamSoft" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={0.4 + softness * 10} />
          </filter>
        </defs>

        {/* Composition mode: framing box placed relative to the subject. Move subject = box follows;
            drag box = recompose; drag corner = zoom. */}
        {compMode && (() => {
          const comp = dims.composition
          const fr = compFL + compFW
          const fb = compFT + compFH
          const BL = '#5b7ee0'
          const leadRight = comp.focus.x < 0.5
          const leadX = leadRight ? fr : compFL
          return (
            <g>
              {/* Framing box — drag to recompose (where the subject sits in frame) */}
              <g style={{ cursor: drag === 'focus' ? 'grabbing' : 'move' }} onPointerDown={onFrameDown}>
                <rect x={compFL} y={compFT} width={compFW} height={compFH} rx={6} fill="#0b1220" opacity={0.05} />
                <rect x={compFL} y={compFT} width={compFW} height={compFH} rx={6} fill="none" stroke="#1f2937" strokeWidth={3} opacity={0.2} />
                <rect x={compFL} y={compFT} width={compFW} height={compFH} rx={6} fill="none" stroke="#fff" strokeWidth={1.8} opacity={0.85} />
                <g stroke="#fff" strokeWidth={1.3} opacity={0.5} strokeDasharray="4 5" pointerEvents="none">
                  <line x1={compFL + compFW / 3} y1={compFT} x2={compFL + compFW / 3} y2={fb} />
                  <line x1={compFL + (2 * compFW) / 3} y1={compFT} x2={compFL + (2 * compFW) / 3} y2={fb} />
                  <line x1={compFL} y1={compFT + compFH / 3} x2={fr} y2={compFT + compFH / 3} />
                  <line x1={compFL} y1={compFT + (2 * compFH) / 3} x2={fr} y2={compFT + (2 * compFH) / 3} />
                </g>
              </g>
              {/* Headroom (frame top → subject) */}
              <g stroke={BL} fill={BL} strokeWidth={1.4} opacity={0.9} pointerEvents="none">
                <line x1={ax} y1={compFT + 4} x2={ax} y2={ay - 14} />
                <polygon points={`${ax},${compFT + 3} ${ax - 3.6},${compFT + 11} ${ax + 3.6},${compFT + 11}`} stroke="none" />
                <polygon points={`${ax},${ay - 13} ${ax - 3.6},${ay - 21} ${ax + 3.6},${ay - 21}`} stroke="none" />
              </g>
              <text x={ax + 8} y={(compFT + ay) / 2} fill={BL} fontSize={11} fontWeight={600}
                stroke="#fff" strokeWidth={3} paintOrder="stroke" pointerEvents="none">Headroom</text>
              {/* Lead Room (subject → front frame edge) */}
              <g stroke={BL} fill={BL} strokeWidth={1.4} opacity={0.9} pointerEvents="none">
                <line x1={ax + (leadRight ? 14 : -14)} y1={ay} x2={leadRight ? leadX - 4 : leadX + 4} y2={ay} />
                <polygon points={leadRight
                  ? `${leadX - 3},${ay} ${leadX - 10},${ay - 3.6} ${leadX - 10},${ay + 3.6}`
                  : `${leadX + 3},${ay} ${leadX + 10},${ay - 3.6} ${leadX + 10},${ay + 3.6}`} stroke="none" />
              </g>
              <text x={(ax + leadX) / 2} y={ay - 9} fill={BL} fontSize={11} fontWeight={600} textAnchor="middle"
                stroke="#fff" strokeWidth={3} paintOrder="stroke" pointerEvents="none">Lead Room</text>
              {/* Subject (orange) — read-only here; it only follows the actor's position set in director mode */}
              <g pointerEvents="none" filter="url(#glow)">
                <circle cx={ax} cy={ay} r={14} fill="none" stroke="#f97316" strokeWidth={2} opacity={0.95} />
                <circle cx={ax} cy={ay} r={3} fill="#f97316" />
                {[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy], i) => (
                  <line key={i} x1={ax + dx * 9} y1={ay + dy * 9} x2={ax + dx * 18} y2={ay + dy * 18} stroke="#f97316" strokeWidth={1.8} opacity={0.95} />
                ))}
              </g>
              {/* Zoom corner (bottom-right) — drag to resize the framing = zoom / field of view */}
              <g style={{ cursor: 'nwse-resize' }} onPointerDown={onZoomDown}>
                <circle cx={fr} cy={fb} r={14} fill="#000" opacity={0} />
                <rect x={fr - 11} y={fb - 11} width={12} height={12} rx={2} fill="#fff" stroke="#1f2937" strokeWidth={1.6} opacity={0.92} />
                <path d={`M${fr - 7},${fb - 2} L${fr - 2},${fb - 7} M${fr - 7.5},${fb - 6} L${fr - 6},${fb - 7.5} M${fr - 4},${fb - 1.5} L${fr - 2.5},${fb - 3}`} stroke="#1f2937" strokeWidth={1.1} fill="none" opacity={0.75} />
              </g>
            </g>
          )
        })()}

        {/* Movement mode: ghost cameras for confirmed start (green)/end (red) poses + interpolated trajectory between them.
            Position the current camera with the gizmo below (Orbit/Dolly/Tilt), click Record frame to drop each keyframe. */}
        {moveMode && (
          <>
            <g pointerEvents="none">
              {trajPath && (
                <>
                  <path d={trajPath} fill="none" stroke="#fff" strokeWidth={6} opacity={0.55} strokeLinecap="round" />
                  <path d={trajPath} fill="none" stroke="#7c5cff" strokeWidth={2.6} opacity={0.95} strokeLinecap="round" filter="url(#glow)" />
                  {/* Direction arrows along the path */}
                  {[0.55, 0.9].map((f) => {
                    const i = Math.max(1, Math.round(f * (trajPts.length - 1)))
                    const p = trajPts[i]!, q = trajPts[i - 1]!
                    const u = norm(p.x - q.x, p.y - q.y), pp: V = { x: -u.y, y: u.x }
                    const pts = `${(p.x + u.x * 6).toFixed(1)},${(p.y + u.y * 6).toFixed(1)} ${(p.x - u.x * 4 + pp.x * 4.5).toFixed(1)},${(p.y - u.y * 4 + pp.y * 4.5).toFixed(1)} ${(p.x - u.x * 4 - pp.x * 4.5).toFixed(1)},${(p.y - u.y * 4 - pp.y * 4.5).toFixed(1)}`
                    return <polygon key={f} points={pts} fill="#7c5cff" stroke="#fff" strokeWidth={0.8} />
                  })}
                </>
              )}
              {startCam && camGizmo(startCam, norm(ax - startCam.x, ay - startCam.y))}
              {endCam && camGizmo(endCam, norm(ax - endCam.x, ay - endCam.y))}
            </g>
            {/* Draggable keyframe handles — drag on the ground to move that frame (orbit + dist; pitch kept) */}
            {(dims.movement.path ?? []).map((pose, i, arr) => {
              const c = elev(pose.yaw, pose.dist, pose.pitch)
              const col = i === 0 ? '#16a34a' : i === arr.length - 1 ? '#ef4444' : '#7c5cff'
              return (
                <g key={i} style={{ cursor: drag === 'kf' ? 'grabbing' : 'grab' }} onPointerDown={onKfDown(i)} filter="url(#glow)">
                  <circle cx={c.x} cy={c.y} r={15} fill="#000" opacity={0} />
                  <circle cx={c.x} cy={c.y} r={6.5} fill="#fff" stroke={col} strokeWidth={2.6} />
                  <text x={c.x} y={c.y - 12} fill={col} fontSize={10} fontWeight={700} textAnchor="middle" stroke="#fff" strokeWidth={2.5} paintOrder="stroke">{i + 1}</text>
                </g>
              )
            })}
          </>
        )}

        {/* Reference guides: shot-size rings / tilt arc / orbit / anchor — shown in both normal and movement modes (to see where the camera is);
            hidden only in composition mode. The single camera's line of sight/gizmo/axis arrows are controlled separately by the inner !moveMode. */}
        {!compMode && (<>
        {/* Backdrop photo as an upright wall standing on the ground behind the subject (depthM),
            in the SAME perspective as the floor; turns with orbit. */}
        {(() => {
          const dM = anchor.depthM ?? 8.5
          const th = ((yaw + 180) * Math.PI) / 180 // behind the subject (away from camera)
          const bg = ground(yaw + 180, dM) // ground point where the wall stands
          const pf = pz(dM * Math.sin(th)) // perspective scale at that depth
          const halfW = 15 * SCALE * pf, wallH = 17 * SCALE * pf
          return (
            <g>
              <ellipse cx={bg.x} cy={bg.y} rx={halfW * 1.02} ry={halfW * 0.16} fill="#000" opacity={0.22} /> {/* ground contact shadow */}
              <image href={backdropUrl} x={bg.x - halfW} y={bg.y - wallH} width={halfW * 2} height={wallH} preserveAspectRatio="xMidYMid slice" opacity={0.96} />
              <rect x={bg.x - halfW} y={bg.y - wallH} width={halfW * 2} height={wallH} fill="none" stroke="#fff" strokeWidth={1.2} opacity={0.5} />
            </g>
          )
        })()}
        {/* Ground plane: a perspective quad (near edge wider, far edge narrower) + grid,
            so the rings read as lying on a receding 3D floor */}
        {(() => {
          const G = '#e8eef2'
          const R = GROUND_R
          const quad = [gp(-R, -R), gp(R, -R), gp(R, R), gp(-R, R)]
            .map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')
          return (
            <g pointerEvents="none">
              <polygon points={quad} fill={G} fillOpacity={0.14} stroke={G} strokeOpacity={0.7} strokeWidth={1.6} />
              <g stroke={G} strokeOpacity={0.28} strokeWidth={1}>
                {[-R / 2, 0, R / 2].map((lz) => {
                  const a = gp(-R, lz), b = gp(R, lz)
                  return <line key={`r${lz}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                })}
                {[-R, -R / 2, 0, R / 2, R].map((lx) => {
                  const a = gp(lx, R), b = gp(lx, -R)
                  return <line key={`c${lx}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                })}
              </g>
            </g>
          )
        })()}
        {/* Shot-size reference rings (dotted dashes + labels) */}
        {SHOT_RINGS.map((ring) => (
          <g key={ring.size}>
            <path d={groundCirclePath(ring.r)} fill="none" stroke="#5b97c4" strokeWidth={1} opacity={0.35} strokeDasharray="1 6" />
            <text x={ax + ring.r * SCALE + 6} y={ay + 3} fill={dims.shotSize === ring.size ? '#0e7490' : '#5b87a8'} fontSize={10} fontWeight={dims.shotSize === ring.size ? 700 : 400} opacity={0.85}>{ring.size}</text>
          </g>
        ))}

        {/* Tilt arc (pink · glowing dashes, drawn first) */}
        <path d={pitchArc} fill="none" stroke="#f7a8cf" strokeWidth={5} opacity={0.25} filter="url(#softglow)" />
        <path d={pitchArc} fill="none" stroke="#ef5da8" strokeWidth={1.8} opacity={0.7} strokeDasharray="6 5" strokeLinecap="round" filter="url(#glow)" />
        {[PITCH_MIN, PITCH_MAX].map((b) => {
          const q = elev(yaw, dist, b)
          return <circle key={b} cx={q.x} cy={q.y} r={2.4} fill="#ef5da8" opacity={0.8} />
        })}

        {/* Distance orbit (cyan · glowing) */}
        <path d={groundCirclePath(dist)} fill="none" stroke="#22d3d3" strokeWidth={6} opacity={0.22} filter="url(#softglow)" />
        <path d={groundCirclePath(dist)} fill="none" stroke="#0fc7c7" strokeWidth={2.2} opacity={0.95} filter="url(#glow)" />
        <circle cx={foot.x} cy={foot.y} r={3.5} fill="#0fc7c7" stroke="#fff" strokeWidth={1.2} />

        {/* Line of sight (anchor → current camera) */}
        <line x1={ax} y1={ay} x2={cam.x} y2={cam.y} stroke="#5b7a9c" strokeWidth={1} opacity={0.4} strokeDasharray="2 4" />
        {/* Dolly: while dragging/hovering distance, emphasize anchor→camera + show the distance */}
        {(drag === 'dist' || hover === 'dist') && (
          <g pointerEvents="none">
            <line x1={ax} y1={ay} x2={cam.x} y2={cam.y} stroke="#0fb6b6" strokeWidth={1.6} strokeDasharray="5 4" opacity={0.95} />
            <circle cx={ax} cy={ay} r={3} fill="#0fb6b6" />
            <text x={(ax + cam.x) / 2} y={(ay + cam.y) / 2 - 6} fill="#0fb6b6" fontSize={12} fontWeight={700}
              textAnchor="middle" stroke="#fff" strokeWidth={3} paintOrder="stroke">{dist.toFixed(1)} m</text>
          </g>
        )}

        {/* Depth handle (purple): drag the subject toward/away from the backdrop (actor moves in the scene) */}
        <g style={{ cursor: drag === 'depth' ? 'grabbing' : 'grab' }} onPointerDown={onDepthDown} filter="url(#glow)">
          <line x1={ax} y1={ay} x2={ax} y2={ay} stroke="#000" strokeOpacity={0} strokeWidth={20} />
          <line x1={ax} y1={ay - 16} x2={ax} y2={ay - 38} stroke="#a855f7" strokeWidth={2} />
          <polygon points={`${ax},${ay - 43} ${ax - 4},${ay - 35} ${ax + 4},${ay - 35}`} fill="#a855f7" />
          <text x={ax + 7} y={ay - 33} fill="#a855f7" fontSize={11} fontWeight={700} stroke="#fff" strokeWidth={3} paintOrder="stroke">BG {(anchor.depthM ?? 8.5).toFixed(1)} m</text>
        </g>
        {/* Anchor focus reticle (amber, draggable) */}
        <g style={{ cursor: 'move' }} onPointerDown={onAnchorDown} filter="url(#glow)">
          <circle cx={ax} cy={ay} r={12} fill="none" stroke="#f59e0b" strokeWidth={1.6} opacity={0.95} />
          <circle cx={ax} cy={ay} r={2.6} fill="#f59e0b" />
          {[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy], i) => (
            <line key={i} x1={ax + dx * 9} y1={ay + dy * 9} x2={ax + dx * 16} y2={ay + dy * 16} stroke="#f59e0b" strokeWidth={1.4} opacity={0.95} />
          ))}
        </g>

        {/* Camera gizmo + draggable axis arrows (usable for positioning in both normal and movement modes) */}
        <g>
          <g style={{ pointerEvents: 'none' }}>{camGizmo(cam, look)}</g>
          <Arrow o={cam} u={au} len={48} color="#2f6bff" label="Orbit" value={`${yaw}°`}
            active={hover === 'yaw' || drag === 'yaw'} onDown={startAxisDrag('yaw', au)}
            onEnter={() => setHover('yaw')} onLeave={() => setHover(null)} />
          <Arrow o={cam} u={ru} len={44} color="#0fb6b6" label="Dolly" value={`${dist.toFixed(1)} m`}
            active={hover === 'dist' || drag === 'dist'} onDown={startAxisDrag('dist', ru)}
            onEnter={() => setHover('dist')} onLeave={() => setHover(null)} />
          <Arrow o={cam} u={pu} len={46} color="#ef4e8f" label="Tilt" value={`${pitch}°`}
            active={hover === 'pitch' || drag === 'pitch'} onDown={startAxisDrag('pitch', pu)}
            onEnter={() => setHover('pitch')} onLeave={() => setHover(null)} />
        </g>
        </>)}

        {/* Lighting mode: draggable light source + ray to the subject; halo size = softness, color = warmth */}
        {lightMode && (
          <g>
            <polygon points={`${lx},${ly} ${beamT1.x.toFixed(1)},${beamT1.y.toFixed(1)} ${beamT2.x.toFixed(1)},${beamT2.y.toFixed(1)}`} fill={lightColor} opacity={0.08 + intensity * 0.26} filter="url(#beamSoft)" />
            <line x1={lx} y1={ly} x2={ax} y2={ay} stroke={lightColor} strokeWidth={1.5} strokeDasharray="6 5" opacity={0.55} />
            <g style={{ cursor: drag === 'light' ? 'grabbing' : 'grab' }} onPointerDown={onLightDown} filter="url(#glow)">
              <circle cx={lx} cy={ly} r={22} fill="#000" opacity={0} />
              <circle cx={lx} cy={ly} r={18} fill={lightColor} opacity={0.12 + intensity * 0.24} />
              <circle cx={lx} cy={ly} r={9} fill={lightColor} stroke="#fff" strokeWidth={2} />
              {Array.from({ length: 8 }, (_, i) => {
                const a = (i / 8) * Math.PI * 2
                const r1 = 12, r2 = 21
                return <line key={i} x1={lx + Math.cos(a) * r1} y1={ly + Math.sin(a) * r1} x2={lx + Math.cos(a) * r2} y2={ly + Math.sin(a) * r2} stroke={lightColor} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
              })}
            </g>
          </g>
        )}
      </svg>

      {/* Camera HUD (hidden only in composition mode; kept in movement mode to assist positioning) */}
      {!compMode && (
        <>
          {/* Top-left frosted info cards */}
          <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-2">
            <FrostCard icon="◳" label="Distance" value={`${dist.toFixed(1)} m · ${dims.shotSize}`} />
            <FrostCard icon="✦" label="Camera Angle" value={`Orbit ${yaw}° · Tilt ${pitch}° (${LEVEL_EN[dims.angle.level]})`} />
            <FrostCard icon="◎" label="Depth of Field" value={`${dofTxt} DoF`} />
            <FrostCard icon="⇲" label="Subject → Backdrop" value={`${(anchor.depthM ?? 8.5).toFixed(1)} m`} />
          </div>
          {/* Schematic viewfinder (real-time, no generation): subject position = composition, size = shot size */}
          <div className="pointer-events-none absolute bottom-4 left-4 z-10">
            <div className="rounded-lg border border-white/60 bg-black/30 p-1 shadow-lg backdrop-blur-sm">
              {(() => {
                const dof = dims.focal.dof
                // real depth of field: blur grows with subject→background distance (depthM) and a shallow lens (low dof)
                const bgBlur = (1 - dof) * Math.min(4, Math.max(0.2, (anchor.depthM ?? 8.5) * 0.4))
                const lpos = dims.lighting.pos ?? { x: 0.5, y: 0.18 }
                const lightColor = tempColor(dims.lighting.temperature ?? 0.5)
                const leftLight = lpos.x < 0.5
                const intensity = (dims.lighting.keyPct ?? 60) / 100
                const soft = dims.lighting.softness ?? 0.5
                const spread = dims.lighting.spread ?? 0.4
                const hi = 0.12 + intensity * 0.55 // highlight opacity (intensity)
                const lo = (0.12 + intensity * 0.45) * (1 - spread * 0.92) // spot = dark surround; flood = even (daylight, no dark edge)
                const midStop = 0.45 + soft * 0.32 // beam falloff: hard = sharper, soft = gradual
                const baseLite = soft < 0.4 ? '#f5f9fd' : '#e8eef4'
                const baseDark = soft < 0.4 ? '#5e6670' : soft > 0.7 ? '#b0b8c2' : '#8a929c' // hard light = strong subject contrast
                const horizonY = Math.max(8, Math.min(82, 45 - dims.angle.pitch * 0.5)) // high angle → horizon up
                const tintColor = (({ Cool: '#3a6ea5', 'Teal & Orange': '#1f8a8a', Warm: '#c8772f', 'Film Emulation': '#8a7a5a' }) as Record<string, string>)[dims.color.look] ?? '#7a8694'
                const depthF = 0.5 + (anchor.depthM ?? 8.5) / DEPTH_MAX // z axis: near backdrop (far from camera) = smaller, away from backdrop (near camera) = bigger
                const ratio = sizeRatio(dims.distanceM / (dims.composition.zoom ?? 1)) // continuous (dolly ÷ zoom), no shot-size band stepping
                const sh = ratio * 90 * depthF
                const cx = dims.composition.focus.x * 160 // subject in frame = composition (kept in sync with the yellow-focus drag)
                const headCy = dims.composition.focus.y * 90
                const headR = Math.max(1.5, sh * 0.13)
                const neckW = headR * 0.9
                const shW = sh * 0.46
                const topY = headCy + headR * 0.45
                const shoulderY = headCy + headR * 1.85
                const botY = headCy + sh
                const cr2 = Math.min(shW * 0.24, Math.max(2, (botY - shoulderY) * 0.4))
                const f = (n: number) => n.toFixed(1)
                const bust = [
                  `M ${f(cx - neckW / 2)},${f(topY)}`,
                  `Q ${f(cx - shW / 2)},${f(shoulderY - headR * 0.5)} ${f(cx - shW / 2)},${f(shoulderY)}`, // round left shoulder
                  `L ${f(cx - shW / 2)},${f(botY - cr2)}`,
                  `Q ${f(cx - shW / 2)},${f(botY)} ${f(cx - shW / 2 + cr2)},${f(botY)}`, // round bottom-left
                  `L ${f(cx + shW / 2 - cr2)},${f(botY)}`,
                  `Q ${f(cx + shW / 2)},${f(botY)} ${f(cx + shW / 2)},${f(botY - cr2)}`, // round bottom-right
                  `L ${f(cx + shW / 2)},${f(shoulderY)}`,
                  `Q ${f(cx + shW / 2)},${f(shoulderY - headR * 0.5)} ${f(cx + neckW / 2)},${f(topY)}`, // round right shoulder
                  'Z',
                ].join(' ')
                // light beam cone: from the light source toward the subject (spot = narrow beam, flood = wide → fills)
                const lx = lpos.x * 160, ly = lpos.y * 90
                const bdx = 80 - lx, bdy = 52 - ly // beam aims at the frame (fixed lighting), NOT the moving subject
                const bdl = Math.hypot(bdx, bdy) || 1
                const bux = bdx / bdl, buy = bdy / bdl
                const halfA = ((10 + spread * 110) * Math.PI) / 180
                const beamLen = 240
                const rotB = (a: number): [number, number] => [bux * Math.cos(a) - buy * Math.sin(a), bux * Math.sin(a) + buy * Math.cos(a)]
                const [b1x, b1y] = rotB(halfA)
                const [b2x, b2y] = rotB(-halfA)
                const beamPts = `${lx.toFixed(1)},${ly.toFixed(1)} ${(lx + b1x * beamLen).toFixed(1)},${(ly + b1y * beamLen).toFixed(1)} ${(lx + b2x * beamLen).toFixed(1)},${(ly + b2y * beamLen).toFixed(1)}`
                // is the subject inside the (fixed) light cone? walk out of it → dimmer
                const sdl = Math.hypot(cx - lx, headCy - ly) || 1
                const axisDot = ((cx - lx) / sdl) * bux + ((headCy - ly) / sdl) * buy
                const lit = Math.max(0, 1 - Math.acos(Math.min(1, Math.max(-1, axisDot))) / (halfA + 0.25))
                const distFade = Math.max(0.4, 1 - (sdl / 190) * (1 - spread * 0.85)) // farther from the light = dimmer → left/right of a side light differ; flood evens it out
                const litFactor = Math.min(1.12, (0.32 + lit * (0.4 + intensity * 0.55)) * distFade)
                const liteSide = dimHex(baseLite, litFactor)
                const darkSide = dimHex(baseDark, litFactor)
                return (
                  <svg width={150} height={84} viewBox="0 0 160 90" className="block rounded">
                    <defs>
                      <filter id="vfBlur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation={bgBlur} /></filter>
                      <filter id="vfBeamSoft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation={2 + soft * 10} /></filter>
                      <linearGradient id="vfBeam" gradientUnits="userSpaceOnUse" x1={lx} y1={ly} x2={lx + bux * beamLen} y2={ly + buy * beamLen}>
                        <stop offset="0" stopColor={lightColor} stopOpacity={hi} />
                        <stop offset={midStop} stopColor={lightColor} stopOpacity={hi * (0.4 + spread * 0.5)} />
                        <stop offset="1" stopColor={lightColor} stopOpacity={hi * spread * 0.6} />
                      </linearGradient>
                      <linearGradient id="vfSubj" x1={leftLight ? '0' : '1'} y1="0" x2={leftLight ? '1' : '0'} y2="0">
                        <stop offset="0" stopColor={liteSide} />
                        <stop offset={0.55 + soft * 0.3} stopColor={darkSide} />
                        <stop offset="1" stopColor={darkSide} />
                      </linearGradient>
                    </defs>
                    {/* sky / ground + horizon (pitch) + distant skyline (pans with orbit yaw), blurred by depth of field */}
                    <g filter="url(#vfBlur)">
                      <rect x={0} y={0} width={160} height={90} fill="#33414f" />
                      {(() => {
                        const panoW = 480
                        const off = ((((dims.angle.yaw % 360) + 360) % 360) / 360) * panoW
                        const items = [{ x: 30, w: 46, h: 16 }, { x: 120, w: 9, h: 26 }, { x: 205, w: 60, h: 12 }, { x: 300, w: 40, h: 20 }, { x: 380, w: 8, h: 23 }, { x: 445, w: 50, h: 14 }]
                        const out: React.ReactNode[] = []
                        items.forEach((it, i) => {
                          ;[-panoW, 0, panoW].forEach((shift) => {
                            const sx = it.x - off + shift
                            if (sx > -70 && sx < 230) {
                              out.push(it.w <= 12
                                ? <rect key={`${i}_${shift}`} x={sx} y={horizonY - it.h} width={it.w} height={it.h} fill="#11181f" />
                                : <polygon key={`${i}_${shift}`} points={`${sx.toFixed(1)},${horizonY} ${(sx + it.w / 2).toFixed(1)},${(horizonY - it.h).toFixed(1)} ${(sx + it.w).toFixed(1)},${horizonY}`} fill="#11181f" />)
                            }
                          })
                        })
                        return <g opacity={0.92}>{out}</g>
                      })()}
                      <rect x={0} y={horizonY} width={160} height={90 - horizonY} fill="#2b2119" />
                      <line x1={0} y1={horizonY} x2={160} y2={horizonY} stroke="#5a6b7a" strokeWidth={1} opacity={0.6} />
                    </g>
                    {/* light: spot = dark surround + beam cone; flood = fades the cone, replaces it with an even daylight wash */}
                    <rect x={0} y={0} width={160} height={90} fill="#000" opacity={lo} />
                    <rect x={0} y={0} width={160} height={90} fill={lightColor} opacity={spread * (0.12 + intensity * 0.32)} />
                    <polygon points={beamPts} fill="url(#vfBeam)" filter="url(#vfBeamSoft)" opacity={1 - spread * 0.8} />
                    <rect x={0} y={0} width={160} height={90} fill={tintColor} opacity={0.2} />
                    {/* subject silhouette (sharp, lit from the light side) */}
                    <g fill="url(#vfSubj)" opacity={0.96}>
                      <path d={bust} />
                      <circle cx={cx} cy={headCy} r={headR} />
                    </g>
                    <g stroke="#fff" strokeOpacity={0.18} strokeWidth={0.7} strokeDasharray="3 3">
                      <line x1={53.3} y1={0} x2={53.3} y2={90} />
                      <line x1={106.7} y1={0} x2={106.7} y2={90} />
                      <line x1={0} y1={30} x2={160} y2={30} />
                      <line x1={0} y1={60} x2={160} y2={60} />
                    </g>
                    <rect x={0.75} y={0.75} width={158.5} height={88.5} fill="none" stroke="#fff" strokeOpacity={0.55} strokeWidth={1.5} />
                  </svg>
                )
              })()}
              <div className="mt-0.5 text-center text-[8px] font-medium tracking-wide text-white/70">VIEWFINDER · {dims.shotSize}</div>
            </div>
          </div>
          {/* Bottom-left movement (above the viewfinder) */}
          <div className="pointer-events-none absolute bottom-[122px] left-4">
            <div className="rounded-xl border border-white/60 bg-white/55 px-3 py-2 text-[12px] text-slate-700 shadow-sm backdrop-blur-md">
              Move: <b className="text-slate-900">{dims.movement.type}</b> · {dims.movement.durationSec.toFixed(1)}s · {easeEn(dims.movement.easing)}
            </div>
          </div>
          {/* Bottom-right legend */}
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-xl border border-white/60 bg-white/55 px-3 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur-md">
            Drag arrows: <b className="text-[#2f6bff]">Orbit</b> · <b className="text-[#ef4e8f]">Tilt</b> · <b className="text-[#0fb6b6]">Dolly</b>
          </div>
        </>
      )}

      {/* Composition mode HUD: hint + readout + done */}
      {compMode && (
        <>
          <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-white/60 bg-white/70 px-3 py-2 text-[12px] text-slate-700 shadow-sm backdrop-blur-md">
            Composition · drag <b className="text-[#f97316]">subject</b> to block · drag <b className="text-slate-900">frame</b> to recompose · drag corner to zoom
          </div>
          <div className="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-white/60 bg-white/65 px-3 py-2 text-[12px] text-slate-700 shadow-sm backdrop-blur-md">
            Headroom <b className="text-slate-900">{Math.round(dims.composition.focus.y * 100)}%</b> · Lead Room <b className="text-slate-900">{Math.round((1 - dims.composition.focus.x) * 100)}%</b> · Zoom <b className="text-slate-900">{(dims.composition.zoom ?? 1).toFixed(1)}×</b> · <b className="text-slate-900">{dims.shotSize}</b>
          </div>
          {onExitComp && (
            <button onClick={onExitComp}
              className="absolute left-1/2 top-4 -translate-x-1/2 rounded-xl border border-white/70 bg-brand px-3.5 py-2 text-[12px] font-medium text-white shadow-md transition hover:opacity-90">
              ✓ Done
            </button>
          )}
        </>
      )}

      {/* Lighting mode HUD: hint + done */}
      {lightMode && (
        <>
          <div className="pointer-events-none absolute left-4 top-4 rounded-xl border border-white/60 bg-white/70 px-3 py-2 text-[12px] text-slate-700 shadow-sm backdrop-blur-md">
            Lighting · drag the <b className="text-amber-500">light source</b> to set its position · use the sliders for intensity / softness / warmth
          </div>
          {onExitLight && (
            <button onClick={onExitLight}
              className="absolute left-1/2 top-4 -translate-x-1/2 rounded-xl border border-white/70 bg-brand px-3.5 py-2 text-[12px] font-medium text-white shadow-md transition hover:opacity-90">
              ✓ Done
            </button>
          )}
        </>
      )}

      {/* Movement mode HUD: pose the camera, click Record frame to drop a keyframe; repeat; then Done */}
      {moveMode && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2">
          <button onClick={addKeyframe}
            className="flex items-center gap-1.5 rounded-xl border border-white/70 bg-white/85 px-3 py-2 text-[12px] font-medium text-slate-700 shadow-md backdrop-blur-md transition hover:bg-white">
            <span className="h-2 w-2 rounded-full bg-[#ef4444]" />
            Record frame
          </button>
          <span className="rounded-xl border border-white/60 bg-white/70 px-3 py-2 text-[12px] font-medium text-slate-600 shadow-md backdrop-blur-md">
            {recPath?.length ?? 0} frame{(recPath?.length ?? 0) === 1 ? '' : 's'}
          </span>
          {recPath && recPath.length > 0 && (
            <button onClick={clearKeyframes}
              className="rounded-xl border border-white/70 bg-white/80 px-3 py-2 text-[12px] font-medium text-slate-600 shadow-md backdrop-blur-md transition hover:bg-white">
              Clear
            </button>
          )}
          {onExitMove && (
            <button onClick={onExitMove}
              className="rounded-xl border border-white/70 bg-brand px-3 py-2 text-[12px] font-medium text-white shadow-md transition hover:opacity-90">
              Done
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Camera gizmo: Blender-style wireframe frustum (lens at the apex + film-gate rectangle + top-orientation triangle), naturally 3D
function camGizmo(cam: V, look: V) {
  const f = look // toward the subject (lens direction)
  const s: V = { x: -look.y, y: look.x } // lateral
  const up: V = { x: 0, y: -1 } // screen up = height direction
  const FR = 42, GW = 20, GH = 14 // frustum length / frame half-width / half-height (enlarged)
  const apex = cam
  const gc: V = { x: apex.x + f.x * FR, y: apex.y + f.y * FR }
  const corner = (sw: number, hw: number): V => ({ x: gc.x + s.x * sw + up.x * hw, y: gc.y + s.y * sw + up.y * hw })
  const gTR = corner(GW, GH), gTL = corner(-GW, GH), gBL = corner(-GW, -GH), gBR = corner(GW, -GH)
  const gate = [gTR, gTL, gBL, gBR]
  const pts = (a: V[]) => a.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const topMid: V = { x: (gTL.x + gTR.x) / 2, y: (gTL.y + gTR.y) / 2 }
  const tri = [gTL, gTR, { x: topMid.x + up.x * 11, y: topMid.y + up.y * 11 }]
  const E = '#e3e9f2', DK = '#0c1018'
  return (
    <g strokeLinejoin="round">
      {/* Faint frustum-face fill */}
      <polygon points={pts([apex, gTR, gBR])} fill="#cdd6e3" opacity={0.07} />
      <polygon points={pts([apex, gTL, gBL])} fill="#cdd6e3" opacity={0.07} />
      <polygon points={pts(gate)} fill="#cdd6e3" opacity={0.1} />
      {/* Dark stroke backing (crisp against busy backgrounds) */}
      {gate.map((p, i) => <line key={'d' + i} x1={apex.x} y1={apex.y} x2={p.x} y2={p.y} stroke={DK} strokeWidth={3} opacity={0.35} />)}
      <polygon points={pts(gate)} fill="none" stroke={DK} strokeWidth={3} opacity={0.35} />
      {/* 4 edges + film-gate */}
      {gate.map((p, i) => <line key={i} x1={apex.x} y1={apex.y} x2={p.x} y2={p.y} stroke={E} strokeWidth={1.6} />)}
      <polygon points={pts(gate)} fill="none" stroke={E} strokeWidth={1.7} />
      {/* Top-orientation triangle */}
      <polygon points={pts(tri)} fill={E} stroke={DK} strokeWidth={0.8} />
      {/* Lens (apex) */}
      <circle cx={apex.x} cy={apex.y} r={8} fill={DK} opacity={0.45} />
      <circle cx={apex.x} cy={apex.y} r={6.6} fill="#1f2733" stroke="#fff" strokeWidth={2.2} />
      <circle cx={apex.x} cy={apex.y} r={2} fill="#cbd5e1" />
    </g>
  )
}

// Draggable axis arrow: soft white backing (crisp on bright backgrounds) + solid cone head + tip handle ball + value label (always shown)
function Arrow({ o, u, len, color, label, value, active, onDown, onEnter, onLeave }: {
  o: V; u: V; len: number; color: string; label: string; value: string; active: boolean
  onDown(e: React.PointerEvent): void; onEnter(): void; onLeave(): void
}) {
  const shaftW = active ? 6.5 : 5.5
  const headLen = active ? 16 : 14
  const headW = active ? 12 : 10
  const ex = o.x + u.x * len, ey = o.y + u.y * len // tip
  const base: V = { x: ex - u.x * headLen, y: ey - u.y * headLen }
  const start: V = o // shaft origin = camera origin (the three axes meet at one point)
  const perp: V = { x: -u.y, y: u.x }
  const h1 = { x: base.x + perp.x * headW, y: base.y + perp.y * headW }
  const h2 = { x: base.x - perp.x * headW, y: base.y - perp.y * headW }
  const headPts = `${ex},${ey} ${h1.x},${h1.y} ${h2.x},${h2.y}`
  const lx = ex + u.x * 16, ly = ey + u.y * 16 + 4
  return (
    <g style={{ cursor: 'grab' }} strokeLinecap="round" strokeLinejoin="round"
      onPointerDown={onDown} onPointerEnter={onEnter} onPointerLeave={onLeave} filter={active ? 'url(#glow)' : undefined}>
      <line x1={o.x} y1={o.y} x2={ex} y2={ey} stroke="#000" strokeOpacity={0} strokeWidth={22} style={{ pointerEvents: 'stroke' }} />
      {/* Soft white backing (glassy look) */}
      <line x1={start.x} y1={start.y} x2={base.x} y2={base.y} stroke="#fff" strokeWidth={shaftW + 4} opacity={0.6} />
      <polygon points={headPts} fill="#fff" opacity={0.6} stroke="#fff" strokeWidth={4} />
      {/* Colored shaft + cone head */}
      <line x1={start.x} y1={start.y} x2={base.x} y2={base.y} stroke={color} strokeWidth={shaftW} />
      <polygon points={headPts} fill={color} stroke={color} strokeWidth={1} />
      {/* Tip handle ball */}
      <circle cx={ex} cy={ey} r={active ? 4.6 : 3.6} fill={color} stroke="#fff" strokeWidth={1.6} />
      {/* Label + value (white outline, readable on bright backgrounds) */}
      <text x={lx} y={ly} fill={color} fontSize={12} fontWeight={700} textAnchor="middle"
        stroke="#fff" strokeWidth={3.5} paintOrder="stroke">{label} {value}</text>
    </g>
  )
}

function FrostCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex min-w-[186px] items-center gap-2 rounded-xl border border-white/60 bg-white/55 px-3 py-2 shadow-sm backdrop-blur-md">
      <div className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-white/70 text-[13px] text-slate-500">{icon}</div>
      <div className="leading-tight">
        <div className="text-[10px] text-slate-500">{label}</div>
        <div className="text-[13px] font-semibold text-slate-800">{value}</div>
      </div>
    </div>
  )
}
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const round1 = (n: number) => Math.round(n * 10) / 10
// Catmull-Rom interpolation of one component through control points a,b,c,d at t∈[0,1] (b→c segment)
const cr = (a: number, b: number, c: number, d: number, t: number) => {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
}
// Continuous subject size from effective distance (piecewise-linear through the shot-size bands),
// so the dolly drag doesn't step between discrete shot sizes
const SIZE_PTS: [number, number][] = [[1.5, 1.9], [3, 1.25], [5, 0.85], [8, 0.55], [15, 0.28], [24, 0.14]]
const sizeRatio = (d: number) => {
  if (d <= SIZE_PTS[0]![0]) return SIZE_PTS[0]![1]
  const last = SIZE_PTS[SIZE_PTS.length - 1]!
  if (d >= last[0]) return last[1]
  for (let i = 0; i < SIZE_PTS.length - 1; i++) {
    const a = SIZE_PTS[i]!, b = SIZE_PTS[i + 1]!
    if (d <= b[0]) return a[1] + (b[1] - a[1]) * ((d - a[0]) / (b[0] - a[0]))
  }
  return last[1]
}
// Scale a hex color's brightness by factor f (for dimming the subject outside the light cone)
const dimHex = (hex: string, f: number) => {
  const n = parseInt(hex.slice(1), 16)
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v * f)))
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`
}
// Continuous light color from warmth: cool blue → neutral → warm amber
const tempColor = (w: number) => {
  const cool = [159, 208, 255], mid = [255, 245, 225], warm = [255, 200, 96]
  const c = (i: number) => (w < 0.5 ? cool[i]! + (mid[i]! - cool[i]!) * (w / 0.5) : mid[i]! + (warm[i]! - mid[i]!) * ((w - 0.5) / 0.5))
  return `rgb(${c(0) | 0}, ${c(1) | 0}, ${c(2) | 0})`
}
