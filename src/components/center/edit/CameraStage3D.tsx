import { Suspense, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, useTexture, Line, Grid, Edges, Html } from '@react-three/drei'
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
const LATERAL_RANGE = 16 // subject's lateral travel across the scene (point2d.x 0..1 → x ∈ [−8, 8])
// subject↔backdrop distance (m) ↔ the visual gap between the subject and the fixed backdrop
const BD_VIS_MIN = 7, BD_VIS_MAX = 24
const bdVis = (depthM: number) => BD_VIS_MIN + (clamp(depthM, 0, DEPTH_MAX) / DEPTH_MAX) * (BD_VIS_MAX - BD_VIS_MIN)
const invBdVis = (v: number) => ((clamp(v, BD_VIS_MIN, BD_VIS_MAX) - BD_VIS_MIN) / (BD_VIS_MAX - BD_VIS_MIN)) * DEPTH_MAX
// the subject's world position (= orbit centre): lateral from point2d.x, depth from the fixed backdrop
function actorPos(anchor: Anchor): THREE.Vector3 {
  const px = ((anchor.point2d?.x ?? 0.5) - 0.5) * LATERAL_RANGE
  const pz = BACKDROP_Z + bdVis(anchor.depthM ?? 8.5)
  const py = clamp(SUBJECT_Y + (anchor.liftM ?? 0), 1, WALL_H - 1)
  return new THREE.Vector3(px, py, pz)
}
// Visual orbit radius: compress real Dolly distance (1..26m) into a tighter on-screen radius so the
// photo wall stays the dominant element. Shot Size / the data still use the real distanceM.
const DIST_VIS_MIN = 3.5
const DIST_VIS_MAX = 11
const visR = (d: number) => DIST_VIS_MIN + ((clamp(d, DIST_MIN, DIST_MAX) - DIST_MIN) / (DIST_MAX - DIST_MIN)) * (DIST_VIS_MAX - DIST_VIS_MIN)
const invVisR = (R: number) => DIST_MIN + ((clamp(R, DIST_VIS_MIN, DIST_VIS_MAX) - DIST_VIS_MIN) / (DIST_VIS_MAX - DIST_VIS_MIN)) * (DIST_MAX - DIST_MIN)

// ---- mappings -------------------------------------------------------------
// lighting.pos (画面方位/高度, 0..1) ↔ world position on a sphere around the orbit center
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

// ---- director's free observation camera -----------------------------------
function CameraObserve({ center }: { center: THREE.Vector3 }) {
  return <OrbitControls makeDefault target={center.toArray()} enablePan={false} minDistance={4} maxDistance={120} />
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

type Axis = 'orbit' | 'tilt' | 'dolly' | null
const ORBIT_COL = '#4c8dff', TILT_COL = '#ff5fa2', DOLLY_COL = '#2bd4c4'

// ---- shot-camera gizmo with 3 axes: Orbit (yaw) / Tilt (pitch) / Dolly (distance) ----
function CameraGizmo({ dims, center, onDraftChange, onCommit }: Pick<Props, 'dims' | 'onDraftChange' | 'onCommit'> & { center: THREE.Vector3 }) {
  const controls = useThree((s) => s.controls) as any
  const raycaster = useThree((s) => s.raycaster)
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  const [axis, setAxis] = useState<Axis>(null)

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

    if (axis === 'orbit') {
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
    e.stopPropagation()
    if (controls) controls.enabled = false
    setAxis(a)
  }
  const camQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), view) // local +z faces the subject
  // live drag readout: semantic meaning (prominent) + the raw number (small)
  const readout =
    axis === 'orbit'
      ? { sem: orbitMeaning(dims.angle.yaw), txt: `Orbit ${dims.angle.yaw}°`, col: ORBIT_COL }
      : axis === 'tilt'
        ? { sem: angleMeaning(dims.angle.pitch), txt: `Tilt ${dims.angle.pitch}° · ${LEVEL_EN[dims.angle.level]}`, col: TILT_COL }
        : axis === 'dolly'
          ? { sem: shotSizeMeaning(dims), txt: `Dolly ${dims.distanceM.toFixed(1)} m · ${dims.shotSize}`, col: DOLLY_COL }
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
      {/* movie camera, oriented to look at the subject — scaled down to roughly human scale */}
      <group quaternion={camQuat} scale={0.5}>
        {/* body */}
        <mesh castShadow>
          <boxGeometry args={[1.9, 1.45, 2.4]} />
          <meshStandardMaterial color="#b3bdca" metalness={0.55} roughness={0.32} />
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
      <AxisArrow dir={orbitT} length={3.6} color={ORBIT_COL} active={axis === 'orbit'} onDown={grab('orbit')} />
      <AxisArrow dir={tiltT} length={3.6} color={TILT_COL} active={axis === 'tilt'} onDown={grab('tilt')} />
      <AxisArrow dir={radialN} length={3.6} color={DOLLY_COL} active={axis === 'dolly'} onDown={grab('dolly')} />
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

