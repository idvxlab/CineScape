import { useState } from "react";
import type { SliderWidget as SliderWidgetT } from "@/types/api";
import type { WidgetProps } from "./registry";

/**
 * Slider widget — user picks a position between two labelled ends
 * (双极轴,如 节奏快慢 6.1↔6.2).
 *
 * The raw 0-100 position is translated into a semantic answer the
 * backend LLM can read: the nearer pole (tick code when provided,
 * otherwise the end label) plus a leaning annotation.
 */
export default function SliderWidget({ widget, onAnswer, disabled }: WidgetProps) {
  const w = widget as SliderWidgetT;
  const [value, setValue] = useState(50);

  const describe = (v: number): string => {
    const [left, right] = w.ends;
    const leftCode = w.ticks?.[0];
    const rightCode = w.ticks?.[w.ticks.length - 1];
    if (v < 40) {
      const strength = v < 15 ? "强烈" : "偏向";
      return `${strength}${left}${leftCode ? `(${leftCode})` : ""}`;
    }
    if (v > 60) {
      const strength = v > 85 ? "强烈" : "偏向";
      return `${strength}${right}${rightCode ? `(${rightCode})` : ""}`;
    }
    return `两者均衡(介于 ${left} 与 ${right} 之间)`;
  };

  return (
    <div className="widget-compact">
      <p className="widget-label">{w.prompt}</p>
      <div className="slider-container">
        <div className="slider-labels">
          <span>{w.ends[0]}</span>
          <span>{w.ends[1]}</span>
        </div>
        <input
          type="range"
          disabled={disabled}
          min={0}
          max={100}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            setValue(v);
            onAnswer(describe(v));
          }}
        />
        <div className="slider-value">{describe(value)}</div>
      </div>
    </div>
  );
}
