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
        提交回答
      </button>
    </div>
  )
}

function widgetDim(w: Widget, i: number): string {
  return 'dim' in w && w.dim ? w.dim : `${w.kind}-${i}`
}

// build a human-readable record of the answers (option labels, not raw codes) for the chat history
function summarize(widgets: Widget[], responses: Record<string, string | string[]>): string {
  const parts: string[] = []
  widgets.forEach((w, i) => {
    const r = responses[widgetDim(w, i)]
    if (r == null || (Array.isArray(r) && r.length === 0)) return
    if (w.kind === 'single' || w.kind === 'multi') {
      const vals = Array.isArray(r) ? r : [r]
      parts.push(vals.map((v) => w.options.find((o) => o.value === v)?.label ?? v).join('、'))
    } else {
      parts.push(Array.isArray(r) ? r.join('、') : String(r))
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
            <button className="rounded bg-green-500/90 px-2.5 py-1 text-[11px] text-white" disabled={disabled} onClick={() => onAnswer('yes')}>是</button>
            <button className="rounded bg-amber-500/90 px-2.5 py-1 text-[11px] text-white" disabled={disabled} onClick={() => onAnswer('no')}>否</button>
          </div>
        </div>
      )
  }
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
    if (v < 40) return `${v < 15 ? '强烈' : '偏向'}${left}${lc ? `(${lc})` : ''}`
    if (v > 60) return `${v > 85 ? '强烈' : '偏向'}${right}${rc ? `(${rc})` : ''}`
    return `两者均衡(介于 ${left} 与 ${right} 之间)`
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
        rows={2} placeholder="输入你的回答…" value={text} disabled={disabled}
        onChange={(e) => update(e.target.value)}
      />
    </div>
  )
}
