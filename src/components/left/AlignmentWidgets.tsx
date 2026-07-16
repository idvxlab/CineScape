import { useState } from 'react'
import type { Widget } from '../../api/backend'

// ---- the multi-turn alignment panel: renders a round of widgets, collects answers, submits as a batch ----
export function AlignmentPanel({ widgets, onSubmit, disabled }: {
  widgets: Widget[]
  onSubmit: (responses: Record<string, string | string[]>, summary: string) => void
  disabled?: boolean
}) {
  const [responses, setResponses] = useState<Record<string, string | string[]>>({})
  const set = (dim: string, val: string | string[]) => setResponses((p) => ({ ...p, [dim]: val }))
  const answered = Object.keys(responses).length > 0

  return (
    <div className="space-y-3 rounded-lg border border-[#e7ddff] bg-[#faf8ff] p-2.5">
      {widgets.map((w, i) => (
        <WidgetView key={widgetDim(w, i)} w={w} disabled={disabled} onAnswer={(v) => set(widgetDim(w, i), v)} />
      ))}
      <button
        className="w-full rounded-lg bg-brand py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
        disabled={disabled || !answered}
        onClick={() => { onSubmit(responses, summarize(widgets, responses)); setResponses({}) }}
      >
        Submit
      </button>
    </div>
  )
}

function widgetDim(w: Widget, i: number): string {
  // memory probes have fixed response keys the backend routes on (ADR-0017):
  // verification answers are keyed by the question id; activation by 'skill_activation'.
  if (w.kind === 'preference_probe') return w.question_id
  if (w.kind === 'skill_activation') return 'skill_activation'
  return 'dim' in w && w.dim ? w.dim : `${w.kind}-${i}`
}

// build a human-readable record of the answers (option labels, not raw codes) for the chat history
function summarize(widgets: Widget[], responses: Record<string, string | string[]>): string {
  const parts: string[] = []
  widgets.forEach((w, i) => {
    const r = responses[widgetDim(w, i)]
    if (r == null || (Array.isArray(r) && r.length === 0)) return
    if (w.kind === 'single' || w.kind === 'multi' || w.kind === 'preference_probe' || w.kind === 'skill_activation') {
      const vals = Array.isArray(r) ? r : [r]
      parts.push(vals.map((v) => w.options.find((o) => o.value === v)?.label ?? v).join(', '))
    } else {
      parts.push(Array.isArray(r) ? r.join(', ') : String(r))
    }
  })
  return parts.join(' · ') || '(answered)'
}

function WidgetView({ w, onAnswer, disabled }: { w: Widget; onAnswer: (v: string | string[]) => void; disabled?: boolean }) {
  switch (w.kind) {
    case 'single':
      return <Choice prompt={w.prompt} options={w.options} multi={false} onAnswer={onAnswer} disabled={disabled} />
    case 'multi':
      return <Choice prompt={w.prompt} options={w.options} multi onAnswer={onAnswer} disabled={disabled} />
    case 'slider':
      return <Slider prompt={w.prompt} ends={w.ends} ticks={w.ticks} onAnswer={onAnswer} disabled={disabled} />
    case 'freetext':
      return <FreeText prompt={w.prompt} suggestions={w.suggestions} onAnswer={onAnswer} disabled={disabled} />
    case 'confirm':
      return (
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-gray-700">{w.reflection}</p>
          <div className="flex gap-1.5">
            <button className="rounded bg-green-500/90 px-2.5 py-1 text-[11px] text-white" disabled={disabled} onClick={() => onAnswer('yes')}>Yes</button>
            <button className="rounded bg-amber-500/90 px-2.5 py-1 text-[11px] text-white" disabled={disabled} onClick={() => onAnswer('no')}>No</button>
          </div>
        </div>
      )
    case 'preference_probe':
      return <MemoryProbe prompt={w.prompt} options={w.options} tag="Remembered preference" onAnswer={onAnswer} disabled={disabled} />
    case 'skill_activation':
      return <MemoryProbe prompt={w.prompt} options={w.options} tag="Your preferences" onAnswer={onAnswer} disabled={disabled} />
  }
}

