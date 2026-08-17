// Study store (ADR-0019) — participant / plan / task progress for the longitudinal
// user-study view. Backed by the project's tinyStore (zustand-style, no dependency).
//
// Progress is derived deterministically from the plan snapshot:
// a learning run is "done" once it has a session_id, a held-out case is "done"
// once its status is "done" (backend flips it after choice submission).
import { create } from '../state/tinyStore'
import { API_BASE, type ShotScript } from '../api/backend'

// ---- ADR-0019 API contract (CineScape backend /api/study) ----
export interface StudyParticipant {
  id: string
  participant_code: string
  literacy: string // novice | intermediate | expert
  intent_code: string // 1.5 | 3.4 | 8.2
  user_id: string // eval-{code} — sessions must be created under this id so memory accrues
}

export interface StudySceneCard {
  scene_id?: string
  title?: string
  description?: string
  [key: string]: unknown
}

export interface StudyLearningRun {
  run_index: number
  scene_id: string
  scene_card?: StudySceneCard | string | null
  reference_image?: string | null
  brief?: string | null
  status: string // pending | in_progress | done
  session_id?: string | null // set once the backend registers the created session
  run_id: string
}

export interface StudyBranch {
  label: string // "X" | "Y"
  is_with: boolean
  video_url?: string | null
  scheme?: ShotScript | null
}

export interface StudyHeldoutCase {
  id: string
  case_index: number
  scene_id: string
  scene_card?: StudySceneCard | string | null
  reference_image?: string | null
  brief?: string | null
  condition_order: string // with_first | without_first
  status: string // pending | aligning | generating | comparing | done
  left: StudyBranch
  right: StudyBranch
}

export interface StudyPlan {
  participant: StudyParticipant
  intent_code: string
  literacy: string
  learning: StudyLearningRun[]
  heldout: StudyHeldoutCase[]
}

export type RatingKey = 'preference_fit' | 'intent_fidelity' | 'control' | 'probe_burden' | 'trust' | 'authorship'
export type StudyRatings = Record<RatingKey, number>
export interface StudyChoiceRequest {
  preference: 'left' | 'right' | 'tie'
  ratings: StudyRatings
  comment: string | null
}

interface StudyStore {
  participantCode: string | null
  participantId: string | null
  plan: StudyPlan | null
  currentLearning: StudyLearningRun | null
  currentCase: StudyHeldoutCase | null
  loading: boolean
  error: string | null
  /** Task indices the participant has opened; their editor instances stay mounted. */
  visited: number[]

  loadPlan: (participantCode: string) => Promise<void>
  refreshPlan: () => Promise<void>
  setCurrentIndex: (index: number) => void
  nextTask: () => void
  submitChoice: (choice: StudyChoiceRequest) => Promise<void>
  /** run_id 正在做记忆整理(完成会话屏障)。 */
  finishingRunId: string | null
  /** 同步整理该学习会话的偏好记忆(reflection 落账),完成后刷新 plan。 */
  finishRun: (runId: string) => Promise<void>
}

