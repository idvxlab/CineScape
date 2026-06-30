import { useState } from "react";
import type { Conflict, PatchOp, ShotScript } from "@/types/api";

export interface ShotEditorProps {
  /** The scheme being edited. */
  scheme: ShotScript;
  /** Conflicts from the previous revalidation round. */
  conflicts: Conflict[];
  /** Submit the accumulated patch (and optional free-text request). */
  onSubmit: (patch: PatchOp[], freeText?: string) => void;
  /** Whether controls should be disabled. */
  disabled?: boolean;
}

const FIELDS: { key: string; label: string }[] = [
  { key: "shot_size", label: "景别" },
  { key: "composition", label: "构图" },
  { key: "angle", label: "角度" },
  { key: "movement", label: "运镜" },
  { key: "focal_length", label: "焦距" },
  { key: "depth_of_field", label: "景深" },
  { key: "lighting", label: "光影" },
  { key: "color_tone", label: "色彩" },
  { key: "rhythm", label: "节奏" },
  { key: "duration", label: "时长" },
];

/**
 * Shot editor — edits the ten parameters of each shot in the selected
 * scheme.  Edits are diffed against the original values and submitted
 * as a field-level patch; the backend applies + revalidates.
 */
export default function ShotEditor({
  scheme,
  conflicts,
  onSubmit,
  disabled,
}: ShotEditorProps) {
  // edits["3.lighting"] = new value
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");

  const editKey = (order: number, field: string) => `${order}.${field}`;

  const buildPatch = (): PatchOp[] => {
    const patch: PatchOp[] = [];
    for (const shot of scheme.shots) {
      for (const { key } of FIELDS) {
        const k = editKey(shot.order, key);
        const edited = edits[k];
        const original = (shot as unknown as Record<string, string>)[key];
        if (edited !== undefined && edited !== original) {
          patch.push({ shot_order: shot.order, field: key, value: edited });
        }
      }
    }
    return patch;
  };

  const patchSize = buildPatch().length;

  return (
    <div className="shot-editor">
      <h3>
        方案 {scheme.scheme_id} · {scheme.strategy}
      </h3>
      <p className="mechanism">{scheme.mechanism}</p>

      {conflicts.length > 0 && (
        <div className="conflict-banner">
          <strong>一致性提示:</strong>
          <ul className="conflict-list">
            {conflicts.map((c, i) => (
              <li key={i} className="conflict-item">
                镜头{c.shot_order} · {c.field}:{c.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scheme.shots.map((shot) => (
        <div className="shot-edit-card" key={shot.order}>
          <h4>镜头 {shot.order}</h4>
          {shot.frame_image && (
            <a href={shot.frame_image} target="_blank" rel="noreferrer">
              <img
                className="shot-frame-img"
                src={shot.frame_image}
                alt={`镜头 ${shot.order} 关键帧`}
              />
            </a>
          )}
          <div className="shot-fields-grid">
            {FIELDS.map(({ key, label }) => {
              const k = editKey(shot.order, key);
              const original = (shot as unknown as Record<string, string>)[key];
              return (
                <label key={key} className="shot-field">
                  <span>{label}</span>
                  <input
                    value={edits[k] ?? original ?? ""}
                    disabled={disabled}
                    onChange={(e) =>
                      setEdits((prev) => ({ ...prev, [k]: e.target.value }))
                    }
                  />
                </label>
              );
            })}
          </div>
          <div className="shot-rationale">{shot.rationale}</div>
          {shot.frame_edit_hint && (
            <div className="frame-hint">🎞 基底图编辑指令:{shot.frame_edit_hint}</div>
          )}
        </div>
      ))}

      <label className="shot-field">
        <span>补充说明(可选,交给审校参考)</span>
        <input
          value={freeText}
          disabled={disabled}
          placeholder="例如:整体再暗一点,保持压抑感"
          onChange={(e) => setFreeText(e.target.value)}
        />
      </label>

      <button
        className="btn btn-primary"
        disabled={disabled || (patchSize === 0 && !freeText)}
        onClick={() => onSubmit(buildPatch(), freeText || undefined)}
      >
        提交修改({patchSize} 处)
      </button>
    </div>
  );
}
