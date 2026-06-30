import { useState } from "react";
import type { FreeTextWidget as FreeTextWidgetT } from "@/types/api";
import type { WidgetProps } from "./registry";

/**
 * Free-text widget — user types an open-ended response.
 *
 * The value is reported on every change; clicking a suggestion fills
 * the textarea (still editable before submitting).
 */
export default function FreeTextWidget({ widget, onAnswer, disabled }: WidgetProps) {
  const w = widget as FreeTextWidgetT;
  const [text, setText] = useState("");

  const update = (value: string) => {
    setText(value);
    if (value.trim()) {
      onAnswer(value.trim());
    }
  };

  return (
    <div className="widget-compact">
      <p className="widget-label">{w.prompt}</p>
      {w.suggestions.length > 0 && (
        <div className="suggestion-group">
          {w.suggestions.map((s) => (
            <button
              key={s}
              className={`suggestion-chip${text === s ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => update(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="freetext-area"
        disabled={disabled}
        placeholder="输入你的回答…"
        rows={3}
        value={text}
        onChange={(e) => update(e.target.value)}
      />
    </div>
  );
}