/** Mark a task index as visited (its editor instance is then kept mounted). */
function markVisited(set: (partial: Partial<StudyStore>) => void, get: () => StudyStore, index: number): void {
  const visited = get().visited
  if (visited.includes(index)) return
  set({ visited: [...visited, index] })
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      /* keep statusText */
    }
    throw new Error(`API ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

/** Whether a learning run counts as finished (backend registered its session). */
export function isRunDone(run: StudyLearningRun): boolean {
  return Boolean(run.session_id)
}

/** Whether a held-out case counts as finished. */
export function isCaseDone(studyCase: StudyHeldoutCase): boolean {
  return studyCase.status === 'done'
}

/** First unfinished task index across learning + heldout, or null when all done. */
export function nextTaskIndex(plan: StudyPlan | null): number | null {
  if (!plan) return null
  const total = plan.learning.length + plan.heldout.length
  for (let i = 0; i < total; i += 1) {
    if (i < plan.learning.length) {
      if (!isRunDone(plan.learning[i]!)) return i
    } else {
      if (!isCaseDone(plan.heldout[i - plan.learning.length]!)) return i
    }
  }
  return null
}

/** Total task count (learning + heldout). */
export function totalTasks(plan: StudyPlan | null): number {
  if (!plan) return 0
  return plan.learning.length + plan.heldout.length
}

export const useStudyStore = create<StudyStore>((set, get) => ({
  participantCode: null,
  participantId: null,
  plan: null,
  currentLearning: null,
  currentCase: null,
  loading: false,
  error: null,
  finishingRunId: null,
  visited: [],

  loadPlan: async (participantCode: string) => {
    set({ participantCode, loading: true, error: null })
    try {
      const participant = await apiFetch<StudyParticipant>(`/study/participants/${encodeURIComponent(participantCode)}`)
      const plan = await apiFetch<StudyPlan>(`/study/participants/${participant.id}/plan`)
      set({ participantId: participant.id, plan })
      const index = nextTaskIndex(plan)
      if (index !== null) {
        markVisited(set, get, index)
        const total = totalTasks(plan)
        if (index < plan.learning.length) set({ currentLearning: plan.learning[index]!, currentCase: null })
        else if (index < total) set({ currentLearning: null, currentCase: plan.heldout[index - plan.learning.length]! })
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  refreshPlan: async () => {
    const participantId = get().participantId
    if (!participantId) return
    set({ loading: true, error: null })
    try {
      const plan = await apiFetch<StudyPlan>(`/study/participants/${participantId}/plan`)
      set({ plan })
      // Keep the currently shown task in sync with fresh backend state.
      const currentCase = get().currentCase
      if (currentCase) {
        const fresh = plan.heldout.find((c) => c.id === currentCase.id)
        if (fresh) set({ currentCase: fresh })
      } else {
        const currentLearning = get().currentLearning
        if (currentLearning) {
          const fresh = plan.learning.find((r) => r.run_index === currentLearning.run_index)
          if (fresh) set({ currentLearning: fresh })
        }
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  setCurrentIndex: (index: number) => {
    const plan = get().plan
    if (!plan) return
    markVisited(set, get, index)
    if (index < plan.learning.length) {
      set({ currentLearning: plan.learning[index]!, currentCase: null })
    } else {
      const studyCase = plan.heldout[index - plan.learning.length]
      if (studyCase) set({ currentLearning: null, currentCase: studyCase })
    }
  },

  nextTask: () => {
    const plan = get().plan
    if (!plan) return
    const next = nextTaskIndex(plan)
    // All tasks finished → clear the current task so StudyApp shows the done page.
    if (next === null) {
      set({ currentLearning: null, currentCase: null })
      return
    }
    const { currentLearning, currentCase } = get()
    const currentIndex = currentLearning
      ? plan.learning.findIndex((r) => r.run_index === currentLearning.run_index)
      : currentCase
        ? plan.learning.length + plan.heldout.findIndex((c) => c.id === currentCase.id)
        : -1
    // Prefer the next unfinished task after the current one; otherwise the first unfinished.
    const target = currentIndex >= 0 && next <= currentIndex ? currentIndex + 1 : next
    if (target < totalTasks(plan)) get().setCurrentIndex(target)
    else set({ currentLearning: null, currentCase: null })
  },

  submitChoice: async (choice: StudyChoiceRequest) => {
    const currentCase = get().currentCase
    if (!currentCase) return
    set({ loading: true, error: null })
    try {
      await apiFetch(`/study/cases/${currentCase.id}/choice`, {
        method: 'POST',
        body: JSON.stringify(choice),
      })
      await get().refreshPlan()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },

  finishRun: async (runId: string) => {
    set({ finishingRunId: runId, error: null })
    try {
      // 会话边界屏障:后端同步跑 reflection,下一个会话才能召回完整记忆
      await apiFetch(`/study/runs/${runId}/finish`, { method: 'POST' })
      await get().refreshPlan()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      set({ finishingRunId: null })
    }
  },
 }))
