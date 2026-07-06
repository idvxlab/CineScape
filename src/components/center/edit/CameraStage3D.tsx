import { Suspense, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { useTexture, Line, Grid, Edges, Html, OrbitControls } from '@react-three/drei'
import type { SevenDims, Anchor } from '../../../api/types'
import { levelOf, deriveMoveEnd, DIST_MIN, DIST_MAX, SHOT_RINGS, LEVEL_EN } from '../../../lib/dims'
import { orbitMeaning, angleMeaning, shotSizeMeaning } from '../../../lib/semantics'

interface Props {
  backdropUrl: string
  dims: SevenDims
  anchor: Anchor
  compMode?: boolean
  moveMode?: boolean
  lightMode?: boolean
  onExitComp?: () => void
  onExitMove?: () => void
  onExitLight?: () => void
  onDraftChange(p: { dims?: Partial<SevenDims>; anchor?: Partial<Anchor> }): void
  onCommit(): void
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n))
const round1 = (n: number) => Math.round(n * 10) / 10
const WALL_H = 20 // backdrop height (m) — the photo is the dominant element
const WALL_W = (WALL_H * 16) / 9
const LIGHT_R = 14
const DEPTH_MAX = 20 // max subject↔backdrop distance (m)
const SUBJECT_Y = 4.2 // subject torso-center height (camera is eye-level at pitch 0)
const BACKDROP_Z = -14 // the backdrop is FIXED at this world z; the subject stands in front of it (+z)
// subject↔backdrop distance (m) ↔ the visual gap between the subject and the fixed backdrop
const BD_VIS_MIN = 7, BD_VIS_MAX = 24
const bdVis = (depthM: number) => BD_VIS_MIN + (clamp(depthM, 0, DEPTH_MAX) / DEPTH_MAX) * (BD_VIS_MAX - BD_VIS_MIN)
const invBdVis = (v: number) => ((clamp(v, BD_VIS_MIN, BD_VIS_MAX) - BD_VIS_MIN) / (BD_VIS_MAX - BD_VIS_MIN)) * DEPTH_MAX
// the subject's world position on the fixed photo = where the person actually IS in the photo.
// point2d is the normalised position IN THE PHOTO (0..1, y from the top), so map it directly onto the
// photo plane: x ∈ [−WALL_W/2, WALL_W/2], y ∈ [0, WALL_H]. This is the crop centre the viewfinder frames,
// so the person is always in shot when the camera aims at them (focus centred).
function actorPos(anchor: Anchor): THREE.Vector3 {
  const px = ((anchor.point2d?.x ?? 0.5) - 0.5) * WALL_W
  const py = clamp((1 - (anchor.point2d?.y ?? 0.5)) * WALL_H, 1, WALL_H - 1)
  return new THREE.Vector3(px, py, BACKDROP_Z)
}
// Fixed orbit anchor: the camera always orbits the centre of the backdrop wall, completely
// independent of where the actor capsule is placed. The actor and the camera are decoupled —
// dragging the capsule moves the subject on the photo, right-dragging the viewport pans freely.
const WALL_CENTER = new THREE.Vector3(0, SUBJECT_Y, BACKDROP_Z)
// Composition drives the camera, NOT the actor. The actor is FIXED on the photo wall; to place them at
// composition.focus in the frame, the camera's aim centre (what the frame is built around) shifts the
// OPPOSITE way — focus right/up ⇒ aim (and the whole rig) slides left/down, so the actor lands top-right.
// This is the "reframe by moving the camera, never the subject" principle, made literal.
const FOCUS_LAT_MAX = WALL_W / 2 // aim can slide up to half the photo width/height off the actor
const FOCUS_VERT_MAX = WALL_H / 2
// aim centre = actor's wall position shifted opposite to the focus offset, scaled by the on-screen frame size.
function aimCenter(dims: SevenDims, actor: THREE.Vector3): THREE.Vector3 {
  const f = dims.composition.focus ?? { x: 0.5, y: 0.5 }
  // frame half-extents on the actor plane (metres). NOTE: uses the BASE 42° vfov WITHOUT zoom on purpose —
  // focus is "where the subject sits in frame" (a normalised position), so its world anchor must not depend
  // on focal length. Folding zoom in here made the rig drift sideways whenever you changed the lens.
  const halfH = clamp(visR(dims.distanceM) * Math.tan(THREE.MathUtils.degToRad(42) / 2), 0.5, FOCUS_VERT_MAX)
  const halfW = clamp((halfH * 16) / 9, 0.5, FOCUS_LAT_MAX)
  // focus.x > 0.5 (actor right of frame) ⇒ aim left of actor; focus.y > 0.5 (actor low) ⇒ aim above actor
  const dx = -(f.x - 0.5) * 2 * halfW
  const dy = (f.y - 0.5) * 2 * halfH
  return new THREE.Vector3(actor.x + dx, actor.y + dy, actor.z)
}
// Visual orbit radius: compress real Dolly distance (1..26m) into a tighter on-screen radius so the
// photo wall stays the dominant element. Shot Size / the data still use the real distanceM.
const DIST_VIS_MIN = 6
const DIST_VIS_MAX = 22
const visR = (d: number) => DIST_VIS_MIN + ((clamp(d, DIST_MIN, DIST_MAX) - DIST_MIN) / (DIST_MAX - DIST_MIN)) * (DIST_VIS_MAX - DIST_VIS_MIN)
const invVisR = (R: number) => DIST_MIN + ((clamp(R, DIST_VIS_MIN, DIST_VIS_MAX) - DIST_VIS_MIN) / (DIST_VIS_MAX - DIST_VIS_MIN)) * (DIST_MAX - DIST_MIN)

// ---- mappings -------------------------------------------------------------
// lighting.pos (screen azimuth/height, 0..1) ↔ world position on a sphere around the orbit center
function posToWorld(pos: { x: number; y: number }, c: THREE.Vector3): THREE.Vector3 {
  const az = (pos.x - 0.5) * Math.PI
  const el = (1 - pos.y) * (Math.PI / 2) + 0.25
  return new THREE.Vector3(Math.sin(az) * Math.cos(el) * LIGHT_R, Math.max(2, Math.sin(el) * LIGHT_R), Math.cos(az) * Math.cos(el) * LIGHT_R).add(c)
}
function worldToPos(p: THREE.Vector3, c: THREE.Vector3): { x: number; y: number } {
  const d = p.clone().sub(c)
  const el = Math.asin(THREE.MathUtils.clamp(d.y / LIGHT_R, -1, 1))
  const az = Math.atan2(d.x, d.z)
  return { x: THREE.MathUtils.clamp(az / Math.PI + 0.5, 0, 1), y: THREE.MathUtils.clamp(1 - (el - 0.25) / (Math.PI / 2), 0, 1) }
}
function warmColor(w: number) {
  const cool = new THREE.Color('#9fd0ff'), mid = new THREE.Color('#fff4e0'), warm = new THREE.Color('#ffce6a')
  return w < 0.5 ? cool.clone().lerp(mid, w / 0.5) : mid.clone().lerp(warm, (w - 0.5) / 0.5)
}
// Shot camera world position from dims (yaw/pitch/distanceM), on a sphere around the orbit center
function camWorld(dims: SevenDims, c: THREE.Vector3): THREE.Vector3 {
  const theta = THREE.MathUtils.degToRad(dims.angle.yaw)
  const phi = THREE.MathUtils.degToRad(clamp(90 - dims.angle.pitch, 1, 179))
  // no floor anymore — the camera rides the full sphere freely; radius uses the compressed visual scale
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(visR(dims.distanceM), phi, theta)).add(c)
}

