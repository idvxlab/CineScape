import { useEffect, useRef, useState } from 'react'
import { useProject } from '../../state/ProjectContext'
import { useEditor } from '../../state/useEditor'
import type { ChatMessage } from '../../api/types'
import { respond, confirmIntent, type IntentTurn, type OnReasoning } from '../../api/backend'
import { AlignmentPanel } from './AlignmentWidgets'

type Msg = ChatMessage & { reasoning?: boolean }

function Bubble({ m }: { m: Msg }) {
  const isAssistant = m.role === 'assistant'
  // model reasoning / reflection → muted gray, lighter, italic
  if (m.reasoning) {
    return (
      <div className="flex gap-2">
        <div className="grid h-7 w-7 flex-none place-items-center rounded-full bg-[#f1f3f6] text-xs text-gray-400">💭</div>
        <div className="max-w-[82%] whitespace-pre-wrap rounded-xl border border-dashed border-[#e6e9ed] bg-[#fafbfc] px-3 py-2 text-[12px] italic leading-relaxed text-gray-400">
          {m.text}
        </div>
      </div>
    )
  }
  return (
    <div className={`flex gap-2 ${isAssistant ? '' : 'flex-row-reverse'}`}>
      <div className="grid h-7 w-7 flex-none place-items-center rounded-full bg-brand-soft text-xs">{isAssistant ? '🎬' : '🧑'}</div>
      <div className={`max-w-[82%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed ${isAssistant ? 'bg-[#f3f5f8]' : 'bg-brand-soft'}`}>
        <div>{m.text}</div>
        <div className="mt-1 text-right text-[10px] text-gray-400">{m.ts}</div>
      </div>
    </div>
  )
}

