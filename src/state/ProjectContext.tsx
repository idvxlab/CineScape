import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Project, Plan, Shot, SevenDims, Anchor } from '../api/types'
import { mockProject, createProjectFromImage } from '../api/mock'
import { createSession, confirmIntent, renderScheme, animateScheme, makeBackplate, assetUrl, type IntentTurn, type ShotScript, type OnReasoning } from '../api/backend'
import { schemesToPlans, dimsToPatch, shotReading } from '../lib/schemeMap'

interface Ctx {
  project: Project
  activePlan: Plan
  activeShot: Shot
  setActivePlan(id: string): void
  setActiveShot(id: string): void
  editShot(id: string, patch: Partial<Pick<Shot, 'anchor' | 'dims' | 'promptSummary' | 'role' | 'label'>>): void
  dirty: boolean
  saveProject(): Promise<void>
  ready: boolean // intent parsed → the editor is populated
  analyzing: boolean // backend intent parsing in progress
  source: { file: File | null; url: string } | null // uploaded reference image
  setSource(file: File): void
  backplate: string | null // 即梦-generated person-removed background plate (the 3D stage backdrop)
  makingBackplate: boolean // backplate generation in progress
  parseIntent(rawIntent: string, onReasoning?: OnReasoning): Promise<IntentTurn> // calls the cinedesign backend
  loadDemo(): void // load the saved real run (or mock fallback) — skip upload/analyze/generate
  saveDemo(): boolean // persist the current run (plans/schemes/source/session) as the reusable seed
  sessionId: string | null
  schemes: ShotScript[] // real generated shot schemes (not mock)
  generating: boolean // scheme inference in progress
  acceptAndGenerate(onReasoning?: OnReasoning): Promise<void> // confirm intent → backend reasons out the candidate schemes
  renderingScheme: boolean
  renderingShot: number | null // index of the single shot being re-rendered (null = whole scheme)
  animatingScheme: boolean
  sceneVideo: string | null
  generateKeyframes(shotIndex?: number): Promise<void> // push 3D edits → render keyframes (即梦); shotIndex = just one
  generateVideo(): Promise<void> // compose the scheme video (即梦)
}

const ProjectCtx = createContext<Ctx | null>(null)

