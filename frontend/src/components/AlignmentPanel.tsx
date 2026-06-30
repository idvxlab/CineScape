import { useState } from "react";
import type { Widget } from "@/types/api";
import type { WidgetProps } from "@/widgets/registry";
import { widgetRegistry } from "@/widgets/registry";

export interface AlignmentPanelProps {
  /** Widgets for the current alignment round. */
  widgets: Widget[];
  /** Reflection (可被否定的复述) from the backend. */
  reflection: string;
  /** Submit answers back to the backend. */
  onSubmit: (responses: Record<string, string | string[]>) => void;
  /** Whether controls should be disabled. */
  disabled?: boolean;
}

/** Extract a stable key/dim for a widget. Uses dim if present, else kind + index. */
function widgetDim(widget: Widget, fallbackIndex: number): string {
  if ("dim" in widget && widget.dim) return widget.dim;
  return `${widget.kind}-${fallbackIndex}`;
}

/**
 * Multi-turn alignment panel — renders a dynamic set of widgets
 * for each alignment round until convergence.
 *
 * Answers are collected in React state and handed to onSubmit as one
 * batch; the parent posts them to the backend.
 */
export default function AlignmentPanel({
  widgets,
  reflection,
  onSubmit,
  disabled,
}: AlignmentPanelProps) {
  const [responses, setResponses] = useState<Record<string, string | string[]>>({});

  const handleAnswer = (dim: string, value: string | string[]) => {
    setResponses((prev) => ({ ...prev, [dim]: value }));
  };

  const answered = Object.keys(responses).length > 0;

  return (
    <div className="alignment-panel">
      {reflection && <p className="reflection">{reflection}</p>}
      {widgets.map((widget, index) => {
        const dim = widgetDim(widget, index);
        const Component = widgetRegistry[widget.kind];
        const props: WidgetProps = {
          widget,
          onAnswer: (value) => handleAnswer(dim, value),
          disabled,
        };
        return (
          <div className="widget-compact" key={dim}>
            <Component {...props} />
          </div>
        );
      })}
      <button
        className="btn btn-primary"
        disabled={disabled || !answered}
        onClick={() => {
          onSubmit(responses);
          setResponses({});
        }}
      >
        提交回答
      </button>
    </div>
  );
}