// One draggable axis arrow (shaft + head + fat invisible hit cylinder), pointing along `dir` from the gizmo origin
const Y_UP = new THREE.Vector3(0, 1, 0)
function AxisArrow({ dir, length, color, active, onDown, onOver, onOut }: { dir: THREE.Vector3; length: number; color: string; active: boolean; onDown: (e: any) => void; onOver?: () => void; onOut?: () => void }) {
  const q = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.clone().normalize())
  const r = active ? 0.24 : 0.15
  const hover = (e: any) => { e.stopPropagation(); document.body.style.cursor = 'grab'; onOver?.() }
  const out = () => { document.body.style.cursor = 'auto'; onOut?.() }
  return (
    <group quaternion={q}>
      <mesh position={[0, length / 2, 0]} onPointerDown={onDown}>
        <cylinderGeometry args={[r, r, length, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={active ? 0.85 : 0.3} roughness={0.4} toneMapped={false} />
      </mesh>
      <mesh position={[0, length + 0.1, 0]} onPointerDown={onDown}>
        <coneGeometry args={[r * 2.4, 0.9, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={active ? 0.85 : 0.3} roughness={0.4} toneMapped={false} />
      </mesh>
      {/* fat invisible grab volume (also carries hover) */}
      <mesh position={[0, length / 2, 0]} onPointerDown={onDown} onPointerOver={hover} onPointerOut={out}>
        <cylinderGeometry args={[0.55, 0.55, length + 1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}

type Axis = 'orbit' | 'tilt' | 'dolly' | 'rotate' | 'truck' | null
const ORBIT_COL = '#4c8dff', TILT_COL = '#ff5fa2', DOLLY_COL = '#2bd4c4'

// ---- shot-camera gizmo with 3 axes: Orbit (yaw) / Tilt (pitch) / Dolly (distance) ----
function CameraGizmo({ dims, center, onDraftChange, onCommit }: Pick<Props, 'dims' | 'onDraftChange' | 'onCommit'> & { center: THREE.Vector3 }) {
  const controls = useThree((s) => s.controls) as any
  const raycaster = useThree((s) => s.raycaster)
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  const [axis, setAxis] = useState<Axis>(null)
  // last pointer (NDC) for delta-based body rotate (left-drag the body → free orbit + tilt).
  const lastPtr = useRef({ x: 0, y: 0 })
  // truck grab origin: wall-plane hit + focus captured at pointer-down, so right-drag is a stable relative
  // displacement. Trucking the camera == re-composing: sliding the rig right ≡ subject drifts left in frame.
  const truckOrigin = useRef({ hit: new THREE.Vector3(), focus: { x: 0.5, y: 0.5 } })

  useEffect(() => {
    if (!axis) return
    const up = () => {
      setAxis(null)
      if (controls) controls.enabled = true
      onCommit()
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [axis, controls, onCommit])

  useFrame(() => {
    if (!axis) return
    raycaster.setFromCamera(pointer, camera)
    const ray = raycaster.ray
    const yawRad = THREE.MathUtils.degToRad(dims.angle.yaw)
    const radialH = new THREE.Vector3(Math.sin(yawRad), 0, Math.cos(yawRad)) // horizontal radial at current yaw

    if (axis === 'truck') {
      // right-drag the body → truck/pedestal the rig parallel to the wall. Since aimCenter is derived from
      // focus (aim = actor − focus·frame), sliding the camera == re-composing: map the world delta on the
      // wall-parallel plane to a focus delta. Same sign as dragging the subject marker: camera right ⇒
      // subject sits further LEFT in frame ⇒ focus.x down; camera up ⇒ subject lower ⇒ focus.y down.
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -center.z)
      const hit = new THREE.Vector3()
      if (!ray.intersectPlane(plane, hit)) return
      const zoom = dims.composition.zoom ?? 1
      const halfH = clamp(visR(dims.distanceM) * Math.tan(THREE.MathUtils.degToRad(42 / zoom) / 2), 0.5, WALL_H / 2)
      const halfW = (halfH * 16) / 9
      const o = truckOrigin.current
      const fx = clamp(o.focus.x - (hit.x - o.hit.x) / (2 * halfW), 0, 1)
      const fy = clamp(o.focus.y + (hit.y - o.hit.y) / (2 * halfH), 0, 1)
      if (fx !== (dims.composition.focus?.x ?? 0.5) || fy !== (dims.composition.focus?.y ?? 0.5))
        onDraftChange({ dims: { composition: { ...dims.composition, focus: { x: round1(fx), y: round1(fy) }, preset: undefined } } })
    } else if (axis === 'rotate') {
      // left-drag the body → free orbit + tilt. Delta-based (NDC pointer since last frame → degrees),
      // so the camera rotates from where it is instead of snapping under the cursor.
      const dxn = pointer.x - lastPtr.current.x
      const dyn = pointer.y - lastPtr.current.y
      lastPtr.current = { x: pointer.x, y: pointer.y }
      let yaw = Math.round(dims.angle.yaw + dxn * 120) // full-screen drag ≈ 240°
      yaw = ((((yaw + 180) % 360) + 360) % 360) - 180 // wrap to −180..180
      const pitch = clamp(Math.round(dims.angle.pitch + dyn * 120), -89, 89)
      if (yaw !== dims.angle.yaw || pitch !== dims.angle.pitch)
        onDraftChange({ dims: { angle: { ...dims.angle, yaw, pitch, level: levelOf(pitch) } } })
    } else if (axis === 'orbit') {
      // intersect horizontal plane through center → azimuth
      const plane = new THREE.Plane(Y_UP, -center.y)
      const hit = new THREE.Vector3()
      if (!ray.intersectPlane(plane, hit)) return
      const d = hit.sub(center)
      const yaw = Math.round(THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z)))
      if (yaw !== dims.angle.yaw) onDraftChange({ dims: { angle: { ...dims.angle, yaw } } })
    } else if (axis === 'tilt') {
      // intersect the vertical plane containing radial+up → elevation
      const normal = new THREE.Vector3().crossVectors(Y_UP, radialH).normalize()
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center)
      const hit = new THREE.Vector3()
      if (!ray.intersectPlane(plane, hit)) return
      const d = hit.sub(center)
      const horiz = d.dot(radialH)
      const pitch = clamp(Math.round(THREE.MathUtils.radToDeg(Math.atan2(d.y, horiz))), -89, 89)
      if (pitch !== dims.angle.pitch) onDraftChange({ dims: { angle: { ...dims.angle, pitch, level: levelOf(pitch) } } })
    } else {
      // dolly: closest point on the radial line to the pointer ray → distance from center
      const u = camWorld(dims, center).sub(center).normalize()
      const w0 = center.clone().sub(ray.origin)
      const b = u.dot(ray.direction)
      const denom = 1 - b * b
      if (Math.abs(denom) < 1e-4) return
      const t = (b * ray.direction.dot(w0) - u.dot(w0)) / denom // world radius (visual scale)
      const dist = clamp(round1(invVisR(t)), DIST_MIN, DIST_MAX) // back to real Dolly distance
      if (dist !== dims.distanceM) onDraftChange({ dims: { distanceM: dist } })
    }
  })

  const cw = camWorld(dims, center)
  const radialN = cw.clone().sub(center).normalize()
  const orbitT = new THREE.Vector3().crossVectors(Y_UP, radialN).normalize() // horizontal tangent
  const tiltT = new THREE.Vector3().crossVectors(radialN, orbitT).normalize() // pitch tangent (toward up)
  const view = center.clone().sub(cw).normalize()
  const grab = (a: Axis) => (e: any) => {
    if (e.button !== 0) return // only left-drag edits an axis; right-drag falls through to OrbitControls pan
    e.stopPropagation()
    if (controls) controls.enabled = false
    setAxis(a)
  }
  // Grab the camera BODY: LEFT-drag = free orbit + tilt (rotate); RIGHT-drag = truck (slide the rig
  // parallel to the wall, which re-composes — same focus target the subject marker / grid drive).
  const grabBody = (e: any) => {
    if (e.button !== 0 && e.button !== 2) return
    e.stopPropagation()
    if (controls) controls.enabled = false
    if (e.button === 2) {
      raycaster.setFromCamera(pointer, camera)
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -center.z)
      const hit = new THREE.Vector3()
      raycaster.ray.intersectPlane(plane, hit)
      truckOrigin.current = { hit: hit.clone(), focus: { x: dims.composition.focus?.x ?? 0.5, y: dims.composition.focus?.y ?? 0.5 } }
      setAxis('truck')
    } else {
      lastPtr.current = { x: pointer.x, y: pointer.y }
      setAxis('rotate')
    }
  }
  const camQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), view) // local +z faces the subject
  // live drag readout: semantic meaning (prominent) + the raw number (small)
  const readout =
    axis === 'orbit' || axis === 'rotate'
      ? { sem: orbitMeaning(dims.angle.yaw), txt: `Orbit ${dims.angle.yaw}° · Tilt ${dims.angle.pitch}°`, col: ORBIT_COL }
      : axis === 'tilt'
        ? { sem: angleMeaning(dims.angle.pitch), txt: `Tilt ${dims.angle.pitch}° · ${LEVEL_EN[dims.angle.level]}`, col: TILT_COL }
        : axis === 'dolly'
          ? { sem: shotSizeMeaning(dims), txt: `Dolly ${dims.distanceM.toFixed(1)} m · ${dims.shotSize}`, col: DOLLY_COL }
          : axis === 'truck'
            ? { sem: 'Reframe', txt: `Composing · focus ${Math.round((dims.composition.focus?.x ?? 0.5) * 100)}/${Math.round((dims.composition.focus?.y ?? 0.5) * 100)}`, col: '#7fd6ea' }
            : null
  const mid = center.clone().lerp(cw, 0.5)
  return (
    <>
      {readout && (
        <>
          <Line points={[center, cw]} color={readout.col} lineWidth={1.6} dashed dashSize={0.5} gapSize={0.35} transparent opacity={0.9} depthTest={false} renderOrder={7} />
          <DragTag position={mid} color={readout.col} sem={readout.sem} text={readout.txt} />
        </>
      )}
    <group position={cw.toArray()}>
      {/* movie camera, oriented to look at the subject — scaled up for better visibility.
          Drag the body: LEFT = orbit + tilt, RIGHT = truck (slide parallel to the wall). */}
      <group quaternion={camQuat} scale={1.2}>
        {/* body */}
        <mesh
          castShadow
          onPointerDown={grabBody}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'grab' }}
          onPointerOut={() => { if (!axis) document.body.style.cursor = 'auto' }}
        >
          <boxGeometry args={[1.9, 1.45, 2.4]} />
          <meshStandardMaterial color={axis === 'rotate' || axis === 'truck' ? '#d4dde8' : '#b3bdca'} metalness={0.55} roughness={0.32} />
          <Edges color="#e6eef7" />
        </mesh>
        {/* lens hood (toward subject, +z) */}
        <mesh position={[0, 0, 1.45]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.52, 0.62, 0.55, 28]} />
          <meshStandardMaterial color="#141a20" metalness={0.6} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0, 1.9]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.64, 0.64, 0.32, 28]} />
          <meshStandardMaterial color="#0b1015" metalness={0.6} roughness={0.3} />
          <Edges color="#3a4654" />
        </mesh>
        {/* lens glass */}
        <mesh position={[0, 0, 2.08]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.52, 0.52, 0.06, 28]} />
          <meshStandardMaterial color="#a6e3ff" emissive="#4f9fd8" emissiveIntensity={1.0} metalness={0.3} roughness={0.05} toneMapped={false} />
        </mesh>
        {/* two film reels on top */}
        <mesh position={[0, 1.05, -0.38]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.62, 0.62, 0.18, 28]} />
          <meshStandardMaterial color="#2b3540" metalness={0.5} roughness={0.4} />
          <Edges color="#93a2b2" />
        </mesh>
        <mesh position={[0, 1.05, 0.42]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.62, 0.62, 0.18, 28]} />
          <meshStandardMaterial color="#2b3540" metalness={0.5} roughness={0.4} />
          <Edges color="#93a2b2" />
        </mesh>
        {/* viewfinder (top-back) */}
        <mesh position={[0.5, 0.5, -1.05]}>
          <boxGeometry args={[0.42, 0.42, 0.7]} />
          <meshStandardMaterial color="#1c252e" metalness={0.4} roughness={0.4} />
          <Edges color="#5b6b7b" />
        </mesh>
        {/* side handle */}
        <mesh position={[1.0, -0.35, 0]}>
          <boxGeometry args={[0.2, 0.85, 0.5]} />
          <meshStandardMaterial color="#222a32" metalness={0.4} roughness={0.5} />
        </mesh>
        {/* red record tally light */}
        <mesh position={[0, 0.45, 1.22]}>
          <sphereGeometry args={[0.13, 16, 16]} />
          <meshStandardMaterial color="#ff3b3b" emissive="#ff2222" emissiveIntensity={1.3} toneMapped={false} />
        </mesh>
      </group>
      {/* 3 control axes (world-aligned, not rotated with the camera) */}
      <AxisArrow dir={orbitT} length={6} color={ORBIT_COL} active={axis === 'orbit'} onDown={grab('orbit')} />
      <AxisArrow dir={tiltT} length={6} color={TILT_COL} active={axis === 'tilt'} onDown={grab('tilt')} />
      <AxisArrow dir={radialN} length={6} color={DOLLY_COL} active={axis === 'dolly'} onDown={grab('dolly')} />
    </group>
    </>
  )
}

