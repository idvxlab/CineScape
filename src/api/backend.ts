// Client for the cinedesign intent-parsing backend (FastAPI @ :8000).
// Wires the alignment loop: create session → align widgets → respond → … → confirm (brief + tags).

const BASE = ((import.meta as any).env?.VITE_API_BASE as string) || 'http://localhost:8000/api'
export const API_BASE = BASE
const ORIGIN = BASE.replace(/\/api\/?$/, '') // http://localhost:8000 — for /api/uploads asset URLs
const TIMEOUT_MS = 1_800_000 // 30 min — scheme reasoning + Dreamina render fan out over many slow calls

// absolute URL for a backend-relative asset (/api/uploads/...)
export const assetUrl = (u?: string | null): string | undefined =>
  u ? (u.startsWith('http') ? u : `${ORIGIN}${u}`) : undefined

export interface Opt { value: string; label: string; hint?: string }
export type Widget =
  | { kind: 'single'; dim: string; prompt: string; options: Opt[] }
  | { kind: 'multi'; dim: string; prompt: string; options: Opt[] }
  | { kind: 'slider'; dim: string; prompt: string; ends: [string, string]; ticks?: string[] }
  | { kind: 'freetext'; dim?: string; prompt: string; suggestions: string[] }
  | { kind: 'confirm'; reflection: string }
  // evolutionary memory probes (ADR-0017): at most one per session, piggybacked on an align round.
  // preference_probe verifies one remembered question (a / b / open); the response key is question_id.
  // skill_activation offers the enacted workflow skill (apply / leave / forget); key is 'skill_activation'.
  | { kind: 'preference_probe'; question_id: string; prompt: string; options: Opt[] }
  | { kind: 'skill_activation'; question_ids: string[]; prompt: string; options: Opt[] }

// the session-level workflow skill enacted from corroborated preferences (view over the ledger)
export interface ActiveSkill {
  version?: number
  source_question_ids?: string[]
  rationale?: string
  workflow?: { stage: string; instruction: string; fields?: string[] }[]
  detail?: { prefer?: { field: string; values: string[] }[]; avoid?: { field: string; values: string[] }[] }
}

// one shot inside a generated scheme (the seven cinematic dimensions + rationale)
export interface SchemeShot {
  order: number
  shot_size: string
  composition: string
  angle: string
  movement: string
  focal_length: string
  depth_of_field: string
  lighting: string
  color_tone: string
  rhythm: string
  duration: string
  serves: string[]
  rationale: string
  frame_image?: string | null // rendered keyframe (Dreamina image2image)
  frame_video?: string | null // per-shot video
}
// one A/B/C candidate (a complete shot script)
export interface ShotScript {
  scheme_id: string
  strategy: string
  dominant_intents: string[]
  mechanism: string
  shots: SchemeShot[]
  overall_rationale: string
  scheme_video?: string | null // composed multi-shot video
}

export interface PatchOp { shot_order: number; field: string; value: string }

export interface IntentTurn {
  session_id: string
  phase: string // 'align' | 'confirm' | 'candidates' | 'generating' | 'done'
  reflection?: string
  reasoning?: string // the model's thinking trace (reasoning_content), trimmed
  widgets?: Widget[]
  brief?: string
  tags?: string[]
  schemes?: ShotScript[]
  reference_image?: string
  active_skill?: ActiveSkill | null // present on the candidates turn when the user applied their preferences
  probe?: Widget | null // memory probe shown on the confirm gate (ADR-0017), if any
}

export type OnReasoning = (delta: string) => void

