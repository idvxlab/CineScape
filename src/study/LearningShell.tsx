import { useCallback, useEffect, useState } from 'react'
import { assetUrl, USER_ID_KEY } from '../api/backend'
import { ProjectProvider, useProject } from '../state/ProjectContext'
import { ProjectLayout } from '../components/layout/ProjectLayout'
import { useStudyStore, type StudyLearningRun } from './studyStore'

// LearningShell — wraps the existing main-flow UI (ProjectLayout: LeftPanel /
// CenterPanel / RightPanel) with a study task-context bar for one sequential
// learning session (ADR-0019). Reuses the existing components untouched.
//
// Session-creation specifics:
//  - the reference image comes from the study assets (plan.reference_image, e.g.
//    /api/uploads/study/learning-01.png), NOT a user upload — fetched into a File
//    and pushed into the ProjectContext source, so parseIntent sends it as `image`;
//  - the session's user_id is the participant's (eval-{code}), not the browser
//    default — injected into localStorage (USER_ID_KEY) while the study is mounted,
//    so the main flow's getUserId() picks it up and memory accrues per participant.

export interface LearningShellProps {
  run: StudyLearningRun
  /** Learning session k/5. */
  index: number
  /** Total learning runs (denominator). */
  total: number
  /** Participant's primary intent code. */
  intentCode: string
  /** Participant user id — the session is created under it (memory accrues). */
  userId: string
  /** Called when the participant finishes this run (refresh plan + advance). */
  onSessionDone: () => void
}

export function LearningShell({ run, index, total, intentCode, userId, onSessionDone }: LearningShellProps) {
  const [presetFailed, setPresetFailed] = useState(false)
  const handlePresetFail = useCallback(() => setPresetFailed(true), [])
  const { finishRun, finishingRunId, error } = useStudyStore()

  const finishing = finishingRunId === run.run_id

  const handleFinish = async () => {
    if (finishing) return
    try {
      // 会话边界屏障:同步整理偏好记忆(reflection 落账),成功后才进入下一步
      await finishRun(run.run_id)
      onSessionDone()
    } catch {
      // finishRun 已把错误写入 store;StudyApp 顶部会展示,保持本会话不丢状态
    }
  }
  return (
    <div className="study-shell">
      <div className="study-taskbar">
        <span className="study-taskbar-title">学习会话 {index}/{total}</span>
        <span className="study-taskbar-scene">场景 {run.scene_id} · 意图 {intentCode}</span>
        {run.brief && <span className="study-taskbar-brief">{run.brief}</span>}
      </div>

      {presetFailed && (
        <div className="study-preset-failed">
          学习素材加载失败——请手动在上方上传参考图（场景 {run.scene_id}）。
        </div>
      )}

      {/* A fresh ProjectProvider per run isolates the editor state between sessions.
          .study-shell-content pins the editor to the remaining viewport height, so the
          ProjectLayout's h-full three-column grid fills the screen instead of growing
          the page (which caused the viewport to jitter around the scrollbar threshold). */}
      <div className="study-shell-content">
        <ProjectProvider key={run.run_index}>
          <StudySourcePreset
            referenceImage={run.reference_image}
            sceneId={run.scene_id}
            userId={userId}
            onFail={handlePresetFail}
          />
          <ProjectLayout />
        </ProjectProvider>
      </div>

      <div className="study-task-actions">
        <button
          className="btn btn-primary disabled:opacity-60"
          onClick={() => void handleFinish()}
          disabled={finishing}
        >
          {finishing ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              正在整理你的偏好记忆…（约 30–60 秒）
            </span>
          ) : (
            '完成本学习会话，进入下一步 →'
          )}
        </button>
      </div>
      {error && <div className="study-error">{error}</div>}
    </div>
  )
}

// Inside the ProjectProvider: fetch the study asset → setSource(file), and make
// sure the participant's user_id is what the session creation picks up.
function StudySourcePreset({ referenceImage, sceneId, userId, onFail }: {
  referenceImage?: string | null
  sceneId: string
  userId: string
  onFail: () => void
}) {
  const { setSource, source } = useProject()
  const url = assetUrl(referenceImage)

  useEffect(() => {
    localStorage.setItem(USER_ID_KEY, userId)
  }, [userId])

  useEffect(() => {
    if (!url) {
      onFail()
      return
    }
    // Only preset when no source is set yet — setSource identity changes on every
    // provider render, so this guard also keeps the effect from re-firing in a loop.
    if (source?.file) return
    let cancelled = false
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        if (cancelled) return
        const ext = url.split('?')[0]!.split('.').pop() ?? 'png'
        const name = sceneId.includes('.') ? sceneId : `${sceneId}.${ext}`
        setSource(new File([blob], name, { type: blob.type || 'image/png' }))
      })
      .catch(() => {
        if (!cancelled) onFail()
      })
    return () => {
      cancelled = true
    }
  }, [url, sceneId, setSource, source?.file, onFail])

  return null
}
