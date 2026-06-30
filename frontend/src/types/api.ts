/**
 * Frontend types matching the CineDesign backend API contract.
 *
 * These types mirror the Pydantic schemas in:
 *   schemas/widget.py   → Widget union
 *   schemas/shotscript.py → ShotScript, Shot
 *   routers/sessions.py → TurnResponse union, request bodies
 */

// ---------------------------------------------------------------------------
// Widget types (backend: schemas/widget.py)
// ---------------------------------------------------------------------------

/** A single option inside a choice widget. */
export interface Opt {
  value: string;
  label: string;
  hint?: string;
}

/** Single-choice alignment widget. */
export interface SingleWidget {
  kind: "single";
  dim: string;
  prompt: string;
  options: Opt[];
}

/** Multi-select alignment widget. */
export interface MultiWidget {
  kind: "multi";
  dim: string;
  prompt: string;
  options: Opt[];
}

/** Slider alignment widget with labelled ends. */
export interface SliderWidget {
  kind: "slider";
  dim: string;
  prompt: string;
  ends: [string, string];
  ticks?: string[];
}

/** Free-text alignment widget. */
export interface FreeTextWidget {
  kind: "freetext";
  dim?: string;
  prompt: string;
  suggestions: string[];
}

/** Confirmation widget. */
export interface ConfirmWidget {
  kind: "confirm";
  reflection: string;
}

/** Union of all widget kinds the backend may send. */
export type Widget =
  | SingleWidget
  | MultiWidget
  | SliderWidget
  | FreeTextWidget
  | ConfirmWidget;

/** String discriminant for widget kinds. */
export type WidgetKind = Widget["kind"];

// ---------------------------------------------------------------------------
// ShotScript types (backend: schemas/shotscript.py)
// ---------------------------------------------------------------------------

/** A single shot within a script. */
export interface Shot {
  order: number;
  shot_size: string;
  composition: string;
  angle: string;
  movement: string;
  focal_length: string;
  depth_of_field: string;
  lighting: string;
  color_tone: string;
  rhythm: string;
  duration: string;
  /** Sub-intent codes (e.g. "8.3") this shot serves. */
  serves: string[];
  rationale: string;
  /** 从基底图到本镜画面的图像编辑指令(有基底图时产出). */
  frame_edit_hint: string;
  /** 关键帧 URL(即梦 image2image 渲染后填充). */
  frame_image: string | null;
  /** 镜头视频 URL(即梦 image2video 渲染后填充). */
  frame_video?: string | null;
}

/** A complete shot script (one A/B/C candidate). */
export interface ShotScript {
  scheme_id: string;
  strategy: string;
  /** Dominant sub-intent codes of this direction. */
  dominant_intents: string[];
  /** The psychological/perceptual mechanism this direction rides on. */
  mechanism: string;
  shots: Shot[];
  overall_rationale: string;
  /** 全能参考(multimodal2video)把全方案关键帧合成的一段连贯多镜头视频 URL. */
  scheme_video?: string | null;
}

// ---------------------------------------------------------------------------
// Conflict (used in candidates/edit phases)
// ---------------------------------------------------------------------------

export interface Conflict {
  shot_order: number;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// TurnResponse union — the central API response type
// ---------------------------------------------------------------------------

/** Fields present on every turn. */
interface TurnBase {
  session_id: string;
  /** 用户上传的基底图 URL(/api/uploads/..),无上传则为 null. */
  reference_image: string | null;
}

/** Alignment phase: backend sends widgets and waits for user input. */
export interface AlignTurn extends TurnBase {
  phase: "align";
  reflection: string;
  widgets: Widget[];
  converged: false;
}

/** Confirmation phase: backend proposes a brief/tags for user sign-off. */
export interface ConfirmTurn extends TurnBase {
  phase: "confirm";
  reflection: string;
  brief: string;
  tags: string[];
  converged: true;
}

/** Generation progress: backend reports which directions are running. */
export interface GeneratingTurn extends TurnBase {
  phase: "generating";
  progress: { dir: string; done: boolean }[];
}

/** Candidates ready: backend presents A/B/C shot scripts. */
export interface CandidatesTurn extends TurnBase {
  phase: "candidates";
  schemes: ShotScript[];
  /** Revalidation conflicts from the last edit round, if any. */
  conflicts: Conflict[];
  /** Scheme the user worked on last, if any. */
  selected_scheme_id: string | null;
}

/** Edit phase: backend waits for an edit patch on the selected scheme. */
export interface EditTurn extends TurnBase {
  phase: "edit";
  scheme: ShotScript;
  conflicts: Conflict[];
}

/** Session finished (scheme adopted and written back). */
export interface DoneTurn extends TurnBase {
  phase: "done";
  scheme?: ShotScript | null;
}

/** The full TurnResponse union returned by most session endpoints. */
export type TurnResponse =
  | AlignTurn
  | ConfirmTurn
  | GeneratingTurn
  | CandidatesTurn
  | EditTurn
  | DoneTurn;

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

/** POST /sessions */
export interface CreateSessionRequest {
  raw_intent: string;
}

/** POST /sessions/{id}/respond */
export interface RespondRequest {
  dim_widget_responses: Record<string, string | string[]>;
  free_text?: string;
}

/** POST /sessions/{id}/confirm */
export interface ConfirmRequest {
  confirmed: boolean;
  rejection_text?: string;
}

/** POST /sessions/{id}/select */
export interface SelectRequest {
  scheme_id: string;
  /** "writeback"(采纳)or "edit"(进入编辑循环). */
  action: "writeback" | "edit";
}

/** A single field-level patch operation for the edit endpoint. */
export interface PatchOp {
  shot_order: number;
  field: string;
  value: string;
}

/** POST /sessions/{id}/edit */
export interface EditRequest {
  patch: PatchOp[];
  free_text?: string;
}

// ---------------------------------------------------------------------------
// Session snapshot (GET /sessions/{id})
// ---------------------------------------------------------------------------

export interface SessionResponse {
  session_id: string;
  /** Reconstructed turn for resuming the UI. */
  turn: TurnResponse;
  state: {
    phase: string;
    raw_intent: string;
    reference_image: string | null;
    image_brief: string | null;
    dimensions: Record<string, unknown>;
    key_dimensions: string[];
    brief: string | null;
    tags: string[];
    reflection: string | null;
    selected_scheme_id: string | null;
  };
}
