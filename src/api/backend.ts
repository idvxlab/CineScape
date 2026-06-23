// Client for the cinedesign intent-parsing backend (FastAPI @ :8000).
// Wires the alignment loop: create session → align widgets → respond → … → confirm (brief + tags).

const BASE = ((import.meta as any).env?.VITE_API_BASE as string) || 'http://localhost:8000/api'
const ORIGIN = BASE.replace(/\/api\/?$/, '') // http://localhost:8000 — for /api/uploads asset URLs
const TIMEOUT_MS = 1_800_000 // 30 min — scheme reasoning + 即梦 render fan out over many slow calls

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
  frame_image?: string | null // rendered keyframe (即梦 image2image)
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

// POST /api/sessions — multipart { raw_intent, image }. Streams reasoning, returns the first (align) turn.
export function createSession(rawIntent: string, image: File, onReasoning?: OnReasoning): Promise<IntentTurn> {
  const fd = new FormData()
  fd.append('raw_intent', rawIntent)
  fd.append('image', image)
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
export function confirmIntent(sessionId: string, confirmed: boolean, rejectionText?: string, onReasoning?: OnReasoning): Promise<IntentTurn> {
  return streamCall(`/sessions/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed, rejection_text: rejectionText }),
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
// render keyframe images (即梦 image2image). shotOrder set = re-render just that one shot.
export const renderScheme = (sessionId: string, schemeId: string, shotOrder?: number) =>
  postJson<{ scheme: ShotScript }>(`/sessions/${sessionId}/render`, { scheme_id: schemeId, shot_order: shotOrder ?? null })
// compose the scheme video (即梦 image2video) — returns the scheme with scheme_video filled
export const animateScheme = (sessionId: string, schemeId: string) =>
  postJson<{ scheme: ShotScript }>(`/sessions/${sessionId}/animate`, { scheme_id: schemeId })