// Run a ?stream=1 request: forward each reasoning delta to onReasoning, resolve with the final turn.
async function streamCall(path: string, init: RequestInit, onReasoning?: OnReasoning): Promise<IntentTurn> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}stream=1`, { ...init, signal: ctrl.signal })
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`backend ${res.status} ${detail}`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let turn: IntentTurn | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        const parsed = JSON.parse(data)
        if (event === 'reasoning') onReasoning?.(parsed.delta ?? '')
        else if (event === 'turn') turn = parsed
        else if (event === 'error') throw new Error(parsed.detail ?? 'backend error')
      }
    }
    if (!turn) throw new Error('no turn received from backend')
    return turn
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('request timed out (backend LLM too slow)')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export const USER_ID_KEY = 'cinescape_user_id'

// Stable per-browser user id so the evolutionary memory (preference questions,
// workflow skills) accrues across sessions. Anonymous sessions get no personalization.
export function getUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY)
  if (!id) {
    id = `u-${crypto.randomUUID()}`
    localStorage.setItem(USER_ID_KEY, id)
  }
  return id
}

// POST /api/sessions — multipart { raw_intent, image, user_id }. Streams reasoning, returns the first (align) turn.
// userId overrides the browser-stable id — used by the ADR-0019 study so memory accrues per participant.
export function createSession(rawIntent: string, image: File, onReasoning?: OnReasoning, userId?: string): Promise<IntentTurn> {
  const fd = new FormData()
  fd.append('raw_intent', rawIntent)
  fd.append('image', image)
  fd.append('user_id', userId ?? getUserId())
  return streamCall('/sessions', { method: 'POST', body: fd }, onReasoning)
}

// POST /api/sessions/{id}/respond — answer the align widgets → next turn (streams reasoning).
export function respond(sessionId: string, dimResponses: Record<string, string | string[]>, freeText?: string, onReasoning?: OnReasoning): Promise<IntentTurn> {
  return streamCall(`/sessions/${sessionId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dim_widget_responses: dimResponses, free_text: freeText }),
  }, onReasoning)
}

// POST /api/sessions/{id}/confirm — accept (true) or reject (false) the converged brief/tags (streams reasoning).
// probeResponse carries the memory-probe answer shown on the confirm gate, if the user gave one:
//   verification → { question_id, answer: 'a'|'b'|'open' }; activation → { skill_activation: 'apply'|'leave'|'forget' }.
export function confirmIntent(sessionId: string, confirmed: boolean, rejectionText?: string, onReasoning?: OnReasoning, probeResponse?: Record<string, string> | null): Promise<IntentTurn> {
  return streamCall(`/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed, rejection_text: rejectionText, probe_response: probeResponse ?? null }),
  }, onReasoning)
}

// ---- edit → render → animate pipeline (plain JSON, no streaming) ----
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
    if (!res.ok) throw new Error(`backend ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
    return await res.json()
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('request timed out')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// candidates → enter edit mode on a scheme (action 'edit') or adopt it ('writeback')
export const selectScheme = (sessionId: string, schemeId: string, action: 'edit' | 'writeback' = 'edit') =>
  postJson<IntentTurn>(`/sessions/${sessionId}/select`, { scheme_id: schemeId, action })
// apply field-level edits to the selected scheme (revalidates, returns to candidates)
export const editScheme = (sessionId: string, patch: PatchOp[], freeText?: string) =>
  postJson<IntentTurn>(`/sessions/${sessionId}/edit`, { patch, free_text: freeText })
// render keyframe images (Dreamina image2image). shotOrder set = re-render just that one shot.
// patch = the local edits to apply at render time (no need to round-trip the graph edit interrupt).
export const renderScheme = (sessionId: string, schemeId: string, shotOrder?: number, patch: PatchOp[] = []) =>
  postJson<{ scheme: ShotScript }>(`/sessions/${sessionId}/render`, { scheme_id: schemeId, shot_order: shotOrder ?? null, patch })
// compose the scheme video (Dreamina image2video) — returns the scheme with scheme_video filled.
// patch = local edits to apply so the video prompt (movement/rhythm) reflects them too.
export const animateScheme = (sessionId: string, schemeId: string, patch: PatchOp[] = []) =>
  postJson<{ scheme: ShotScript }>(`/sessions/${sessionId}/animate`, { scheme_id: schemeId, patch })
// Dreamina removes the person from the uploaded photo → a clean empty-scene background plate
export const makeBackplate = (sessionId: string) =>
  postJson<{ url: string }>(`/sessions/${sessionId}/backplate`, {})
