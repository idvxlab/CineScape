import { useState } from 'react'
import type { RatingKey, StudyRatings } from './studyStore'

// The 6-item 5-point Likert scale for a held-out case (ADR-0019):
// preference_fit / intent_fidelity / control / probe_burden / trust / authorship,
// each 1–5 with labelled ends, plus an optional free-text comment. Controlled component.
interface RatingItem {
  key: RatingKey
  label: string
  low: string
  high: string
}

const RATING_ITEMS: RatingItem[] = [
  { key: 'preference_fit', label: 'Overall preference fit', low: 'Strongly dislike', high: 'Strongly like' },
  { key: 'intent_fidelity', label: 'Intent fidelity', low: 'Completely off intent', high: 'Perfectly matches intent' },
  { key: 'control', label: 'Sense of control', low: 'Completely lost', high: 'Fully in control' },
  { key: 'probe_burden', label: 'Probe burden', low: 'Extremely burdensome', high: 'No burden at all' },
  { key: 'trust', label: 'Trust', low: 'Do not trust at all', high: 'Trust completely' },
  { key: 'authorship', label: 'Sense of authorship', low: 'Not my work at all', high: 'Exactly what I would make' },
]

export interface RatingFormProps {
  /** Initial ratings (e.g. when re-opening a case). */
  initial?: Partial<StudyRatings>
  /** Called on every change (parent keeps the full submission state). */
  onChange: (ratings: Partial<StudyRatings>) => void
  /** Called when the optional comment changes. */
  onCommentChange?: (comment: string) => void
  disabled?: boolean
}

export function RatingForm({ initial, onChange, onCommentChange, disabled }: RatingFormProps) {
  const [ratings, setRatings] = useState<Partial<StudyRatings>>(initial ?? {})
  const [comment, setComment] = useState('')

  const handleRating = (key: RatingKey, value: number) => {
    const next = { ...ratings, [key]: value }
    setRatings(next)
    onChange(next)
  }

  return (
    <div className="rating-form">
      {RATING_ITEMS.map((item) => (
        <div className="rating-item" key={item.key}>
          <div className="rating-header">
            <span className="rating-label">{item.label}</span>
            <span className={`rating-value ${ratings[item.key] ? 'text-brand' : 'text-gray-400'}`}>
              {ratings[item.key] ? `${ratings[item.key]}/5` : 'Not rated'}
            </span>
          </div>
          <div className="rating-scale">
            <span className="rating-end">{item.low}</span>
            {[1, 2, 3, 4, 5].map((value) => (
              <label key={value} className={`rating-option ${ratings[item.key] === value ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name={`rating-${item.key}`}
                  value={value}
                  disabled={disabled}
                  checked={ratings[item.key] === value}
                  onChange={() => handleRating(item.key, value)}
                />
                <span>{value}</span>
              </label>
            ))}
            <span className="rating-end">{item.high}</span>
          </div>
        </div>
      ))}
      <label className="rating-comment">
        <span>Comment (optional)</span>
        <textarea
          value={comment}
          disabled={disabled}
          placeholder="Anything else about these two branches…"
          onChange={(e) => {
            setComment(e.target.value)
            onCommentChange?.(e.target.value)
          }}
        />
      </label>
    </div>
  )
}
