import { useEffect, useMemo, useState } from 'react'
import { assetUrl, type SchemeShot } from '../api/backend'
import type { StudyBranch, StudyChoiceRequest, StudyHeldoutCase, RatingKey } from './studyStore'
import { RatingForm } from './RatingForm'

// Held-out case comparison view (ADR-0019): reference image + intent brief on top,
// two blind-labeled videos (X / Y — the backend decides which physical side maps to
// which condition; the frontend never learns it), a three-way preference pick, the
// 6-item Likert rating form, and an optional collapsible shot-script view (ten
// parameters per shot). Video rendering is asynchronous: while either video_url is
// null we show a "渲染中…" placeholder and poll the plan every 15s; the submit button
// only enables once both videos are ready and all 6 ratings are in.

const POLL_INTERVAL_MS = 15_000

/** Estimate total duration (seconds) from per-shot duration strings. */
function totalDuration(shots: SchemeShot[]): number {
  return shots.reduce((sum, s) => {
    const m = /\d+(?:\.\d+)?/.exec(s.duration || '')
    return sum + (m ? parseFloat(m[0]) : 0)
  }, 0)
}

/** The ten shot parameters (ADR-0006), displayed in the script view. */
const SHOT_FIELDS: { key: keyof SchemeShot; label: string }[] = [
  { key: 'shot_size', label: '景别' },
  { key: 'composition', label: '构图' },
  { key: 'angle', label: '角度' },
  { key: 'movement', label: '运镜' },
  { key: 'focal_length', label: '焦距' },
  { key: 'depth_of_field', label: '景深' },
  { key: 'lighting', label: '光影' },
  { key: 'color_tone', label: '色彩' },
  { key: 'rhythm', label: '节奏' },
  { key: 'duration', label: '时长' },
]

const RATING_KEYS: RatingKey[] = ['preference_fit', 'intent_fidelity', 'control', 'probe_burden', 'trust', 'authorship']

export interface EvalCompareProps {
  studyCase: StudyHeldoutCase
  /** Current case number (n/6). */
  index: number
  /** Total held-out cases (denominator). */
  total: number
  /** Participant's primary intent code. */
  intentCode: string
  /** Whether a submission is in flight. */
  submitting: boolean
  /** Refresh the plan from the backend (video-render polling). */
  onRefresh: () => void
  /** Submit the preference + ratings. */
  onSubmit: (choice: StudyChoiceRequest) => void
}

