import { useState } from 'react'
import { useProject } from '../../../state/ProjectContext'
import type { Shot } from '../../../api/types'

export function ShotStrip() {
  const { project, activePlan, activeShot, setActiveShot, setActivePlan, schemes, renderingScheme, renderingShot, generateKeyframes } = useProject()
  const [err, setErr] = useState('')
  const [zoom, setZoom] = useState<Shot | null>(null)

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Shot Script</span>
        <span className="text-[11px] text-gray-400">{activePlan.shotCount} shots · ~{activePlan.totalSec}s</span>
        <div className="ml-auto flex items-center gap-2">
          {project.plans.length > 1 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400">Scheme</span>
              {project.plans.map((p) => (
                <button key={p.id} onClick={() => setActivePlan(p.id)} title={p.title}
                  className={`grid h-5 w-5 place-items-center rounded text-[11px] font-bold transition ${p.id === project.activePlanId ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  {p.variant}
                </button>
              ))}
            </div>
          )}
          {schemes.length > 0 && (
            <button onClick={() => { setErr(''); generateKeyframes().catch((e) => setErr(e?.message ?? String(e))) }} disabled={renderingScheme}
              className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-50">
              {renderingScheme ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Rendering…</> : '✨ Generate keyframes'}
            </button>
          )}
        </div>
      </div>
      {err && <div className="mb-1 text-[10px] text-rose-500">Render failed: {err}</div>}

      <div className="overflow-x-auto overflow-y-hidden">
        <div className="grid items-start gap-2 px-1 py-1" style={{ gridTemplateColumns: `repeat(${activePlan.shots.length}, minmax(360px, 1fr))` }}>
          {activePlan.shots.map((s, i) => {
            const busy = renderingShot === i
            return (
              <div
                key={s.id}
                onClick={() => setActiveShot(s.id)}
                className={`card flex h-28 min-w-0 cursor-pointer overflow-hidden transition ${s.id === activeShot.id ? 'ring-2 ring-brand' : 'hover:shadow-panel'}`}
              >
                {/* image — left */}
                <div className="relative h-full w-[44%] flex-none bg-black">
                  <img src={s.thumbnailUrl} className="h-full w-full object-cover" alt="" />
                  <button
                    onClick={(e) => { e.stopPropagation(); setZoom(s) }}
                    title="Enlarge"
                    className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded bg-black/55 text-[11px] text-white backdrop-blur transition hover:bg-black/75"
                  >⤢</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (schemes.length && renderingShot == null && !renderingScheme) generateKeyframes(i) }}
                    disabled={busy || renderingScheme || schemes.length === 0}
                    title="Re-render this keyframe"
                    className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded bg-black/55 text-[11px] text-white backdrop-blur transition hover:bg-black/75 disabled:opacity-50"
                  >{busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : '↻'}</button>
                  {busy && <div className="absolute inset-0 grid place-items-center bg-black/40 text-[10px] text-white">Rendering…</div>}
                </div>
                {/* text — right */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-2.5">
                  <div className="text-[12px] font-semibold leading-tight">{s.index}. {s.label}</div>
                  <div className="line-clamp-3 text-[10px] leading-[1.3] text-gray-500">{s.description}</div>
                  <div className="mt-auto text-[10px] text-gray-400">{fmt(s.startSec)} – {fmt(s.endSec)}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {zoom && <ShotLightbox shot={zoom} onClose={() => setZoom(null)} />}
    </div>
  )
}

function ShotLightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex-[3] bg-black">
          <img src={shot.thumbnailUrl} className="h-full max-h-[88vh] w-full object-contain" alt={shot.label} />
        </div>
        <div className="flex flex-[2] flex-col gap-2 overflow-y-auto p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[16px] font-semibold">{shot.index}. {shot.label}</div>
            <button onClick={onClose} className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200">✕</button>
          </div>
          <div className="text-[12px] text-gray-400">{fmt(shot.startSec)} – {fmt(shot.endSec)}</div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">{shot.description}</p>
        </div>
      </div>
    </div>
  )
}

function fmt(s: number) {
  return `0:${String(Math.floor(s)).padStart(2, '0')}`
}