// frosted readout card for the top-left HUD
function FrostCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex min-w-[178px] items-center gap-2 rounded-xl border border-white/15 bg-slate-900/55 px-2.5 py-1.5 shadow-lg backdrop-blur-md">
      <div className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-white/10 text-[13px] text-white/70">{icon}</div>
      <div className="leading-tight">
        <div className="text-[9px] uppercase tracking-wide text-white/45">{label}</div>
        <div className="text-[13px] font-semibold text-white">{value}</div>
      </div>
    </div>
  )
}

// floating tag while dragging an axis — leads with the SEMANTIC meaning, number small underneath
function DragTag({ position, color, sem, text }: { position: THREE.Vector3; color: string; sem: string; text: string }) {
  return (
    <Html position={position.toArray()} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
      <div
        className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-center shadow-lg"
        style={{ background: 'rgba(10,14,20,0.85)', border: `1px solid ${color}`, backdropFilter: 'blur(4px)' }}
      >
        <div className="text-[13px] font-bold text-white">{sem}</div>
        <div className="text-[10px] text-white/55">{text}</div>
      </div>
    </Html>
  )
}

// ---- draggable sun --------------------------------------------------------
function SunGizmo({ lighting, center, onDraftChange, onCommit }: Pick<Props, 'onDraftChange' | 'onCommit'> & { lighting: SevenDims['lighting']; center: THREE.Vector3 }) {
  const pos = lighting.pos ?? { x: 0.5, y: 0.18 }
  const controls = useThree((s) => s.controls) as any
  const raycaster = useThree((s) => s.raycaster)
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  const [drag, setDrag] = useState(false)
  const color = warmColor(lighting.temperature ?? 0.5)

  useEffect(() => {
    if (!drag) return
    const up = () => {
      setDrag(false)
      if (controls) controls.enabled = true
      onCommit()
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [drag, controls, onCommit])

  useFrame(() => {
    if (!drag) return
    raycaster.setFromCamera(pointer, camera)
    const ro = raycaster.ray.origin, rd = raycaster.ray.direction
    const oc = ro.clone().sub(center)
    const b = oc.dot(rd), c = oc.dot(oc) - LIGHT_R * LIGHT_R
    const disc = b * b - c
    if (disc < 0) return
    const t1 = -b - Math.sqrt(disc)
    const t = t1 > 0 ? t1 : -b + Math.sqrt(disc)
    if (t < 0) return
    const hit = ro.clone().add(rd.clone().multiplyScalar(t))
    onDraftChange({ dims: { lighting: { ...lighting, pos: worldToPos(hit, center) } } })
  })

  const p = posToWorld(pos, center)
  // beam cone from the light toward the subject — width = spread (spot↔flood), opacity = intensity
  const spread = lighting.spread ?? 0.4
  const softness = lighting.softness ?? 0.5 // 0 = hard (small crisp source) → 1 = soft (big diffuse source)
  const intensity = (lighting.keyPct ?? 60) / 100
  const dir = center.clone().sub(p).normalize()
  const length = Math.max(0.5, p.distanceTo(center))
  const halfA = THREE.MathUtils.degToRad(6 + spread * 74)
  const baseR = Math.max(0.25, Math.tan(halfA) * length)
  const mid = p.clone().addScaledVector(dir, length / 2)
  const coneQuat = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.clone().negate()) // apex at the light, base at the subject
  // hard light = small intense source + crisp concentrated beam; soft = large diffuse source + feathered spill
  const srcR = 0.4 + softness * 0.95
  const haloR = srcR + 0.3 + softness * 1.8
  return (
    <>
      {/* core beam — crisp & concentrated for hard light */}
      <mesh position={mid.toArray()} quaternion={coneQuat}>
        <coneGeometry args={[baseR, length, 44, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={(0.06 + intensity * 0.22) * (1 - softness * 0.45)} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
      {/* feathered spill — only soft light, a wider faint halo cone with blurry edges */}
      {softness > 0.05 && (
        <mesh position={mid.toArray()} quaternion={coneQuat}>
          <coneGeometry args={[baseR * (1 + softness * 0.7), length, 44, 1, true]} />
          <meshBasicMaterial color={color} transparent opacity={softness * (0.04 + intensity * 0.1)} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      {/* core ray light→subject — thin/bright when hard, wide/soft when soft */}
      <Line points={[p, center]} color={color} lineWidth={1 + (1 - softness) * 2} dashed dashSize={0.5} gapSize={0.3 + softness * 0.5} transparent opacity={(0.4 + intensity * 0.45) * (1 - softness * 0.4)} depthTest={false} renderOrder={5} />
      {/* draggable light source — size grows with softness (point source ↔ big diffuse panel) */}
      <group position={p.toArray()}>
        <mesh
          onPointerDown={(e) => {
            if (e.button !== 0) return // only left-drag moves the sun; right-drag falls through to OrbitControls pan
            e.stopPropagation()
            if (controls) controls.enabled = false
            setDrag(true)
          }}
        >
          <sphereGeometry args={[srcR, 28, 28]} />
          <meshBasicMaterial color={color} transparent opacity={1 - softness * 0.45} toneMapped={false} />
        </mesh>
        {/* soft diffuse glow — larger & fainter the softer the light */}
        <mesh>
          <sphereGeometry args={[haloR, 28, 28]} />
          <meshBasicMaterial color={color} transparent opacity={0.08 + softness * 0.16} toneMapped={false} depthWrite={false} />
        </mesh>
      </group>
    </>
  )
}

// ---- tilt arc: vertical pitch orbit the camera rides up/down --------------
function TiltArc({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const yawRad = THREE.MathUtils.degToRad(dims.angle.yaw)
  const radialH = new THREE.Vector3(Math.sin(yawRad), 0, Math.cos(yawRad))
  const r = visR(dims.distanceM)
  const pts: THREE.Vector3[] = []
  for (let a = -85; a <= 85; a += 3) {
    const ar = THREE.MathUtils.degToRad(a)
    pts.push(center.clone().add(radialH.clone().multiplyScalar(Math.cos(ar) * r)).add(new THREE.Vector3(0, Math.sin(ar) * r, 0)))
  }
  return <Line points={pts} color={TILT_COL} lineWidth={4.5} transparent opacity={0.95} depthTest={false} renderOrder={5} />
}

// pose (yaw/pitch/dist) → world position around the orbit center
function poseToWorld(p: { yaw: number; pitch: number; dist: number }, c: THREE.Vector3): THREE.Vector3 {
  const theta = THREE.MathUtils.degToRad(p.yaw)
  const phi = THREE.MathUtils.degToRad(clamp(90 - p.pitch, 1, 179))
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(visR(p.dist), phi, theta)).add(c)
}

// ---- camera-movement trajectory --------------------------------------------
// Recorded keyframes (Record button) → Catmull-Rom spline; else preset end pose
function MovePath({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const path = dims.movement.path
  if (path && path.length >= 1) {
    const kfW = path.map((p) => poseToWorld({ yaw: p.yaw, pitch: p.pitch, dist: p.dist }, center))
    let curvePts: THREE.Vector3[] = []
    if (kfW.length >= 2) curvePts = new THREE.CatmullRomCurve3(kfW).getPoints(Math.max(24, kfW.length * 16))
    return (
      <>
        {curvePts.length > 0 && <Line points={curvePts} color="#ffd24a" lineWidth={2.5} transparent opacity={0.9} depthTest={false} renderOrder={5} />}
        {kfW.map((w, i) => (
          <mesh key={i} position={w.toArray()} renderOrder={5}>
            <boxGeometry args={[0.9, 0.7, 1.05]} />
            <meshBasicMaterial color={i === 0 ? '#7CFC9E' : i === kfW.length - 1 ? '#ff8a5b' : '#ffd24a'} transparent opacity={0.5} toneMapped={false} depthTest={false} depthWrite={false} />
          </mesh>
        ))}
      </>
    )
  }
  // preset fallback (Dolly/Pan/… auto-derive a single end pose)
  const start = { yaw: dims.angle.yaw, pitch: dims.angle.pitch, dist: dims.distanceM }
  const end = deriveMoveEnd(dims.movement.type, start)
  if (!end) return null
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const pts: THREE.Vector3[] = []
  for (let t = 0; t <= 1.0001; t += 0.04) pts.push(poseToWorld({ yaw: lerp(start.yaw, end.yaw, t), pitch: lerp(start.pitch, end.pitch, t), dist: lerp(start.dist, end.dist, t) }, center))
  return (
    <>
      <Line points={pts} color="#ffd24a" lineWidth={2.5} transparent opacity={0.9} depthTest={false} renderOrder={5} />
      <mesh position={poseToWorld(end, center).toArray()} renderOrder={5}>
        <boxGeometry args={[1.1, 0.85, 1.3]} />
        <meshBasicMaterial color="#ffd24a" transparent opacity={0.4} toneMapped={false} depthTest={false} depthWrite={false} />
      </mesh>
    </>
  )
}

// ---- view frustum: the camera's framing on the wall plane (zoom changes its size) ----
// In composition mode it also draws a rule-of-thirds 3×3 grid inside the frame.
function ViewFrustum({ dims, center, compMode = false }: { dims: SevenDims; center: THREE.Vector3; compMode?: boolean }) {
  const cw = camWorld(dims, center)
  const viewDir = center.clone().sub(cw).normalize()
  const dist = cw.distanceTo(center)
  const zoom = dims.composition.zoom ?? 1
  const vfov = THREE.MathUtils.degToRad(42 / zoom)
  const halfH = dist * Math.tan(vfov / 2)
  const halfW = (halfH * 16) / 9
  const right = new THREE.Vector3().crossVectors(viewDir, Y_UP).normalize()
  const upv = new THREE.Vector3().crossVectors(right, viewDir).normalize()
  const corner = (sx: number, sy: number) => center.clone().addScaledVector(right, sx * halfW).addScaledVector(upv, sy * halfH)
  const tl = corner(-1, 1), tr = corner(1, 1), br = corner(1, -1), bl = corner(-1, -1)
  const COL = compMode ? '#ffffff' : '#9fe8ff'
  // rule-of-thirds: two verticals at sx=±1/3, two horizontals at sy=±1/3
  const thirds: [THREE.Vector3, THREE.Vector3][] = [
    [corner(-1 / 3, 1), corner(-1 / 3, -1)],
    [corner(1 / 3, 1), corner(1 / 3, -1)],
    [corner(-1, 1 / 3), corner(1, 1 / 3)],
    [corner(-1, -1 / 3), corner(1, -1 / 3)],
  ]
  return (
    <>
      <Line points={[tl, tr, br, bl, tl]} color={COL} lineWidth={compMode ? 3 : 2.5} transparent opacity={compMode ? 0.95 : 0.8} depthTest={false} renderOrder={5} />
      {/* 3×3 grid — always faint, emphasised in composition mode */}
      {thirds.map((seg, i) => (
        <Line key={i} points={seg} color={COL} lineWidth={1.2} transparent opacity={compMode ? 0.5 : 0.22} depthTest={false} renderOrder={5} />
      ))}
      {!compMode && (
        <>
          <Line points={[cw, tl]} color={COL} lineWidth={1.5} transparent opacity={0.4} depthTest={false} renderOrder={5} />
          <Line points={[cw, tr]} color={COL} lineWidth={1.5} transparent opacity={0.4} depthTest={false} renderOrder={5} />
          <Line points={[cw, br]} color={COL} lineWidth={1.5} transparent opacity={0.4} depthTest={false} renderOrder={5} />
          <Line points={[cw, bl]} color={COL} lineWidth={1.5} transparent opacity={0.4} depthTest={false} renderOrder={5} />
        </>
      )}
    </>
  )
}

// ---- orbit ring anchored to the photo wall --------------------------------
// Centre sits on the backdrop at the actor's x/y; only the front semicircle
// (protruding toward the viewer, z > BACKDROP_Z) is drawn — the back half is
// literally inside/behind the wall and invisible. The ring grows with visR
// (dolly distance), so pulling the camera back makes the arc bigger.
function CameraRing({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const r = visR(dims.distanceM)
  const yaw = THREE.MathUtils.degToRad(dims.angle.yaw)
  const frontArc = (() => {
    const pts: THREE.Vector3[] = []
    for (let a = -90; a <= 90; a += 3) {
      const ar = THREE.MathUtils.degToRad(a)
      pts.push(new THREE.Vector3(Math.sin(ar) * r, 0, Math.cos(ar) * r))
    }
    return pts
  })()
  // short tick marks where the semicircle meets the wall (a = ±90°, x = ±r, z = 0)
  const tick = (x: number): THREE.Vector3[] => [new THREE.Vector3(x - 0.55, 0, 0), new THREE.Vector3(x + 0.55, 0, 0)]
  const reverse = Math.cos(yaw) < 0 // camera currently in the reverse-view half
  return (
    <group position={center.toArray()}>
      {/* front semicircle — the only visible half; solid blue-grey */}
      <Line points={frontArc} color="#a9bccd" lineWidth={3.4} transparent opacity={0.95} depthTest={false} renderOrder={5} />
      {/* ticks at the wall-plane boundary (semicircle endpoints) */}
      <Line points={tick(r)} color="#eef2f6" lineWidth={2.6} transparent opacity={0.85} depthTest={false} renderOrder={6} />
      <Line points={tick(-r)} color="#eef2f6" lineWidth={2.6} transparent opacity={0.85} depthTest={false} renderOrder={6} />
      {/* current-yaw marker — only visible when camera is in the front half */}
      {!reverse && (
        <mesh position={[Math.sin(yaw) * r, 0, Math.cos(yaw) * r]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
          <circleGeometry args={[0.45, 24]} />
          <meshBasicMaterial color="#7CFC9E" transparent opacity={0.95} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

// ---- shot-size reference arcs: faint dashed semicircles at each shot size's radius + label ----
// Same convention as CameraRing: centred on the backdrop wall, only the front semicircle shown.
function ShotRings({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const frontArc = (r: number) => {
    const pts: THREE.Vector3[] = []
    for (let a = -90; a <= 90; a += 4) {
      const ar = THREE.MathUtils.degToRad(a)
      pts.push(new THREE.Vector3(Math.sin(ar) * r, 0, Math.cos(ar) * r))
    }
    return pts
  }
  return (
    <group position={center.toArray()}>
      {SHOT_RINGS.map((ring) => {
        const r = visR(ring.r)
        const on = dims.shotSize === ring.size
        return (
          <group key={ring.size}>
            <Line points={frontArc(r)} color={on ? '#7fd6ea' : '#5b8aa6'} lineWidth={on ? 1.6 : 1} dashed dashSize={0.35} gapSize={0.4} transparent opacity={on ? 0.7 : 0.4} depthTest={false} renderOrder={1} />
            <Html position={[r + 0.3, 0, 0]} center={false} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="whitespace-nowrap text-[10px] font-medium" style={{ color: on ? '#9fe0f2' : 'rgba(159,198,224,0.6)' }}>
                {ring.size}
              </div>
            </Html>
          </group>
        )
      })}
    </group>
  )
}

// ---- lighting → real 3D directional light aimed at the center -------------
function SceneLight({ lighting, center }: { lighting: SevenDims['lighting']; center: THREE.Vector3 }) {
  const pos = lighting.pos ?? { x: 0.5, y: 0.18 }
  const intensity = (lighting.keyPct ?? 60) / 100
  const soft = lighting.softness ?? 0.5
  const ref = useRef<THREE.DirectionalLight>(null)
  const target = useRef(new THREE.Object3D())
  useEffect(() => {
    target.current.position.copy(center)
    target.current.updateMatrixWorld()
    if (ref.current) ref.current.target = target.current
  }, [center])
  return (
    <>
      <primitive object={target.current} />
      <directionalLight
        ref={ref}
        position={posToWorld(pos, center).toArray()}
        intensity={0.5 + intensity * 1.6}
        color={warmColor(lighting.temperature ?? 0.5)}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={2 + soft * 12}
        shadow-bias={-0.0005}
      />
    </>
  )
}

// ---- standing photo backdrop: FIXED in the world, behind the subject along world −z.
//      The camera orbits the subject freely; a front shot frames the subject against the backdrop,
//      while a reverse angle swings the rig to the far side and the backdrop leaves the frame
//      (exactly as a fixed set wall behaves — so reverse shots are possible). --
function BackdropWall({ url, reverse = false }: { url: string; reverse?: boolean }) {
  // give the WebGL texture its own URL (a distinct cache key) so it does a fresh CORS fetch instead of
  // reusing a non-CORS cached copy left by an <img> tag (which would fail the crossOrigin texture load).
  const texUrl = url.startsWith('data:') ? url : `${url}${url.includes('?') ? '&' : '?'}tex=1`
  const tex = useTexture(texUrl)
  // truly fixed in the world: the subject walks relative to it (depthM = their gap)
  const pos: [number, number, number] = [0, 0, BACKDROP_Z]
  // in the reverse-view region the photo is no longer the background — keep it in place but drop to ~25%
  // so it reads only as a spatial reference, not a backdrop.
  const photoOp = reverse ? 0.25 : 0.62
  return (
    <group position={pos}>
      {/* ground contact line so it reads as standing on the floor */}
      <mesh position={[0, 0.02, 0.15]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[WALL_W * 1.04, 1.6]} />
        <meshBasicMaterial color="#05080d" transparent opacity={reverse ? 0.15 : 0.35} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* frame */}
      <mesh position={[0, WALL_H / 2, -0.08]}>
        <planeGeometry args={[WALL_W + 0.5, WALL_H + 0.5]} />
        <meshBasicMaterial color="#aeb9c9" transparent opacity={reverse ? 0.3 : 0.85} side={THREE.DoubleSide} />
      </mesh>
      {/* photo */}
      <mesh position={[0, WALL_H / 2, 0]}>
        <planeGeometry args={[WALL_W, WALL_H]} />
        <meshBasicMaterial map={tex} transparent opacity={photoOp} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* dark scrim — only in the normal zone (lifts contrast for the neon gizmos); skipped in reverse */}
      {!reverse && (
        <mesh position={[0, WALL_H / 2, 0.01]} renderOrder={0}>
          <planeGeometry args={[WALL_W, WALL_H]} />
          <meshBasicMaterial color="#05080d" transparent opacity={0.42} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

// ---- reverse-background container: when shooting from the reverse side, the photo is behind the camera,
//      so the subject's actual background is the OTHER side (+z). We don't place a second photo there —
//      just a very restrained frosted/dashed domain as a placeholder, with a label. Shown only in reverse. --
function ReverseBackdrop({ anchor, center }: { anchor: Anchor; center: THREE.Vector3 }) {
  const bd = bdVis(anchor.depthM ?? 8.5)
  const pos: [number, number, number] = [center.x, 0, center.z + bd] // mirror of the real backdrop, on the +z side
  const halfW = WALL_W / 2, h = WALL_H
  const rect: THREE.Vector3[] = [
    new THREE.Vector3(-halfW, 0.05, 0), new THREE.Vector3(halfW, 0.05, 0),
    new THREE.Vector3(halfW, h, 0), new THREE.Vector3(-halfW, h, 0), new THREE.Vector3(-halfW, 0.05, 0),
  ]
  return (
    <group position={pos}>
      {/* faint frosted fill */}
      <mesh position={[0, h / 2, 0]}>
        <planeGeometry args={[WALL_W, h]} />
        <meshBasicMaterial color="#aab2bc" transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* dashed domain outline */}
      <Line points={rect} color="#c9d0d8" lineWidth={1.4} dashed dashSize={0.6} gapSize={0.5} transparent opacity={0.5} depthTest={false} renderOrder={3} />
      <Html position={[0, h * 0.62, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-md border border-white/25 bg-black/35 px-2 py-1 text-[11px] font-medium tracking-wide text-white/75 backdrop-blur">
          Reverse BG
        </div>
      </Html>
    </group>
  )
}

// the camera frame's right/up basis + half-extents at the orbit-center distance.
// The camera always looks at its aim centre (the orbit anchor, incl. any truck offset), NOT the
// actor — so the frame orientation depends only on camera pose, not on where the actor stands.
function frameBasis(dims: SevenDims, center: THREE.Vector3) {
  const cw = camWorld(dims, center)
  const view = center.clone().sub(cw).normalize()
  const right = new THREE.Vector3().crossVectors(view, Y_UP).normalize()
  const up = new THREE.Vector3().crossVectors(right, view).normalize()
  const dist = cw.distanceTo(center)
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(42 / (dims.composition.zoom ?? 1)) / 2)
  return { view, right, up, halfW: (halfH * 16) / 9, halfH }
}

// ---- draggable subject (the actor) -------------------------------------------
// Drag the capsule to MOVE THE PERSON on the photo (anchor.point2d). The capsule follows the cursor and
// the CAMERA STAYS PUT — the person just shifts within the frame. We hold the camera fixed by updating
// composition.focus to the person's new in-frame position (so the focus-derived aim centre is unchanged).
// Effect: moving the person reframes nothing; later composition edits then work off the new position.
function SubjectGizmo({ dims, onDraftChange, onCommit, center, aim }: Pick<Props, 'dims' | 'onDraftChange' | 'onCommit'> & { center: THREE.Vector3; aim: THREE.Vector3 }) {
  const controls = useThree((s) => s.controls) as any
  const raycaster = useThree((s) => s.raycaster)
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  const [drag, setDrag] = useState(false)
  const [hover, setHover] = useState(false)
  // camera aim centre captured at grab — we keep aim FIXED during the drag so the camera doesn't follow.
  const aim0 = useRef(new THREE.Vector3())
  // The capsule sits at the actor's world position and follows the cursor while dragging.
  const sp = center

  useEffect(() => {
    if (!drag) return
    const up = () => {
      setDrag(false)
      if (controls) controls.enabled = true
      document.body.style.cursor = 'auto'
      onCommit()
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [drag, controls, onCommit])

  useFrame(() => {
    if (!drag) return
    raycaster.setFromCamera(pointer, camera)
    // drag on the photo plane; the hit point IS the person's new position → back to normalised point2d.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -center.z)
    const hit = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(plane, hit)) return
    const px = clamp(hit.x / WALL_W + 0.5, 0, 1)        // world x ∈ [−W/2,W/2] → 0..1
    const py = clamp(1 - hit.y / WALL_H, 0, 1)          // world y ∈ [0,H] → 1..0 (point2d.y is top-down)
    // hold the camera fixed: choose focus so aimCenter(new actor, focus) == aim0 (base 42° frame, no zoom,
    // matching aimCenter). aim = actor + dx/dy where dx=−(fx−.5)·2halfW, dy=(fy−.5)·2halfH.
    // FULL PRECISION on purpose — rounding point2d/focus here (they span 0..1, so round1 ≈ several metres)
    // breaks the aim==aim0 cancellation and the camera jitters/drifts. Round only at commit if needed.
    const halfH = clamp(visR(dims.distanceM) * Math.tan(THREE.MathUtils.degToRad(42) / 2), 0.5, FOCUS_VERT_MAX)
    const halfW = clamp((halfH * 16) / 9, 0.5, FOCUS_LAT_MAX)
    const fx = 0.5 - (aim0.current.x - hit.x) / (2 * halfW)
    const fy = 0.5 + (aim0.current.y - hit.y) / (2 * halfH)
    onDraftChange({
      anchor: { point2d: { x: px, y: py } },
      dims: { composition: { ...dims.composition, focus: { x: fx, y: fy }, preset: undefined } },
    })
  })

  const grabBody = (e: any) => {
    if (e.button !== 0) return // left-drag moves the person; right-drag falls through to OrbitControls pan
    e.stopPropagation()
    if (controls) controls.enabled = false
    aim0.current.copy(aim) // lock the camera aim so it stays put while the person moves
    setDrag(true)
  }
  const on = drag || hover
  // aim marker: a faint reticle at the camera's aim centre so the "camera framed off the subject" is visible
  const aimOff = aim.clone().sub(center)
  const showAim = aimOff.lengthSq() > 0.04
  return (
    <>
      {/* the actor marker — FIXED on the wall at the person's position (never moves) */}
      <group position={sp.toArray()}>
        <mesh
          onPointerDown={grabBody}
          onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'grab' }}
          onPointerOut={() => { setHover(false); if (!drag) document.body.style.cursor = 'auto' }}
          castShadow
        >
          <capsuleGeometry args={[0.32, 1.0, 8, 16]} />
          <meshStandardMaterial color={on ? '#ffd76a' : '#e8a23a'} emissive="#5a3c00" emissiveIntensity={hover ? 0.5 : 0} roughness={0.5} depthWrite />
        </mesh>
      </group>
      {/* ground footprint marker so the actor's position on the wall reads on the floor */}
      <mesh position={[sp.x, 0.03, sp.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <ringGeometry args={[0.55, 0.75, 32]} />
        <meshBasicMaterial color="#ffb347" transparent opacity={0.8} side={THREE.DoubleSide} depthTest={false} />
      </mesh>
      {/* aim reticle + link line: shows the camera has trucked off the subject to compose */}
      {showAim && (
        <>
          <Line points={[center, aim]} color="#7fd6ea" lineWidth={1.4} dashed dashSize={0.4} gapSize={0.3} transparent opacity={0.7} depthTest={false} renderOrder={6} />
          <mesh position={aim.toArray()} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
            <ringGeometry args={[0.32, 0.46, 28]} />
            <meshBasicMaterial color="#7fd6ea" transparent opacity={0.85} side={THREE.DoubleSide} depthTest={false} />
          </mesh>
        </>
      )}
    </>
  )
}

// ---- viewfinder: what the camera frames; background shifts with the camera VIEW (like a real lens) ----
function Viewfinder({ backdropUrl, dims, anchor }: { backdropUrl: string; dims: SevenDims; anchor: Anchor }) {
  const dof = dims.focal?.dof ?? 0.5
  const bgBlur = (1 - dof) * 7 // shallow DoF → blurred background
  // color.saturation / contrast are −50..50 → CSS saturate()/contrast() multipliers around 1.0
  const sat = clamp(1 + (dims.color?.saturation ?? 0) / 100, 0.3, 1.7)
  const con = clamp(1 + (dims.color?.contrast ?? 0) / 100, 0.6, 1.5)
  const look = (dims.color?.look ?? '').toLowerCase()
  // gentle grade tint (soft-light blend, lower opacity) so it reads as a colour grade, not a wash
  const tint = look.includes('cool') ? 'rgba(70,120,190,0.28)' : look.includes('warm') ? 'rgba(220,150,70,0.28)' : look.includes('teal') ? 'rgba(40,150,150,0.24)' : look.includes('noir') || look.includes('mono') ? 'rgba(20,22,30,0.34)' : look.includes('film') ? 'rgba(150,130,90,0.20)' : 'transparent'
  const lp = dims.lighting.pos ?? { x: 0.5, y: 0.2 }
  const key = (dims.lighting.keyPct ?? 60) / 100
  const warm = dims.lighting.temperature ?? 0.5
  const lightCol = warm < 0.5 ? '210,228,255' : '255,236,200'
  // subtle key-light wash + soft vignette: low key = moody/dark edges, high key = bright/clean
  const lightOverlay = `radial-gradient(135% 135% at ${lp.x * 100}% ${lp.y * 100}%, rgba(${lightCol},${0.05 + key * 0.12}) 0%, rgba(0,0,0,${0.06 + (1 - key) * 0.2}) 82%)`
  // The viewfinder is a straight CROP of the fixed photo — no drawn subject. The photo is a fixed plane in
  // the world; the camera frame projects onto it, and we show exactly the photo region inside that frame.
  // Move the rig / compose off-centre → the crop pans across the photo (the subject, being part of the
  // photo, moves with it). Frame wider than the photo → the photo doesn't fill the finder and black shows.
  const aCenter = actorPos(anchor)
  const aimC = aimCenter(dims, aCenter)
  const cam = camWorld(dims, aimC)
  // project the camera frame onto the fixed photo plane (z = BACKDROP_Z). frameBasis gives the frame's
  // half-extents there (metres). The photo occupies x∈[−WALL_W/2, WALL_W/2], y∈[0, WALL_H].
  const { halfW: fHW, halfH: fHH } = frameBasis(dims, aimC)
  const dir = aimC.clone().sub(cam).normalize()
  const hitS = Math.abs(dir.z) > 1e-3 ? (BACKDROP_Z - cam.z) / dir.z : -1
  const bgVisible = hitS > 0
  const ctr = cam.clone().addScaledVector(dir, hitS) // frame centre on the photo plane
  // Place the photo as an absolutely-positioned image inside the finder (exact geometry — avoids the CSS
  // background-position percentage trap when the photo is smaller than the frame). Finder-left maps to
  // world x = ctr.x − fHW, finder-top to world y = ctr.y + fHH. Everything the photo doesn't cover is black.
  const imgLeft = ((-WALL_W / 2 - (ctr.x - fHW)) / (2 * fHW)) * 100
  const imgTop = (((ctr.y + fHH) - WALL_H) / (2 * fHH)) * 100
  const imgW = (WALL_W / (2 * fHW)) * 100
  const imgH = (WALL_H / (2 * fHH)) * 100
  // the SUBJECT is an independent element (the boy), NOT part of the backdrop photo. Project the fixed
  // actor position into the camera frame → its silhouette position + size in the finder. Since aim is
  // derived from focus, the actor lands at `focus`; distance sets how tall it reads (near = large).
  const SUBJECT_H = 3.4 // subject world height (m) — tuned so a medium shot frames head-to-waist
  const silX = clamp(0.5 + (aCenter.x - ctr.x) / (2 * fHW), -0.2, 1.2) * 100
  const silY = clamp(0.5 - (aCenter.y - ctr.y) / (2 * fHH), -0.2, 1.2) * 100
  const silH = clamp((SUBJECT_H / (2 * fHH)) * 100, 8, 220) // % of finder height
  const silW = silH * 0.42 // silhouette aspect
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 overflow-hidden rounded-lg border border-white/25 bg-black shadow-2xl" style={{ width: '18rem', aspectRatio: '16 / 9' }}>
      {bgVisible ? (
        <img
          src={backdropUrl}
          alt=""
          className="absolute max-w-none"
          style={{ left: `${imgLeft}%`, top: `${imgTop}%`, width: `${imgW}%`, height: `${imgH}%`, filter: `blur(${bgBlur}px) saturate(${sat}) contrast(${con})` }}
        />
      ) : (
        // reverse angle — the photo is behind the camera; nothing of the photo is framed. Plain black.
        <div className="absolute inset-0 bg-black">
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-medium tracking-wide text-white/45">No backdrop (reverse angle)</div>
        </div>
      )}
      {/* the SUBJECT — an independent element projected into the frame (not part of the backdrop photo) */}
      <div className="absolute" style={{ left: `${silX}%`, top: `${silY}%`, width: `${silW}%`, height: `${silH}%`, transform: 'translate(-50%, -50%)' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="h-full w-full" style={{ filter: `blur(${(1 - dof) * 1.1}px)` }}>
          <path d="M50 6 a17 17 0 1 1 -0.1 0 Z M16 100 q0 -48 34 -48 q34 0 34 48 Z" fill="#0e1722" opacity={0.9} />
        </svg>
      </div>
      {tint !== 'transparent' && <div className="absolute inset-0" style={{ background: tint, mixBlendMode: 'soft-light' }} />}
      {(() => {
        const tn = dims.color?.tint ?? 0
        if (!tn) return null
        const bg = tn < 0 ? `rgba(70,200,100,${Math.min(0.4, (Math.abs(tn) / 50) * 0.4)})` : `rgba(220,70,200,${Math.min(0.4, (tn / 50) * 0.4)})`
        return <div className="absolute inset-0" style={{ background: bg, mixBlendMode: 'soft-light' }} />
      })()}
      <div className="absolute inset-0" style={{ background: lightOverlay }} />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 56" preserveAspectRatio="none">
        {[1 / 3, 2 / 3].map((f) => (
          <line key={`v${f}`} x1={f * 100} y1={0} x2={f * 100} y2={56} stroke="#fff" strokeWidth={0.3} opacity={0.25} />
        ))}
        {[1 / 3, 2 / 3].map((f) => (
          <line key={`h${f}`} x1={0} y1={f * 56} x2={100} y2={f * 56} stroke="#fff" strokeWidth={0.3} opacity={0.25} />
        ))}
      </svg>
      <div className="absolute left-1.5 top-1 rounded bg-black/45 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-white/85 backdrop-blur">
        VIEWFINDER · {dims.shotSize}
      </div>
    </div>
  )
}

export function CameraStage3D({ backdropUrl, dims, anchor, compMode = false, moveMode = false, lightMode = false, onExitComp, onExitMove, onExitLight, onDraftChange, onCommit }: Props) {
  // No custom contextmenu handler — Drei OrbitControls handles it internally
  // in its own useEffect, which fires at the correct time.
  // actor position on the backdrop wall (for SubjectGizmo, SceneLight, ReverseBackdrop)
  const center = actorPos(anchor)
  // the camera's aim/orbit centre is DERIVED from composition.focus: to frame the (fixed) actor at
  // focus, the camera slides opposite. All camera-side geometry (gizmo, rings, tilt arc, frustum, path)
  // orbits THIS point, so changing focus — via grid, capsule, or right-drag — physically moves the rig.
  const aim = aimCenter(dims, center)
  // reverse-view region: camera has crossed to the far side of the subject (photo now behind the lens)
  const reverse = Math.cos(THREE.MathUtils.degToRad(dims.angle.yaw)) < 0
  const path = dims.movement.path ?? []
  const recordKeyframe = () => {
    const kf = { yaw: dims.angle.yaw, dist: dims.distanceM, pitch: dims.angle.pitch }
    onDraftChange({ dims: { movement: { ...dims.movement, type: 'Custom', path: [...path, kf] } } })
    onCommit()
  }
  const undoKeyframe = () => {
    onDraftChange({ dims: { movement: { ...dims.movement, path: path.slice(0, -1) } } })
    onCommit()
  }
  const clearPath = () => {
    onDraftChange({ dims: { movement: { ...dims.movement, type: 'Static', path: [] } } })
    onCommit()
  }
  return (
    // Suppress the browser context menu so right-drag (truck on the camera body, pan on empty space)
    // never pops a menu — OrbitControls only blocks it while enabled, and body-truck disables it.
    <div className="absolute inset-0 overflow-hidden rounded-xl bg-black" onContextMenu={(e) => e.preventDefault()}>
      <Canvas
        shadows
        camera={{ position: [7, 11, 27], fov: 46 }}
        // Prevent Safari/Firefox from handling pointer events as gestures, ensuring
        // OrbitControls receives all right-down/right-move/right-up for Pan.
        style={{ touchAction: 'none' }}
      >
        <color attach="background" args={['#060708']} />
        <fog attach="fog" args={['#060708', 70, 160]} />
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#cfd9e6', '#3a4048', 0.6]} />
        <SceneLight lighting={dims.lighting} center={center} />
        {/* grid sits on the orbit-ring plane (WALL_CENTER.y), so the ring lies on the grid */}
        <Grid
          position={[0, WALL_CENTER.y + 0.02, 0]}
          args={[DIST_MAX * 2 + 4, DIST_MAX * 2 + 4]}
          cellSize={2}
          cellThickness={0.6}
          cellColor="#6f93ab"
          sectionSize={10}
          sectionThickness={1}
          sectionColor="#9fc6e0"
          fadeDistance={DIST_MAX * 3}
          fadeStrength={1}
          side={THREE.DoubleSide}
        />
        {!compMode && <ShotRings dims={dims} center={aim} />}
        <CameraRing dims={dims} center={aim} />
        <TiltArc dims={dims} center={aim} />
        {moveMode && <MovePath dims={dims} center={aim} />}
        <ViewFrustum dims={dims} center={aim} compMode={compMode} />
        <CameraGizmo dims={dims} center={aim} onDraftChange={onDraftChange} onCommit={onCommit} />
        {lightMode && <SunGizmo lighting={dims.lighting} center={center} onDraftChange={onDraftChange} onCommit={onCommit} />}
        <Suspense fallback={null}>
          <BackdropWall url={backdropUrl} reverse={reverse} />
        </Suspense>
        {/* SubjectGizmo must render AFTER the backdrop so it always sits ON TOP of the photo, not behind any
            semi-transparent layers (dark scrim, reverse backdrop, etc.) */}
        <SubjectGizmo dims={dims} center={center} aim={aim} onDraftChange={onDraftChange} onCommit={onCommit} />
        {reverse && <ReverseBackdrop anchor={anchor} center={center} />}
        {/* The scene's view camera. makeDefault publishes it to useThree(s => s.controls),
            which every gizmo reads to suspend orbiting (controls.enabled = false) while dragging —
            without makeDefault that ref stays null and the gizmos fight the camera, flinging the scene.
            Orbits around the fixed WALL_CENTER so it matches the gizmo/ring geometry. */}
        <OrbitControls
          makeDefault
          target={[WALL_CENTER.x, WALL_CENTER.y, WALL_CENTER.z]}
          enableDamping
          dampingFactor={0.12}
          minDistance={8}
          maxDistance={80}
          maxPolarAngle={Math.PI - 0.05}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
        />
      </Canvas>
      {/* top-left readout cards (hidden while composing to keep the framing clean) */}
      {!compMode && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1.5">
          <FrostCard icon="◳" label="Distance" value={`${dims.distanceM.toFixed(1)} m · ${dims.shotSize}`} />
          <FrostCard icon="✦" label="Camera Angle" value={`Orbit ${dims.angle.yaw}° · Tilt ${dims.angle.pitch}° (${LEVEL_EN[dims.angle.level]})`} />
          <FrostCard icon="◎" label="Depth of Field" value={`${dims.focal.dof < 0.4 ? 'Shallow' : dims.focal.dof > 0.6 ? 'Deep' : 'Mid'} DoF`} />
          <FrostCard icon="⇲" label="Subject → Backdrop" value={`${(anchor.depthM ?? 8.5).toFixed(1)} m`} />
        </div>
      )}
      <Viewfinder backdropUrl={backdropUrl} dims={dims} anchor={anchor} />
      {/* movement recorder — only while in keyframe-editing mode */}
      {moveMode && (
        <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
          <button
            onClick={recordKeyframe}
            className="flex items-center gap-1.5 rounded-lg bg-rose-500/90 px-3 py-1.5 text-sm font-medium text-white shadow-lg backdrop-blur hover:bg-rose-500"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-white" /> Record keyframe
          </button>
          <button onClick={undoKeyframe} disabled={path.length === 0} className="rounded-lg bg-white/15 px-3 py-1.5 text-sm text-white backdrop-blur hover:bg-white/25 disabled:opacity-30">
            Undo
          </button>
          <button onClick={clearPath} disabled={path.length === 0} className="rounded-lg bg-white/15 px-3 py-1.5 text-sm text-white backdrop-blur hover:bg-white/25 disabled:opacity-30">
            Clear
          </button>
          <span className="rounded-md bg-black/40 px-2 py-1 text-xs text-white/80 backdrop-blur">
            {path.length} keyframe{path.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      {/* unified mode banner + Done — only visible while editing a mode on the canvas */}
      {(compMode || moveMode || lightMode) && (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-black/55 px-2.5 py-1.5 text-sm text-white shadow-lg backdrop-blur">
          <span className="text-white/80">
            {compMode ? 'Composition · drag the subject' : moveMode ? 'Movement · record keyframes' : 'Lighting · drag the sun'}
          </span>
          <button
            onClick={compMode ? onExitComp : moveMode ? onExitMove : onExitLight}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-blue-500"
          >
            ✓ Done
          </button>
        </div>
      )}
    </div>
  )
}
