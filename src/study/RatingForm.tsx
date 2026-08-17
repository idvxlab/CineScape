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
  { key: 'preference_fit', label: '整体偏好契合度', low: '完全不喜欢', high: '非常喜欢' },
  { key: 'intent_fidelity', label: '意图忠实度', low: '完全偏离意图', high: '精准还原意图' },
  { key: 'control', label: '掌控感', low: '完全失控', high: '完全掌控' },
  { key: 'probe_burden', label: '提问负担', low: '负担极重', high: '毫无负担' },
  { key: 'trust', label: '信任度', low: '完全不信任', high: '非常信任' },
  { key: 'authorship', label: '作者归属感', low: '完全不像我的作品', high: '完全是我想拍的' },
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
              {ratings[item.key] ? `${ratings[item.key]}/5` : '未评分'}
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
        <span>评语（可选）</span>
        <textarea
          value={comment}
          disabled={disabled}
          placeholder="补充你对这两个方案的看法…"
          onChange={(e) => {
            setComment(e.target.value)
            onCommentChange?.(e.target.value)
          }}
        />
      </label>
    </div>
  )
}
