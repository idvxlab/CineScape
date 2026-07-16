import { useEffect, useState } from 'react'
import { useProject } from '../../../state/ProjectContext'
import { useEditor } from '../../../state/useEditor'
import type { ShotScript, SchemeShot } from '../../../api/backend'
import { CODEBOOK } from '../../../lib/designSpace'

const VARIANT = ['A', 'B', 'C', 'D', 'E']
// design-space code (e.g. 3.4) → "3.4 English intent name"; falls back to the bare code
const intentLabel = (code: string) => (CODEBOOK[code] ? `${code} ${CODEBOOK[code]!.l2}` : code)
const GEN_STEPS = ['Deriving strategy directions…', 'Reasoning the A/B/C shot scripts…', 'Validating cinematic grammar…']

export function PreviewTab() {
  const { schemes, generating, project, setActivePlan, activeSkill } = useProject()
  const setTab = useEditor((s) => s.setTab)

  if (generating) return <GeneratingProgress />
  if (schemes.length === 0) return <SchemesEmpty />
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        Shot Schemes <span className="text-xs font-normal text-gray-400">· reasoned from your intent</span>
        {activeSkill && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-600"
            title={activeSkill.rationale ?? 'Developed with your confirmed preferences'}
          >
            <span aria-hidden>✦</span>
            Personalized · {activeSkill.source_question_ids?.length ?? 0} preference{(activeSkill.source_question_ids?.length ?? 0) !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {schemes.map((s, i) => {
        const variant = VARIANT[i] ?? String(i + 1)
        const planId = `scheme-${variant}`
        return (
          <SchemeCard
            key={s.scheme_id}
            scheme={s}
            variant={variant}
            active={project.activePlanId === planId}
            onEdit={() => { setActivePlan(planId); setTab('edit') }}
          />
        )
      })}
    </div>
  )
}

function SchemesEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 grid h-20 w-20 place-items-center rounded-full bg-[#f1f3f6] text-3xl text-gray-400">🎬</div>
      <div className="text-[17px] font-semibold text-gray-700">Your shot schemes will appear here</div>
      <div className="mt-1.5 max-w-sm text-[13px] text-gray-400">Confirm your intent in the assistant (Accept Intent) to reason out candidate schemes.</div>
    </div>
  )
}

function GeneratingProgress() {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const step = Math.min(Math.floor(sec / 22), GEN_STEPS.length - 1)
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <div className="mb-5 h-10 w-10 animate-spin rounded-full border-[3px] border-brand-soft border-t-brand" />
      <div className="text-[15px] font-semibold text-gray-700">Reasoning your shot schemes</div>
      <div className="mt-4 w-full max-w-xs space-y-2">
        {GEN_STEPS.map((label, i) => (
          <div key={i} className={`flex items-center gap-2 text-[13px] ${i < step ? 'text-gray-400' : i === step ? 'text-brand' : 'text-gray-300'}`}>
            <span className={`grid h-4 w-4 flex-none place-items-center rounded-full text-[10px] ${i < step ? 'bg-brand text-white' : i === step ? 'border-2 border-brand' : 'border border-gray-200'}`}>{i < step ? '✓' : ''}</span>
            {label}
          </div>
        ))}
      </div>
      <div className="mt-4 text-[11px] text-gray-400">~1–2 min · {sec}s elapsed</div>
    </div>
  )
}

function SchemeCard({ scheme, variant, active, onEdit }: { scheme: ShotScript; variant: string; active: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div className={`overflow-hidden rounded-xl border ${active ? 'border-brand ring-1 ring-brand/40' : 'border-[#e8ebee]'}`}>
      <div className="flex w-full items-start gap-3 px-3 py-2.5">
        <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-brand text-sm font-bold text-white">{variant}</span>
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)}>
          <div className="text-sm font-semibold">{scheme.strategy}</div>
          <div className="text-[12px] leading-snug text-gray-500">{scheme.mechanism}</div>
        </button>
        <button onClick={onEdit} className={`flex-none rounded-lg px-2 py-1 text-[11px] font-medium transition ${active ? 'bg-brand text-white' : 'bg-brand-soft text-brand hover:bg-brand/20'}`}>
          {active ? '✓ Editing' : 'Edit ▸'}
        </button>
        <button className="flex-none text-gray-400" onClick={() => setOpen(!open)}>{open ? '▴' : '▾'}</button>
      </div>
      {open && (
        <div className="space-y-2.5 border-t border-[#eef1f4] p-3">
          {scheme.dominant_intents.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {scheme.dominant_intents.map((d) => <span key={d} className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">{intentLabel(d)}</span>)}
            </div>
          )}
          <div className="space-y-2">
            {scheme.shots.map((sh) => <ShotRow key={sh.order} sh={sh} />)}
          </div>
          {scheme.overall_rationale && (
            <div className="rounded-lg bg-brand-soft/50 p-2.5 text-[12px] leading-relaxed text-gray-700">
              <span className="font-semibold text-brand">Why · </span>{scheme.overall_rationale}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ShotRow({ sh }: { sh: SchemeShot }) {
  const dims: [string, string][] = [
    ['Size', sh.shot_size], ['Angle', sh.angle], ['Comp', sh.composition], ['Move', sh.movement],
    ['Lens', sh.focal_length], ['DoF', sh.depth_of_field], ['Light', sh.lighting], ['Color', sh.color_tone],
    ['Rhythm', sh.rhythm], ['Time', sh.duration],
  ]
  return (
    <div className="rounded-lg border border-[#eef1f4] p-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold text-gray-800">
        <span className="grid h-4 w-4 place-items-center rounded-full bg-ink text-[10px] text-white">{sh.order}</span>
        Shot {sh.order}
        {sh.serves.length > 0 && <span className="ml-1 text-[10px] font-normal text-gray-400">serves {sh.serves.map(intentLabel).join(', ')}</span>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {dims.filter(([, v]) => v).map(([k, v]) => (
          <span key={k}><span className="text-gray-400">{k}:</span> <span className="text-gray-700">{v}</span></span>
        ))}
      </div>
      {sh.rationale && <div className="mt-1.5 text-[11px] leading-relaxed text-gray-500">{sh.rationale}</div>}
    </div>
  )
}