// ---- evolutionary-memory probe (ADR-0017): visually distinct from intent questions ----
// One per session at most. Answering is optional — skipping it never blocks alignment.
export function MemoryProbe({ prompt, options, tag, onAnswer, disabled }: {
  prompt: string; options: { value: string; label: string }[]; tag: string
  onAnswer: (v: string) => void; disabled?: boolean
}) {
  const [sel, setSel] = useState<string | null>(null)
  const probeChip = (active: boolean, value: string) => {
    if (value === 'forget')
      return `rounded-lg border px-2 py-1 text-[11px] transition ${active ? 'border-red-400 bg-red-50 text-red-600' : 'border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:text-red-500'}`
    return `rounded-lg border px-2 py-1 text-[11px] transition ${active ? 'border-violet-500 bg-violet-500 text-white' : 'border-violet-200 bg-white text-violet-700 hover:bg-violet-50'}`
  }
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-2">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
        <span aria-hidden>✦</span> {tag}
      </div>
      <p className="mb-1.5 text-[12px] font-medium text-gray-700">{prompt}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            className={probeChip(sel === o.value, o.value)}
            disabled={disabled}
            onClick={() => { setSel(o.value); onAnswer(o.value) }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-violet-400">Optional — this tunes your personal preferences, not this scene's intent.</p>
    </div>
  )
}

const chip = (active: boolean) =>
  `rounded-lg border px-2 py-1 text-[11px] transition ${active ? 'border-brand bg-brand text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`

function Choice({ prompt, options, multi, onAnswer, disabled }: {
  prompt: string; options: { value: string; label: string; hint?: string }[]; multi: boolean
  onAnswer: (v: string | string[]) => void; disabled?: boolean
}) {
  const [sel, setSel] = useState<string[]>([])
  const pick = (v: string) => {
    if (multi) {
      const next = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]
      setSel(next); onAnswer(next)
    } else {
      setSel([v]); onAnswer(v)
    }
  }
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-gray-700">{prompt}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o.value} className={chip(sel.includes(o.value))} disabled={disabled} onClick={() => pick(o.value)}>
            {o.label}{o.hint ? ` (${o.hint})` : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

function Slider({ prompt, ends, ticks, onAnswer, disabled }: {
  prompt: string; ends: [string, string]; ticks?: string[]; onAnswer: (v: string) => void; disabled?: boolean
}) {
  const [value, setValue] = useState(50)
  const describe = (v: number): string => {
    const [left, right] = ends
    const lc = ticks?.[0], rc = ticks?.[ticks.length - 1]
    if (v < 40) return `${v < 15 ? 'Strongly ' : 'Toward '}${left}${lc ? `(${lc})` : ''}`
    if (v > 60) return `${v > 85 ? 'Strongly ' : 'Toward '}${right}${rc ? `(${rc})` : ''}`
    return `Balanced (between ${left} and ${right})`
  }
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-gray-700">{prompt}</p>
      <div className="flex justify-between text-[10px] text-gray-400"><span>{ends[0]}</span><span>{ends[1]}</span></div>
      <input
        type="range" min={0} max={100} value={value} disabled={disabled}
        onChange={(e) => { const v = Number(e.target.value); setValue(v); onAnswer(describe(v)) }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-brand"
      />
      <div className="mt-0.5 text-center text-[11px] font-medium text-brand">{describe(value)}</div>
    </div>
  )
}

function FreeText({ prompt, suggestions, onAnswer, disabled }: {
  prompt: string; suggestions: string[]; onAnswer: (v: string) => void; disabled?: boolean
}) {
  const [text, setText] = useState('')
  const update = (v: string) => { setText(v); if (v.trim()) onAnswer(v.trim()) }
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-gray-700">{prompt}</p>
      {suggestions.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s} className={chip(text === s)} disabled={disabled} onClick={() => update(s)}>{s}</button>
          ))}
        </div>
      )}
      <textarea
        className="w-full rounded-lg border border-[#e3e6ea] px-2 py-1.5 text-[12px] outline-none focus:border-brand"
        rows={2} placeholder="Type your answer…" value={text} disabled={disabled}
        onChange={(e) => update(e.target.value)}
      />
    </div>
  )
}
