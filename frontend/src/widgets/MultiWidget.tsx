import { useState } from "react";
import type { MultiWidget as MultiWidgetT } from "@/types/api";
import type { WidgetProps } from "./registry";

/**
 * Multi-select widget — user toggles zero or more options.
 *
 * Selections accumulate locally; every toggle reports the full array
 * upward so the panel always holds the complete selection.
 */
export default function MultiWidget({ widget, onAnswer, disabled }: WidgetProps) {
  const w = widget as MultiWidgetT;
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    setSelected(next);
    onAnswer(next);
  };

  return (
    <div className="widget-compact">
      <p className="widget-label">{w.prompt}</p>
      <div className="option-group">
        {w.options.map((opt) => (
          <button
            key={opt.value}
            className={`option-chip${selected.includes(opt.value) ? " selected" : ""}`}
            disabled={disabled}
            onClick={() => toggle(opt.value)}
          >
            {opt.label}
            {opt.hint ? ` (${opt.hint})` : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
