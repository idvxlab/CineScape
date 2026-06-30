import type { Conflict, ShotScript } from "@/types/api";

export interface ScriptCompareProps {
  /** The A/B/C script schemes to compare. */
  schemes: ShotScript[];
  /** Revalidation conflicts from the last edit round, if any. */
  conflicts?: Conflict[];
  /** Scheme the user worked on last, if any. */
  selectedId?: string | null;
  /** Scheme currently being rendered into keyframes, if any. */
  renderingId?: string | null;
  /** Scheme currently being animated into videos, if any. */
  animatingId?: string | null;
  /** 采纳:adopt the scheme and finish the session. */
  onAdopt: (schemeId: string) => void;
  /** 编辑:enter the edit loop for the scheme. */
  onEdit: (schemeId: string) => void;
  /** 渲染图片:generate keyframes for the scheme (基底图 + 重摄指令). */
  onRender: (schemeId: string) => void;
  /** 渲染视频:全方案关键帧 → 一段连贯多镜头视频 (即梦全能参考 multimodal2video). */
  onAnimate: (schemeId: string) => void;
  /** Whether actions should be disabled. */
  disabled?: boolean;
}

/**
 * A/B/C script comparison — shows generated shot scripts side by side;
 * each card offers 采纳 (writeback) and 编辑 (edit loop).
 */
export default function ScriptCompare({
  schemes,
  conflicts,
  selectedId,
  renderingId,
  animatingId,
  onAdopt,
  onEdit,
  onRender,
  onAnimate,
  disabled,
}: ScriptCompareProps) {
  return (
    <div>
      {conflicts && conflicts.length > 0 && (
        <div className="conflict-banner">
          <strong>上轮编辑的一致性提示:</strong>
          <ul className="conflict-list">
            {conflicts.map((c, i) => (
              <li key={i} className="conflict-item">
                镜头{c.shot_order} · {c.field}:{c.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="scheme-grid">
        {schemes.map((s) => (
          <div
            key={s.scheme_id}
            className="scheme-card"
            style={{
              borderColor:
                s.scheme_id === selectedId ? "var(--color-primary)" : undefined,
            }}
          >
            <h3>
              方案 {s.scheme_id} · {s.strategy}
            </h3>
            <div className="mechanism">{s.mechanism}</div>
            <div className="tags">
              {(s.dominant_intents || []).map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
            {s.shots.some((shot) => shot.frame_image) && (
              <div className="frame-strip">
                {s.shots.map(
                  (shot) =>
                    shot.frame_image && (
                      <a
                        key={shot.order}
                        href={shot.frame_image}
                        target="_blank"
                        rel="noreferrer"
                        title={`镜头 ${shot.order}`}
                      >
                        <img src={shot.frame_image} alt={`镜头 ${shot.order} 关键帧`} />
                        <span>#{shot.order}</span>
                      </a>
                    ),
                )}
              </div>
            )}
            {s.scheme_video && (
              <div className="scheme-video" title="全能参考合成的多镜头连贯视频">
                <video
                  src={s.scheme_video}
                  controls
                  loop
                  muted
                  playsInline
                  preload="metadata"
                />
                <span>▶ 全片 · {s.shots.length} 镜连贯</span>
              </div>
            )}
            <details className="shots-detail">
              <summary>{s.shots.length} 个镜头</summary>
              <ol className="shots-list">
                {s.shots.map((shot) => (
                  <li key={shot.order}>
                    <strong>
                      {shot.shot_size} / {shot.movement} / {shot.duration}
                    </strong>
                    <div className="shot-rationale">{shot.rationale}</div>
                    {shot.frame_edit_hint && (
                      <div className="frame-hint">🎞 {shot.frame_edit_hint}</div>
                    )}
                  </li>
                ))}
              </ol>
            </details>
            <p className="mechanism" style={{ fontSize: "0.8rem" }}>
              {s.overall_rationale}
            </p>
            <div className="scheme-actions">
              <button
                className="btn btn-primary select-btn"
                disabled={disabled}
                onClick={() => onAdopt(s.scheme_id)}
              >
                采纳此方案
              </button>
              <button
                className="btn select-btn"
                disabled={disabled}
                onClick={() => onEdit(s.scheme_id)}
              >
                编辑此方案
              </button>
              <button
                className="btn select-btn"
                disabled={disabled || renderingId !== null || animatingId !== null}
                onClick={() => onRender(s.scheme_id)}
              >
                {renderingId === s.scheme_id
                  ? "渲染中…"
                  : s.shots.some((shot) => shot.frame_image)
                    ? "重新渲染图片"
                    : "渲染图片"}
              </button>
              <button
                className="btn select-btn"
                disabled={
                  disabled ||
                  renderingId !== null ||
                  animatingId !== null ||
                  !s.shots.some((shot) => shot.frame_image)
                }
                title={
                  s.shots.some((shot) => shot.frame_image)
                    ? "全方案关键帧按顺序作参考,合成一段连贯的多镜头视频"
                    : "请先渲染图片(关键帧)"
                }
                onClick={() => onAnimate(s.scheme_id)}
              >
                {animatingId === s.scheme_id
                  ? "合成视频中…"
                  : s.scheme_video
                    ? "重新合成视频"
                    : "合成视频"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
