import { useState } from "react";
import type { SingleWidget as SingleWidgetT } from "@/types/api";
import type { WidgetProps } from "./registry";

/**
 * Single-choice widget — user picks exactly one option.
 */
export default function SingleWidget({ widget, onAnswer, disabled }: WidgetProps) {
  const w = widget as SingleWidgetT;
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="widget-compact">
      <p className="widget-label">{w.prompt}</p>
      <div className="option-group">
        {w.options.map((opt) => (
          <button
            key={opt.value}
            className={`option-chip${selected === opt.value ? " selected" : ""}`}
            disabled={disabled}
            onClick={() => {
              setSelected(opt.value);
              onAnswer(opt.value);
            }}
          >
            {opt.label}
            {opt.hint ? ` (${opt.hint})` : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