export function IntentChat() {
  const { ready, source, analyzing, parseIntent, sessionId, generating, acceptAndGenerate } = useProject()
  const setTab = useEditor((s) => s.setTab)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [turn, setTurn] = useState<IntentTurn | null>(null) // pending align/confirm turn
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState('') // transient streamed reasoning, shown only while waiting
  const loading = analyzing || busy || generating
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)

  // auto-scroll the message area and the live-reasoning box to the bottom as content streams in
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [live, msgs])

  const push = (role: 'user' | 'assistant', t: string, reasoning = false) =>
    setMsgs((m) => [...m, { id: crypto.randomUUID(), role, text: t, ts: now(), reasoning }])

  const onReasoning: OnReasoning = (delta) => setLive((s) => s + delta)

  // project a backend turn into the chat: reflection = normal reply (the streamed thinking is transient)
  const applyTurn = (t: IntentTurn) => {
    if (t.reflection) push('assistant', t.reflection)
    setTurn(t.phase === 'align' || t.phase === 'confirm' ? t : null)
    if (t.tags?.length) setTags(t.tags)
  }

  const run = async (fn: (onR: OnReasoning) => Promise<IntentTurn>) => {
    setTurn(null)
    setBusy(true)
    setLive('')
    try {
      applyTurn(await fn(onReasoning))
    } catch (e: any) {
      push('assistant', `Request failed: ${e?.message ?? e}. Is the backend running on :8000?`)
    } finally {
      setBusy(false)
      setLive('') // result is in → the gray thinking disappears
    }
  }

  const send = async () => {
    const v = text.trim()
    if (!v || loading) return
    setText('')
    push('user', v)
    if (ready && !turn) {
      push('assistant', 'Got it — re-reading your intent with the new details… (mock)')
      return
    }
    if (!sessionId) {
      if (!source) { push('assistant', 'Please upload a reference image first (top-left).'); return }
      await run((onR) => parseIntent(v, onR)) // first turn (also marks the editor ready)
      return
    }
    if (turn?.phase === 'confirm') { await run((onR) => confirmIntent(sessionId, false, v, onR)); return } // typed = refine
    await run((onR) => respond(sessionId, {}, v, onR)) // free-text answer during alignment
  }

  const acceptIntent = async () => {
    setTags(turn?.tags ?? [])
    setTurn(null)
    setTab('preview')
    push('assistant', 'Intent confirmed ✓ — reasoning out the candidate schemes… (~1–2 min, see Preview).')
    setLive('')
    try {
      await acceptAndGenerate(onReasoning)
      push('assistant', 'Schemes ready ✓ — open the Preview tab.')
    } catch (e: any) {
      push('assistant', `Scheme generation failed: ${e?.message ?? e}`)
    } finally {
      setLive('')
    }
  }

  return (
    <div className="card flex min-h-0 flex-1 flex-col p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        ✨ Intent Assistant
        <span className="ml-auto flex items-center gap-1 text-xs font-normal text-green-600">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> Online
        </span>
      </div>

      {tags.length > 0 && (
        <div className="mb-2 rounded-lg border border-[#edf0f3] bg-[#fafbfc] p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold text-gray-500">Confirmed Intents</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => <span key={t} className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">{t}</span>)}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1">
        {msgs.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 text-4xl text-brand/40">💬</div>
            <div className="text-[14px] font-semibold text-gray-600">I'm here to help you shape<br />your story into a shot plan.</div>
            <div className="mt-1 text-[12px] text-gray-400">{source ? 'Describe your intent to analyze.' : 'Upload a source to get started.'}</div>
          </div>
        ) : (
          msgs.map((m) => <Bubble key={m.id} m={m} />)
        )}

        {/* interactive alignment widgets */}
        {turn?.phase === 'align' && !!turn.widgets?.length && (
          <AlignmentPanel
            widgets={turn.widgets}
            disabled={loading}
            onSubmit={(r, summary) => {
              if (!sessionId) return
              push('user', summary) // keep the chosen answers as a record in the chat
              run((onR) => respond(sessionId, r, undefined, onR))
            }}
          />
        )}

        {/* converged brief + tags → accept or refine */}
        {turn?.phase === 'confirm' && (
          <div className="space-y-2 rounded-lg border border-[#cfe8d6] bg-[#f6fbf7] p-2.5">
            {turn.brief && <p className="text-[12px] leading-relaxed text-gray-700">{turn.brief}</p>}
            {turn.tags && turn.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {turn.tags.map((t) => <span key={t} className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">{t}</span>)}
              </div>
            )}
            <div className="flex gap-2">
              <button className="flex-1 rounded-lg bg-brand py-1.5 text-xs font-medium text-white hover:opacity-90" onClick={acceptIntent}>Accept Intent</button>
              <button className="flex-1 rounded-lg border border-slate-200 py-1.5 text-xs text-slate-600 hover:bg-slate-50" disabled={loading} onClick={() => sessionId && run((onR) => confirmIntent(sessionId, false, text.trim() || undefined, onR))}>Adjust again</button>
            </div>
          </div>
        )}

        {/* live streamed reasoning — gray, transient (disappears once the result arrives) */}
        {loading && live && (
          <div className="flex gap-2">
            <div className="grid h-7 w-7 flex-none animate-pulse place-items-center rounded-full bg-[#f1f3f6] text-xs text-gray-400">💭</div>
            <div ref={liveRef} className="max-h-40 max-w-[82%] overflow-auto whitespace-pre-wrap rounded-xl border border-dashed border-[#e6e9ed] bg-[#fafbfc] px-3 py-2 text-[12px] italic leading-relaxed text-gray-400">
              {live}
            </div>
          </div>
        )}
        {loading && !live && (
          <div className="flex items-center gap-2 text-[12px] text-gray-400">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />
            Thinking…
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 rounded-lg border border-[#e3e6ea] px-2 py-1">
        <input
          className="flex-1 bg-transparent py-1 text-sm outline-none disabled:opacity-50"
          placeholder={!sessionId ? 'Describe the mood, story, or visual goal…' : turn?.phase === 'confirm' ? 'Type to refine, or use the buttons…' : 'Add free-text, or answer the widgets above…'}
          value={text}
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button className="text-brand disabled:opacity-40" disabled={loading} onClick={send}>➤</button>
      </div>
    </div>
  )
}

function now() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}
