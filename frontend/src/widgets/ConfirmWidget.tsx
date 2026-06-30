import type { ConfirmWidget as ConfirmWidgetT } from "@/types/api";
import type { WidgetProps } from "./registry";

/**
 * Confirm widget — user confirms or rejects a proposed resolution.
 */
export default function ConfirmWidget({ widget, onAnswer, disabled }: WidgetProps) {
  const w = widget as ConfirmWidgetT;

  return (
    <div className="widget-compact">
      <p className="widget-label">{w.reflection}</p>
      <div className="confirm-actions">
        <button className="btn btn-success" disabled={disabled} onClick={() => onAnswer("yes")}>
          Confirm
        </button>
        <button className="btn btn-warning" disabled={disabled} onClick={() => onAnswer("no")}>
          Reject
        </button>
      </div>
    </div>
  );
}