export function ProjectProvider({ children }: { children: ReactNode }) {
  // mockProject is kept as the (post-analysis) editor data; the UI stays empty until `ready`.
  const [project, setProject] = useState<Project>(mockProject)
  const [dirty, setDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [source, setSourceState] = useState<{ file: File | null; url: string } | null>(null)
  const [referenceImage, setReferenceImage] = useState<string | null>(null) // backend /api/uploads URL (small)
  const [backplate, setBackplate] = useState<string | null>(null)
  const [makingBackplate, setMakingBackplate] = useState(false)

  const SEED_KEY = 'icd-demo-seed'

  // persist the current (real) run so it can be reloaded instantly later (across refreshes).
  // Backend session lives in Postgres + rendered files on disk, so render/animate keep working.
  const saveDemo = (): boolean => {
    try {
      // strip heavy data-URLs (the uploaded image is embedded in source.url + every shot thumbnail) →
      // replace with the small backend /api/uploads URL so the seed fits localStorage.
      const ref = referenceImage || (project.source.url?.startsWith('data:') ? '' : project.source.url)
      const clean = (u?: string) => (!u || u.startsWith('data:') ? ref : u)
      const sProject = {
        ...project,
        source: { ...project.source, url: clean(project.source.url) },
        plans: project.plans.map((pl) => ({ ...pl, shots: pl.shots.map((sh) => ({ ...sh, thumbnailUrl: clean(sh.thumbnailUrl) })) })),
      }
      localStorage.setItem(SEED_KEY, JSON.stringify({ project: sProject, schemes, sourceUrl: clean(source?.url), sessionId, backplate }))
      return true
    } catch {
      return false // likely quota (large data-URL image with no backend reference)
    }
  }

  // load the saved real run if present, else the mock plan — skips upload/analyze/generate.
  const loadDemo = () => {
    try {
      const raw = localStorage.getItem(SEED_KEY)
      if (raw) {
        const s = JSON.parse(raw)
        setProject(s.project)
        setSchemes(s.schemes ?? [])
        setSessionId(s.sessionId ?? null)
        setSourceState({ file: null, url: s.sourceUrl ?? s.project?.source?.url })
        setBackplate(s.backplate ?? null)
        setReady(true)
        return
      }
    } catch {
      /* fall through to mock */
    }
    setSourceState({ file: null, url: mockProject.source.url })
    setProject(mockProject)
    setSessionId(null)
    setSchemes([])
    setReady(true)
  }
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [schemes, setSchemes] = useState<ShotScript[]>([])
  const [generating, setGenerating] = useState(false)
  const [renderingScheme, setRenderingScheme] = useState(false)
  const [renderingShot, setRenderingShot] = useState<number | null>(null)
  const [animatingScheme, setAnimatingScheme] = useState(false)
  const [sceneVideo, setSceneVideo] = useState<string | null>(null)

  const setSource = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setSourceState({ file, url: String(reader.result) })
    reader.readAsDataURL(file)
    setBackplate(null) // reset; the clean backdrop is generated after intent parsing (needs the backend session)
  }

  // raw intent + uploaded image → cinedesign backend; on success populate the editor and mark ready
  const parseIntent = async (rawIntent: string, onReasoning?: OnReasoning): Promise<IntentTurn> => {
    if (!source?.file) throw new Error('请先上传参考画面')
    setAnalyzing(true)
    try {
      const turn = await createSession(rawIntent, source.file, onReasoning)
      setSessionId(turn.session_id)
      setReferenceImage(assetUrl(turn.reference_image) ?? null) // backend-hosted copy of the upload (small URL)
      setProject(createProjectFromImage(source.url))
      setReady(true)
      // 即梦 removes the person → clean empty-scene plate used as the 3D stage backdrop (fire-and-forget)
      setMakingBackplate(true)
      makeBackplate(turn.session_id)
        .then(({ url }) => setBackplate(assetUrl(url) ?? null))
        .catch((e) => console.warn('backplate failed', e))
        .finally(() => setMakingBackplate(false))
      return turn
    } finally {
      setAnalyzing(false)
    }
  }

  // confirm the converged intent → backend reasons out the candidate shot schemes (real, not mock)
  const acceptAndGenerate = async (onReasoning?: OnReasoning) => {
    if (!sessionId) return
    setGenerating(true)
    try {
      const turn = await confirmIntent(sessionId, true, undefined, onReasoning)
      if (turn.schemes?.length) {
        setSchemes(turn.schemes)
        // map the real schemes into editable plans → ShotStrip / Edit / activeShot all follow them
        const plans = schemesToPlans(turn.schemes, source?.url ?? project.source.url)
        if (plans.length) {
          setProject((p) => ({ ...p, plans, activePlanId: plans[0].id, activeShotId: plans[0].shots[0]?.id ?? p.activeShotId }))
        }
      }
    } finally {
      setGenerating(false)
    }
  }

  const activeSchemeIndex = () => ['A', 'B', 'C'].indexOf(activePlan.variant)

  // push the active scheme's (edited) dims to the backend, then render keyframes.
  // shotIndex set → patch + re-render just that one shot; otherwise the whole scheme.
  const generateKeyframes = async (shotIndex?: number) => {
    const idx = activeSchemeIndex()
    const scheme = schemes[idx]
    if (!sessionId || !scheme) return
    const single = shotIndex != null
    if (single) setRenderingShot(shotIndex)
    else setRenderingScheme(true)
    try {
      const targets = single ? [shotIndex] : activePlan.shots.map((_, i) => i)
      const patch = targets.flatMap((i) => dimsToPatch(activePlan.shots[i]!.dims, scheme.shots[i]?.order ?? i + 1))
      const order = single ? scheme.shots[shotIndex]?.order : undefined
      // edits travel with the render call (render applies the patch itself) — no graph edit-interrupt
      // round-trip, so loading a历史 session (no longer waiting in candidates) can still re-render.
      const { scheme: rendered } = await renderScheme(sessionId, scheme.scheme_id, order, patch) // 即梦 image2image
      setSchemes((prev) => prev.map((s, k) => (k === idx ? rendered : s)))
      const bust = Date.now() // rendered files reuse the same name → bust the browser cache
      const targetSet = new Set(targets)
      setProject((p) => ({
        ...p,
        plans: p.plans.map((pl) =>
          pl.id !== activePlan.id
            ? pl
            : {
                ...pl,
                shots: pl.shots.map((sh, i) => {
                  const img = assetUrl(rendered.shots[i]?.frame_image)
                  const next = { ...sh, thumbnailUrl: img ? `${img}?t=${bust}` : sh.thumbnailUrl }
                  if (targetSet.has(i)) {
                    // refresh title (shot size) + prompt to reflect the edits; keep the agent's narrative
                    const r = shotReading(sh.dims)
                    next.label = r.label
                    next.promptSummary = r.prompt
                  }
                  return next
                }),
              },
        ),
      }))
    } finally {
      setRenderingShot(null)
      setRenderingScheme(false)
    }
  }

  // compose the active scheme's video from its rendered keyframes
  const generateVideo = async () => {
    const idx = activeSchemeIndex()
    const scheme = schemes[idx]
    if (!sessionId || !scheme) return
    setAnimatingScheme(true)
    try {
      // carry the same local edits as render so the video's motion/rhythm prompt matches the keyframes
      const patch = activePlan.shots.flatMap((sh, i) => dimsToPatch(sh.dims, scheme.shots[i]?.order ?? i + 1))
      const { scheme: animated } = await animateScheme(sessionId, scheme.scheme_id, patch)
      setSchemes((prev) => prev.map((s, k) => (k === idx ? animated : s)))
      const v = assetUrl(animated.scheme_video)
      setSceneVideo(v ? `${v}?t=${Date.now()}` : null)
    } finally {
      setAnimatingScheme(false)
    }
  }

  const activePlan = useMemo(
    () => project.plans.find((p) => p.id === project.activePlanId) ?? project.plans[0],
    [project],
  )
  const activeShot = useMemo(
    () => activePlan.shots.find((s) => s.id === project.activeShotId) ?? activePlan.shots[0],
    [activePlan, project.activeShotId],
  )

  const setActivePlan = (id: string) =>
    setProject((p) => ({ ...p, activePlanId: id, activeShotId: p.plans.find((x) => x.id === id)?.shots[0].id ?? p.activeShotId }))
  const setActiveShot = (id: string) => setProject((p) => ({ ...p, activeShotId: id }))

  const editShot: Ctx['editShot'] = (id, patch) => {
    setProject((p) => ({
      ...p,
      plans: p.plans.map((pl) =>
        pl.id !== p.activePlanId ? pl : { ...pl, shots: pl.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) },
      ),
      updatedAt: new Date().toISOString(),
    }))
    setDirty(true)
  }

  const saveProject = async () => {
    await new Promise((r) => setTimeout(r, 200))
    setDirty(false)
  }

  const value: Ctx = { project, activePlan, activeShot, setActivePlan, setActiveShot, editShot, dirty, saveProject, ready, analyzing, source, setSource, backplate, makingBackplate, parseIntent, loadDemo, saveDemo, sessionId, schemes, generating, acceptAndGenerate, renderingScheme, renderingShot, animatingScheme, sceneVideo, generateKeyframes, generateVideo }
  return <ProjectCtx.Provider value={value}>{children}</ProjectCtx.Provider>
}

export function useProject() {
  const c = useContext(ProjectCtx)
  if (!c) throw new Error('useProject must be used within ProjectProvider')
  return c
}

export type { SevenDims, Anchor }
