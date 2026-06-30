/**
 * Widget registry — maps backend `kind` strings to React components.
 *
 * Also exports the shared WidgetProps interface used by all widget components.
 */

import type { ComponentType } from "react";
import type { Widget, WidgetKind } from "@/types/api";

import SingleWidget from "./SingleWidget";
import MultiWidget from "./MultiWidget";
import SliderWidget from "./SliderWidget";
import FreeTextWidget from "./FreeTextWidget";
import ConfirmWidget from "./ConfirmWidget";

/** Shared props for all widget components. */
export interface WidgetProps {
  /** The widget data from the backend. */
  widget: Widget;
  /** Callback to submit the user's answer for this widget's dimension. */
  onAnswer: (value: string | string[]) => void;
  /** Whether the widget should be disabled (e.g. while submitting). */
  disabled?: boolean;
}

export const widgetRegistry: Record<WidgetKind, ComponentType<WidgetProps>> = {
  single: SingleWidget,
  multi: MultiWidget,
  slider: SliderWidget,
  freetext: FreeTextWidget,
  confirm: ConfirmWidget,
};