export function EvalCompare({ studyCase, index, total, intentCode, submitting, onRefresh, onSubmit }: EvalCompareProps) {
  const left = studyCase.left
  const right = studyCase.right
  const bothReady = Boolean(left.video_url && right.video_url)

  const [preference, setPreference] = useState<'left' | 'right' | 'tie' | null>(null)
  const [ratings, setRatings] = useState<Partial<StudyChoiceRequest['ratings']>>({})
  const [comment, setComment] = useState('')
  const [hasSubmitted, setHasSubmitted] = useState(false)

  const allRated = useMemo(() => RATING_KEYS.every((key) => ratings[key] !== undefined), [ratings])
  const canSubmit = bothReady && preference !== null && allRated && !submitting

  // Video rendering is async: while either URL is null, poll the plan every 15s.
  useEffect(() => {
    if (bothReady) return
    const timer = window.setInterval(onRefresh, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [bothReady, onRefresh])

  const handleSubmit = () => {
    if (!preference) return
    onSubmit({
      preference,
      ratings: {
        preference_fit: ratings.preference_fit!,
        intent_fidelity: ratings.intent_fidelity!,
        control: ratings.control!,
        probe_burden: ratings.probe_burden!,
        trust: ratings.trust!,
        authorship: ratings.authorship!,
      },
      comment: comment.trim() ? comment.trim() : null,
    })
    setHasSubmitted(true)
  }

  const referenceImage = assetUrl(studyCase.reference_image)

  return (
    <div className="study-shell">
      <div className="study-taskbar">
        <span className="study-taskbar-title">评测 case {index}/{total}</span>
        <span className="study-taskbar-scene">场景 {studyCase.scene_id} · 意图 {intentCode}</span>
      </div>

      {/* Internal scroll region: the comparison content (videos + ratings) scrolls
          inside the viewport-locked shell instead of growing the page. */}
      <div className="study-scroll">
        <div className="card p-4">
          <div className="eval-top">
            {referenceImage && <img className="eval-reference" src={referenceImage} alt="参考画面" />}
            <div className="eval-brief">
              <strong>创作意图：</strong>
              <p>{studyCase.brief || '—'}</p>
            </div>
          </div>

          {!bothReady && (
            <div className="eval-rendering-note">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />
              视频渲染中（每镜关键帧 + 合成约 10–20 分钟），页面将每 15 秒自动刷新…可先休息片刻
            </div>
          )}

          <div className="eval-videos">
            {[left, right].map((side) => (
              <VideoCard key={side.label} side={side} />
            ))}
          </div>

          <details className="shots-detail">
            <summary>查看脚本（两方案的镜头参数）</summary>
            <div className="eval-scripts">
              {[left, right].map((side) => (
                <ScriptCard key={side.label} side={side} />
              ))}
            </div>
          </details>

          <div className="eval-choice">
            <h3>你更喜欢哪个方案？</h3>
            <div className="eval-preference">
              {(
                [
                  { value: 'left', label: 'X（左）' },
                  { value: 'right', label: 'Y（右）' },
                  { value: 'tie', label: '都差不多' },
                ] as const
              ).map((opt) => (
                <label key={opt.value} className={`option-chip ${preference === opt.value ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="eval-preference"
                    value={opt.value}
                    checked={preference === opt.value}
                    disabled={submitting}
                    onChange={() => setPreference(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <RatingForm disabled={submitting} onChange={setRatings} onCommentChange={setComment} />

          <div className="eval-actions">
            <button className="btn btn-primary w-full py-2.5 disabled:opacity-50" disabled={!canSubmit} onClick={handleSubmit}>
              {submitting ? '提交中…' : hasSubmitted ? '已提交' : '提交偏好与评分'}
            </button>
            {!canSubmit && !hasSubmitted && (
              <p className="eval-submit-hint">
                {!bothReady ? '等待两个视频渲染完成…' : preference === null ? '请先选择偏好（X / Y / 都差不多）' : !allRated ? '请完成全部 6 项评分' : ''}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function VideoCard({ side }: { side: StudyBranch }) {
  const url = assetUrl(side.video_url)
  return (
    <div className="eval-video-card">
      <h3 className="eval-video-label">{side.label}</h3>
      {url ? (
        <video className="eval-video" src={url} controls loop muted playsInline />
      ) : (
        <div className="eval-video-placeholder">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />
          渲染中…
        </div>
      )}
    </div>
  )
}

function ScriptCard({ side }: { side: StudyBranch }) {
  const scheme = side.scheme
  return (
    <div className="eval-script">
      <h4>
        方案 {side.label}
        {scheme?.strategy ? ` · ${scheme.strategy}` : ''}
      </h4>
      {scheme?.mechanism && <p className="mechanism">{scheme.mechanism}</p>}
      {scheme?.shots?.length ? (
        <ol className="shots-list">
          {scheme.shots.map((shot) => (
            <li key={shot.order}>
              <strong>
                {shot.shot_size} / {shot.movement} / {shot.duration}
              </strong>
              <div className="shot-params">
                {SHOT_FIELDS.filter((f) => f.key !== 'shot_size' && f.key !== 'movement').map((f) => (
                  <span key={f.key}>
                    {f.label}:{String(shot[f.key] ?? '—')}
                  </span>
                ))}
              </div>
              {shot.rationale && <div className="shot-rationale">{shot.rationale}</div>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mechanism">方案脚本尚未就绪。</p>
      )}
      {scheme?.shots?.length ? (
        <p className="mechanism total">
          总时长 ~{totalDuration(scheme.shots)}s{scheme.overall_rationale ? ` · ${scheme.overall_rationale}` : ''}
        </p>
      ) : null}
    </div>
  )
}
