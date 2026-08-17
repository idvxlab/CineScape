import { useEffect, useMemo, useState } from 'react'
import { assetUrl, type SchemeShot } from '../api/backend'
import type { StudyBranch, StudyChoiceRequest, StudyHeldoutCase, RatingKey } from './studyStore'
import { RatingForm } from './RatingForm'

// Held-out case comparison view (ADR-0019): reference image + intent brief on top,
// two blind-labeled videos (X / Y — the backend decides which physical side maps to
// which condition; the frontend never learns it), a three-way preference pick, the
// 6-item Likert rating form, and an optional collapsible shot-script view (ten
// parameters per shot). Video rendering is asynchronous: while either video_url is
// null we show a "Rendering…" placeholder and poll the plan every 15s; the submit button
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
  { key: 'shot_size', label: 'Shot size' },
  { key: 'composition', label: 'Composition' },
  { key: 'angle', label: 'Angle' },
  { key: 'movement', label: 'Movement' },
  { key: 'focal_length', label: 'Focal length' },
  { key: 'depth_of_field', label: 'Depth of field' },
  { key: 'lighting', label: 'Lighting' },
  { key: 'color_tone', label: 'Color tone' },
  { key: 'rhythm', label: 'Rhythm' },
  { key: 'duration', label: 'Duration' },
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
        <span className="study-taskbar-title">Evaluation case {index}/{total}</span>
        <span className="study-taskbar-scene">Scene {studyCase.scene_id} · Intent {intentCode}</span>
      </div>

      {/* Internal scroll region: the comparison content (videos + ratings) scrolls
          inside the viewport-locked shell instead of growing the page. */}
      <div className="study-scroll">
        <div className="card p-4">
          <div className="eval-top">
            {referenceImage && <img className="eval-reference" src={referenceImage} alt="Reference" />}
            <div className="eval-brief">
              <strong>Creative intent:</strong>
              <p>{studyCase.brief || '—'}</p>
            </div>
          </div>

          {!bothReady && (
            <div className="eval-rendering-note">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />
              Videos are rendering (keyframes + composition, about 10–20 min per branch) — this page auto-refreshes every 15s. Feel free to take a break.
            </div>
          )}

          <div className="eval-videos">
            {[left, right].map((side) => (
              <VideoCard key={side.label} side={side} />
            ))}
          </div>

          <details className="shots-detail">
            <summary>View scripts (shot parameters of both branches)</summary>
            <div className="eval-scripts">
              {[left, right].map((side) => (
                <ScriptCard key={side.label} side={side} />
              ))}
            </div>
          </details>

          <div className="eval-choice">
            <h3>Which branch do you prefer?</h3>
            <div className="eval-preference">
              {(
                [
                  { value: 'left', label: 'X (left)' },
                  { value: 'right', label: 'Y (right)' },
                  { value: 'tie', label: 'About the same' },
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
              {submitting ? 'Submitting…' : hasSubmitted ? 'Submitted' : 'Submit preference & ratings'}
            </button>
            {!canSubmit && !hasSubmitted && (
              <p className="eval-submit-hint">
                {!bothReady ? 'Waiting for both videos to render…' : preference === null ? 'Please choose a preference (X / Y / about the same)' : !allRated ? 'Please complete all 6 ratings' : ''}
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
          Rendering…
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
        Branch {side.label}
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
        <p className="mechanism">Branch script not ready yet.</p>
      )}
      {scheme?.shots?.length ? (
        <p className="mechanism total">
          Total duration ~{totalDuration(scheme.shots)}s{scheme.overall_rationale ? ` · ${scheme.overall_rationale}` : ''}
        </p>
      ) : null}
    </div>
  )
}