// ---- orbit ring at the photo-center height --------------------------------
// Split into a FRONT arc (z>0, in front of the photo wall — bright solid) and a BACK arc
// (z<0, behind the wall — dim dashed), so the circle reads with clear front/back depth.
function CameraRing({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const r = visR(dims.distanceM)
  const yaw = THREE.MathUtils.degToRad(dims.angle.yaw)
  // offset at angle a (matches camera/marker convention): x=sin(a)·r, z=cos(a)·r → z>0 is front
  const arc = (a0: number, a1: number) => {
    const pts: THREE.Vector3[] = []
    for (let a = a0; a <= a1 + 0.001; a += 4) {
      const ar = THREE.MathUtils.degToRad(a)
      pts.push(new THREE.Vector3(Math.sin(ar) * r, 0, Math.cos(ar) * r))
    }
    return pts
  }
  // boundary between the two half-rings sits at z=0 (a=±90), i.e. the world-x axis points (±r,0,0)
  const tick = (x: number): THREE.Vector3[] => [new THREE.Vector3(x - 0.55, 0, 0), new THREE.Vector3(x + 0.55, 0, 0)]
  const reverse = Math.cos(yaw) < 0 // camera currently in the reverse-view half
  return (
    <group position={center.toArray()}>
      {/* facing-backdrop half (z>0) — normal shooting zone: light blue-grey, solid */}
      <Line points={arc(-90, 90)} color="#a9bccd" lineWidth={reverse ? 2.4 : 3.4} transparent opacity={reverse ? 0.6 : 0.95} depthTest={false} renderOrder={5} />
      {/* reverse half (z<0) — reverse-view region: lighter warm-grey, dashed */}
      <Line points={arc(90, 270)} color="#d8cdba" lineWidth={reverse ? 3.4 : 2.4} dashed dashSize={0.45} gapSize={0.4} transparent opacity={reverse ? 0.92 : 0.5} depthTest={false} renderOrder={5} />
      {/* two short ticks marking the half-ring boundary (not a full divider) */}
      <Line points={tick(r)} color="#eef2f6" lineWidth={2.6} transparent opacity={0.85} depthTest={false} renderOrder={6} />
      <Line points={tick(-r)} color="#eef2f6" lineWidth={2.6} transparent opacity={0.85} depthTest={false} renderOrder={6} />
      {/* current-yaw marker — green in the normal zone, warm amber in the reverse zone */}
      <mesh position={[Math.sin(yaw) * r, 0, Math.cos(yaw) * r]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
        <circleGeometry args={[0.45, 24]} />
        <meshBasicMaterial color={reverse ? '#ffc06a' : '#7CFC9E'} transparent opacity={0.95} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

// ---- shot-size reference rings: faint dashed circles at each shot size's radius + label ----
function ShotRings({ dims, center }: { dims: SevenDims; center: THREE.Vector3 }) {
  const circle = (r: number) => {
    const pts: THREE.Vector3[] = []
    for (let a = 0; a <= 360; a += 6) {
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
            <Line points={circle(r)} color={on ? '#7fd6ea' : '#5b8aa6'} lineWidth={on ? 1.6 : 1} dashed dashSize={0.35} gapSize={0.4} transparent opacity={on ? 0.7 : 0.4} depthTest={false} renderOrder={1} />
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
//      (exactly as a fixed set wall behaves — so 反打/reverse shots are possible). --
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
          反向背景域 · Reverse BG
        </div>
      </Html>
    </group>
  )
}

// the camera frame's right/up basis + half-extents at the subject's distance (focus maps to this frame)
function frameBasis(dims: SevenDims, center: THREE.Vector3) {
  const cw = camWorld(dims, center)
  const view = center.clone().sub(cw).normalize()
  const right = new THREE.Vector3().crossVectors(view, Y_UP).normalize()
  const up = new THREE.Vector3().crossVectors(right, view).normalize()
  const dist = cw.distanceTo(center)
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(42 / (dims.composition.zoom ?? 1)) / 2)
  return { view, right, up, halfW: (halfH * 16) / 9, halfH }
}
// subject sits at the orbit centre; composition.focus offsets it ACROSS the full camera frame
// (focus.x 0→1 = left→right edge), so recomposing visibly moves the subject relative to the camera.
function subjectWorld(dims: SevenDims, center: THREE.Vector3): THREE.Vector3 {
  const focus = dims.composition.focus ?? { x: 0.5, y: 0.5 }
  const { right, up, halfW, halfH } = frameBasis(dims, center)
  return center.clone().addScaledVector(right, (focus.x - 0.5) * 2 * halfW).addScaledVector(up, (0.5 - focus.y) * 2 * halfH)
}

// ---- draggable subject (the actor) -----------------------------------------
//  • Default: drag the body to WALK the actor on the ground (lateral = point2d.x, depth-from-backdrop
//    = depthM). The orbit centre IS the actor, so the whole camera rig follows.
//  • Composition mode: drag the body to set the in-frame focus (off-centre framing), capsule offsets
//    within the frame while the actor's world position is unchanged.
function SubjectGizmo({ dims, anchor, compMode, onDraftChange, onCommit, center }: Props & { center: THREE.Vector3 }) {
  const controls = useThree((s) => s.controls) as any
  const raycaster = useThree((s) => s.raycaster)
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  type SMode = 'x' | 'y' | 'z' | 'ground' | 'focus' | null
  const [mode, setMode] = useState<SMode>(null)
  const [hover, setHover] = useState<'x' | 'y' | 'z' | 'body' | null>(null)
  const origin = useRef(new THREE.Vector3()) // actor world position captured at grab → fixed axis lines
  const sp = subjectWorld(dims, center) // in comp mode: actor + in-frame focus offset

  useEffect(() => {
    if (!mode) return
    const up = () => {
      setMode(null)
      if (controls) controls.enabled = true
      document.body.style.cursor = 'auto'
      onCommit()
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [mode, controls, onCommit])

  useFrame(() => {
    if (!mode) return
    raycaster.setFromCamera(pointer, camera)
    const ray = raycaster.ray
    if (mode === 'focus') {
      // composition: drag on the camera-facing plane through the actor → in-frame focus (full-frame mapping)
      const { view, right, up, halfW, halfH } = frameBasis(dims, center)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(view, center)
      const hit = new THREE.Vector3()
      if (!ray.intersectPlane(plane, hit)) return
      const d = hit.sub(center)
      onDraftChange({ dims: { composition: { ...dims.composition, focus: { x: clamp(d.dot(right) / (2 * halfW) + 0.5, 0, 1), y: clamp(0.5 - d.dot(up) / (2 * halfH), 0, 1) } } } })
      return
    }
    if (mode === 'ground') {
      // quick planar walk on the floor (x + depth), keeping current lift
      const hit = new THREE.Vector3()
      if (!ray.intersectPlane(new THREE.Plane(Y_UP, 0), hit)) return
      onDraftChange({ anchor: { point2d: { x: clamp(hit.x / LATERAL_RANGE + 0.5, 0, 1), y: anchor.point2d?.y ?? 0.5 }, depthM: clamp(round1(invBdVis(hit.z - BACKDROP_Z)), 0, DEPTH_MAX) } })
      return
    }
    // single-axis translate: closest point on the (fixed) axis line through the grab origin to the pointer ray
    const u = mode === 'x' ? new THREE.Vector3(1, 0, 0) : mode === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const w0 = origin.current.clone().sub(ray.origin)
    const b = u.dot(ray.direction)
    const denom = 1 - b * b
    if (Math.abs(denom) < 1e-4) return
    const t = (b * ray.direction.dot(w0) - u.dot(w0)) / denom
    const P = origin.current.clone().addScaledVector(u, t)
    if (mode === 'x') onDraftChange({ anchor: { point2d: { x: clamp(P.x / LATERAL_RANGE + 0.5, 0, 1), y: anchor.point2d?.y ?? 0.5 } } })
    else if (mode === 'z') onDraftChange({ anchor: { depthM: clamp(round1(invBdVis(P.z - BACKDROP_Z)), 0, DEPTH_MAX) } })
    else onDraftChange({ anchor: { liftM: round1(clamp(P.y - SUBJECT_Y, 1 - SUBJECT_Y, WALL_H - 1 - SUBJECT_Y)) } })
  })

  const grab = (m: SMode) => (e: any) => {
    e.stopPropagation()
    if (controls) controls.enabled = false
    origin.current.copy(center)
    setMode(m)
  }
  const active = mode !== null
  return (
    <>
      {/* the actor capsule ALWAYS sits at its framed position (world pos + composition offset) */}
      <group position={sp.toArray()}>
        <mesh
          onPointerDown={grab(compMode ? 'focus' : 'ground')}
          onPointerOver={(e) => { e.stopPropagation(); setHover('body'); document.body.style.cursor = 'grab' }}
          onPointerOut={() => { setHover(null); if (!active) document.body.style.cursor = 'auto' }}
          castShadow
        >
          <capsuleGeometry args={[0.32, 1.0, 8, 16]} />
          <meshStandardMaterial color={active || hover === 'body' ? '#ffd76a' : '#e8a23a'} emissive="#5a3c00" emissiveIntensity={hover === 'body' ? 0.5 : 0} roughness={0.5} />
        </mesh>
      </group>
      {/* world-position translate gizmo (blocking mode) — at the actor's orbit-centre world position */}
      {!compMode && (
        <group position={center.toArray()}>
          <AxisArrow dir={new THREE.Vector3(1, 0, 0)} length={2.6} color="#ff5b5b" active={mode === 'x' || hover === 'x'} onDown={grab('x')} onOver={() => setHover('x')} onOut={() => setHover(null)} />
          <AxisArrow dir={new THREE.Vector3(0, 1, 0)} length={2.6} color="#7CFC9E" active={mode === 'y' || hover === 'y'} onDown={grab('y')} onOver={() => setHover('y')} onOut={() => setHover(null)} />
          <AxisArrow dir={new THREE.Vector3(0, 0, 1)} length={2.6} color="#4c8dff" active={mode === 'z' || hover === 'z'} onDown={grab('z')} onOver={() => setHover('z')} onOut={() => setHover(null)} />
        </group>
      )}
      {/* ground footprint marker so the actor's world position reads on the floor */}
      <mesh position={[center.x, 0.03, center.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
        <ringGeometry args={[0.55, 0.75, 32]} />
        <meshBasicMaterial color="#ffb347" transparent opacity={0.8} side={THREE.DoubleSide} depthTest={false} />
      </mesh>
    </>
  )
}

// ---- viewfinder: what the camera frames; background shifts with the camera VIEW (like a real lens) ----
function Viewfinder({ backdropUrl, dims, anchor }: { backdropUrl: string; dims: SevenDims; anchor: Anchor }) {
  const focus = dims.composition.focus ?? { x: 0.5, y: 0.5 }
  const zoom = dims.composition.zoom ?? 1
  const eff = dims.distanceM / zoom // effective shot distance
  const sizeFrac = clamp(2.4 / eff, 0.14, 1.7) // subject height as fraction of frame
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
  // background = the FIXED backdrop as seen by the shot camera looking at the actor.
  // Extend the camera→actor view ray to the backdrop plane (z=BACKDROP_Z): the hit point is what sits
  // behind the subject. Orbit / tilt / the actor's world position all move it; a reverse angle puts the
  // backdrop behind the camera (hitS<0) → it leaves the frame, so the viewfinder shows an empty scene.
  const aCenter = actorPos(anchor)
  const cam = camWorld(dims, aCenter)
  const dir = aCenter.clone().sub(cam).normalize()
  const hitS = Math.abs(dir.z) > 1e-3 ? (BACKDROP_Z - cam.z) / dir.z : -1
  const bgVisible = hitS > 0
  let bgX = 50, bgY = 50, bgZoom = 150
  if (bgVisible) {
    bgX = clamp(((cam.x + dir.x * hitS) / WALL_W + 0.5) * 100, -30, 130)
    bgY = clamp((1 - (cam.y + dir.y * hitS) / WALL_H) * 100, -30, 130)
    bgZoom = clamp((2800 / hitS) * zoom, 110, 340) // nearer backdrop / longer lens → larger
  }
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 w-72 overflow-hidden rounded-lg border border-white/25 shadow-2xl" style={{ aspectRatio: '16 / 9' }}>
      {bgVisible ? (
        <div
          className="absolute inset-0"
          style={{ backgroundImage: `url(${backdropUrl})`, backgroundSize: `${bgZoom}%`, backgroundPosition: `${bgX}% ${bgY}%`, filter: `blur(${bgBlur}px) saturate(${sat}) contrast(${con})` }}
        />
      ) : (
        // reverse angle — the photo is behind the camera. Show the subject's reverse view: a restrained
        // frosted domain (the reverse-background container), not the photo.
        <div className="absolute inset-0" style={{ background: 'radial-gradient(125% 125% at 50% 38%, #5c6470 0%, #353b44 55%, #20252c 100%)' }}>
          <div className="absolute inset-2 rounded border border-dashed border-white/25" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] font-medium tracking-wide text-white/55">反向背景域 · Reverse BG</div>
        </div>
      )}
      <div className="absolute" style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%`, width: `${sizeFrac * 58}%`, height: `${sizeFrac * 100}%`, transform: 'translate(-50%, -50%)' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="h-full w-full" style={{ filter: `blur(${(1 - dof) * 1.1}px)` }}>
          <path d="M50 6 a17 17 0 1 1 -0.1 0 Z M16 100 q0 -48 34 -48 q34 0 34 48 Z" fill="#0e1722" opacity={0.88} />
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
  // orbit center = the subject's world position (camera rig follows the actor; backdrop is fixed)
  const center = actorPos(anchor)
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
    <div className="absolute inset-0 overflow-hidden rounded-xl bg-black">
      <Canvas shadows camera={{ position: [7, 11, 27], fov: 46 }}>
        <color attach="background" args={['#060708']} />
        <fog attach="fog" args={['#060708', 70, 160]} />
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#cfd9e6', '#3a4048', 0.6]} />
        <SceneLight lighting={dims.lighting} center={center} />
        {/* grid sits on the orbit-ring plane (the subject's height), so the ring lies on the grid */}
        <Grid
          position={[0, center.y + 0.02, 0]}
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
        <SubjectGizmo backdropUrl={backdropUrl} dims={dims} anchor={anchor} compMode={compMode} center={center} onDraftChange={onDraftChange} onCommit={onCommit} />
        {!compMode && <ShotRings dims={dims} center={center} />}
        <CameraRing dims={dims} center={center} />
        <TiltArc dims={dims} center={center} />
        {moveMode && <MovePath dims={dims} center={center} />}
        <ViewFrustum dims={dims} center={center} compMode={compMode} />
        <CameraGizmo dims={dims} center={center} onDraftChange={onDraftChange} onCommit={onCommit} />
        {lightMode && <SunGizmo lighting={dims.lighting} center={center} onDraftChange={onDraftChange} onCommit={onCommit} />}
        <Suspense fallback={null}>
          <BackdropWall url={backdropUrl} reverse={reverse} />
        </Suspense>
        {reverse && <ReverseBackdrop anchor={anchor} center={center} />}
        <CameraObserve center={center} />
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
