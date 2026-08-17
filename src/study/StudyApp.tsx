import { useCallback, useEffect } from 'react'
import './study.css'
import { useStudyStore, isRunDone, isCaseDone, totalTasks } from './studyStore'
import { LearningShell } from './LearningShell'
import { EvalCompare } from './EvalCompare'

// StudyApp — entry component for the longitudinal user study view (ADR-0019),
// mounted by App.tsx when the URL carries `?study=<participantCode>`.
// Renders a top task progress bar (learning 5 + heldout 6, clickable; done/current
// colored) and the current task: LearningShell (main-flow UI wrapped in a context
// bar) / EvalCompare (blind X/Y comparison + ratings) / the completion page.
//
// NOTE: all hooks must run unconditionally BEFORE the early returns, or React
// throws "change in the order of Hooks" and the tree unmounts to a blank page.

export interface StudyAppProps {
  /** Participant code from the URL, e.g. "P01". */
  participantCode: string
}

export function StudyApp({ participantCode }: StudyAppProps) {
  const {
    plan,
    currentLearning,
    currentCase,
    loading,
    error,
    loadPlan,
    refreshPlan,
    setCurrentIndex,
    nextTask,
    submitChoice,
    visited,
  } = useStudyStore()

  // Load the plan once per participant code.
  useEffect(() => {
    void loadPlan(participantCode)
  }, [participantCode, loadPlan])

  const handleRefresh = useCallback(() => {
    void refreshPlan()
  }, [refreshPlan])

  if (loading && !plan) {
    return <div className="study-loading"><span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />正在加载评测任务…</div>
  }

  if (error && !plan) {
    return (
      <div className="study-header-card">
        <div className="study-error">{error}</div>
        <button className="btn" onClick={() => void loadPlan(participantCode)}>重试</button>
      </div>
    )
  }

  if (!plan) return null

  const participant = plan.participant
  const total = totalTasks(plan)
  const doneCount = plan.learning.filter(isRunDone).length + plan.heldout.filter(isCaseDone).length
  const currentIndex = currentLearning
    ? plan.learning.findIndex((r) => r.run_index === currentLearning.run_index)
    : currentCase
      ? plan.learning.length + plan.heldout.findIndex((c) => c.id === currentCase.id)
      : -1

  const progressLabel =
    currentIndex >= 0 && currentIndex < plan.learning.length
      ? `学习 ${currentIndex + 1}/${plan.learning.length}`
      : currentIndex >= 0
        ? `评测 ${currentIndex - plan.learning.length + 1}/${plan.heldout.length}`
        : '任务'

  const handleLearningDone = () => {
    // The session was created under the participant user_id; the backend registers
    // the run and flips session_id on the plan. Refresh, then advance.
    void refreshPlan().then(() => {
      nextTask()
    })
  }

  return (
    <div className="study-app">
      <div className="study-header">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white">🧪</div>
          <div>
            <h1 className="text-[17px] font-bold">纵向用户评测</h1>
            <p className="text-xs text-gray-400">
              {participant.participant_code} ·{' '}
              {participant.literacy === 'novice'
                ? '日常用户'
                : participant.literacy === 'intermediate'
                  ? '进阶用户'
                  : participant.literacy === 'expert'
                    ? '专业用户'
                    : participant.literacy}{' '}
              · 意图 {participant.intent_code}
            </p>
          </div>
        </div>
      </div>

      <div className="study-progress">
        <div className="study-progress-track">
          {plan.learning.map((run, i) => (
            <button
              key={`l${run.run_index}`}
              className={`study-progress-seg ${isRunDone(run) ? 'done' : ''} ${currentIndex === i ? 'current' : ''}`}
              title={`学习会话 ${i + 1}${run.session_id ? '（已完成）' : ''}`}
              onClick={() => setCurrentIndex(i)}
            />
          ))}
          {plan.heldout.map((studyCase, i) => (
            <button
              key={`h${studyCase.id}`}
              className={`study-progress-seg ${isCaseDone(studyCase) ? 'done' : ''} ${currentIndex === plan.learning.length + i ? 'current' : ''}`}
              title={`评测 case ${i + 1}${studyCase.status === 'done' ? '（已完成）' : ''}`}
              onClick={() => setCurrentIndex(plan.learning.length + i)}
            />
          ))}
        </div>
        <div className="study-progress-label">
          {progressLabel} · 已完成 {doneCount}/{total}
        </div>
      </div>
      {/* Keep every visited task MOUNTED (hidden when not current) instead of
          unmounting on switch — the editor state (session/project/schemes) lives
          in each run's ProjectProvider instance, and remounting it would reset
          everything to the initial mock state. Hidden shells stay inert. */}
      {plan.learning.map((run, i) => (
        <div key={`l-${run.run_index}`} className="study-shell-root" style={{ display: currentIndex === i ? 'flex' : 'none' }}>
          {visited.includes(i) && (
            <LearningShell
              run={run}
              index={i + 1}
              total={plan.learning.length}
              intentCode={participant.intent_code}
              userId={participant.user_id}
              onSessionDone={handleLearningDone}
            />
          )}
        </div>
      ))}
      {plan.heldout.map((studyCase, i) => {
        const idx = plan.learning.length + i
        return (
          <div key={`h-${studyCase.id}`} className="study-shell-root" style={{ display: currentIndex === idx ? 'flex' : 'none' }}>
            {visited.includes(idx) && (
              <EvalCompare
                studyCase={studyCase}
                index={studyCase.case_index}
                total={plan.heldout.length}
                intentCode={participant.intent_code}
                submitting={loading}
                onRefresh={handleRefresh}
                onSubmit={(choice) => {
                  void submitChoice(choice).then(() => {
                    nextTask()
                  })
                }}
              />
            )}
          </div>
        )
      })}

      {currentIndex < 0 && (
        <div className="study-done-panel">
          <h2>✓ 全部任务完成</h2>
          <p>感谢参与本次纵向评测！请通知实验员进行访谈。</p>
        </div>
      )}
    </div>
  )
}
