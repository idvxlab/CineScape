import { useState } from 'react'
import { useProject } from '../../state/ProjectContext'
import { CODEBOOK, CATEGORIES, DIM_AXES, AXIS_MECHANISM, axisParamPhrase, type DimAxis } from '../../lib/designSpace'

const FALLBACK_SERVES = ['10.2', '5.1', '2.1', '5.3', '3.4']

export function ExpressionPanel() {
  const { activeShot, editShot } = useProject()
  const d = activeShot.dims
  const [showFull, setShowFull] = useState(false)

  const served = (activeShot.serves && activeShot.serves.length ? activeShot.serves : FALLBACK_SERVES).filter((c) => CODEBOOK[c])
  const servedSet = new Set(served)
  const cats = [...new Set(served.map((c) => CODEBOOK[c]!.l1))] // involved L1 categories

  // expressible dims → sliders (dedupe by control); the rest → read-only chips
  const sliders: DimAxis[] = []
  const seenParam = new Set<string>()
  const listed: string[] = []
  for (const code of served) {
    const ax = DIM_AXES[code]
    if (ax && !seenParam.has(ax.param)) { seenParam.add(ax.param); sliders.push(ax) }
    else if (!ax) listed.push(code)
  }

  const setAxis = (ax: DimAxis, v: number) => editShot(activeShot.id, { dims: ax.apply(d, v) })

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[13px] font-semibold">Design space for this shot <span className="text-[10px] font-normal text-gray-400">(from scheme intent labels)</span></span>
          <button className="text-[11px] text-brand" onClick={() => setShowFull(true)}>Full design space ›</button>
        </div>

        {/* L1 intent (category) tags — shown together at the top */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {cats.map((c) => (
            <span key={c} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">{c}</span>
          ))}
        </div>

        {/* L2 dimensions — sliders */}
        <div className="space-y-3">
          {sliders.map((ax) => {
            const v = ax.read(d)
            const dim = CODEBOOK[ax.code]!
            return (
              <div key={ax.code}>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-gray-800">{dim.l2} <span className="text-[9px] font-normal text-gray-300">{ax.code} · {dim.l1}</span></span>
                  <span className="text-[10px] text-gray-400">Now: {ax.label(v)}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-400">
                  <span className="w-16 flex-none text-right">{ax.left}</span>
                  <input type="range" min={0} max={1} step={0.02} value={v}
                    onChange={(e) => setAxis(ax, parseFloat(e.target.value))}
                    className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand" />
                  <span className="w-16 flex-none">{ax.right}</span>
                </div>
              </div>
            )
          })}
        </div>

        {listed.length > 0 && (
          <div className="mt-3 border-t border-[#eef1f4] pt-2">
            <div className="mb-1 text-[10px] text-gray-400">Other involved dimensions (no single-axis control)</div>
            <div className="flex flex-wrap gap-1.5">
              {listed.map((c) => (
                <span key={c} className="rounded border border-[#e8ebee] px-1.5 py-0.5 text-[11px] text-gray-500">{c} {CODEBOOK[c]!.l2}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Why shot this way — param → semantics → intent reasoning (links design space with prompt summary) */}
      {sliders.length > 0 && (
        <div className="card p-3">
          <div className="mb-1 text-[13px] font-semibold">Why shot this way <span className="text-[10px] font-normal text-gray-400">param → semantics → intent</span></div>
          <p className="mb-2.5 text-[10px] leading-relaxed text-gray-400">How this set of shot params realizes the design-space intents above:</p>
          <div className="space-y-2">
            {sliders.map((ax) => {
              const v = ax.read(d)
              const intents = served.filter((c) => DIM_AXES[c]?.param === ax.param).map((c) => CODEBOOK[c]!.l2)
              return (
                <div key={ax.code} className="rounded-lg bg-slate-50 px-2.5 py-2">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-semibold text-gray-800">{ax.label(v)}</span>
                    <span className="flex-none text-[10px] text-gray-400">{axisParamPhrase(ax, d)}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-500">{AXIS_MECHANISM[ax.param]}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {intents.map((it, i) => (
                      <span key={i} className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">→ {it}</span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* prompt summary */}
      <div className="card p-4">
        <div className="mb-2 text-sm font-semibold">Current Shot · Prompt Summary</div>
        <div className="mb-1 text-xs text-gray-500">Shot {activeShot.index}: {activeShot.label} ({fmt(activeShot.startSec)} – {fmt(activeShot.endSec)})</div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-gray-700">{activeShot.promptSummary}</p>
      </div>

      {showFull && <FullDesignSpace servedSet={servedSet} onClose={() => setShowFull(false)} />}
    </div>
  )
}

// read-only browser of the complete v3 design space (12 L1 / 56 L2); involved + adjustable marked
function FullDesignSpace({ servedSet, onClose }: { servedSet: Set<string>; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#eef1f4] px-5 py-3">
          <div>
            <div className="text-[15px] font-semibold">Full design space · Director Intent v3</div>
            <div className="text-[11px] text-gray-400">12 L1 intents / {Object.keys(CODEBOOK).length} L2 dimensions · fixed taxonomy, not editable</div>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-slate-500 hover:bg-slate-200">✕</button>
        </div>
        <div className="grid grid-cols-2 gap-3 overflow-y-auto p-4">
          {CATEGORIES.map((c) => (
            <div key={c.l1} className="rounded-xl border border-[#eef1f4] p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="h-3 w-1 rounded-full bg-brand" />
                <span className="text-[12px] font-bold text-gray-700">{c.l1}</span>
              </div>
              <div className="space-y-0.5">
                {c.codes.map((code) => {
                  const involved = servedSet.has(code)
                  const adjustable = !!DIM_AXES[code]
                  return (
                    <div key={code} className={`flex items-center gap-1.5 text-[11px] ${involved ? 'font-medium text-brand' : 'text-gray-500'}`}>
                      <span className="w-7 flex-none text-gray-300">{code}</span>
                      <span className="flex-1">{CODEBOOK[code]!.l2}</span>
                      {adjustable && <span className="rounded bg-slate-100 px-1 text-[9px] text-slate-400">Adjustable</span>}
                      {involved && <span className="text-[9px] text-brand">●This shot</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function fmt(s: number) {
  return `0:${String(Math.floor(s)).padStart(2, '0')}`
}
