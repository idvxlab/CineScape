/**
 * Zustand session store — holds the current design session state
 * and exposes actions to drive the alignment/generation/edit flow.
 *
 * Every action posts to the backend, receives a TurnResponse, and
 * lets `processTurn` project it into UI state.
 */

import { create } from "zustand";
import type {
  TurnResponse,
  RespondRequest,
  ConfirmRequest,
  SelectRequest,
  EditRequest,
  SessionResponse,
  Widget,
  ShotScript,
  Conflict,
  PatchOp,
} from "@/types/api";

interface SessionStore {
  /** Backend session id; null before creation. */
  sessionId: string | null;
  /** The user's original intent. */
  rawIntent: string;
  /** 用户上传的基底图 URL,无上传则为 null. */
  referenceImage: string | null;
  /** Latest turn from the backend. */
  currentTurn: TurnResponse | null;
  /** Widgets from the current align turn. */
  widgets: Widget[];
  /** Shot scripts from the candidates turn. */
  schemes: ShotScript[];
  /** Revalidation conflicts from the last edit round. */
  conflicts: Conflict[];
  /** Whether an async operation is in progress. */
  loading: boolean;
  /** Scheme id currently being rendered into keyframes, if any. */
  rendering: string | null;
  /** Scheme id currently being animated into videos, if any. */
  animating: string | null;
  /** 视图历史栈,用于「返回上一级页面」(仅前端视图回退,不回滚后端图). */
  history: ViewSnapshot[];
  /** Last API error, if any. */
  error: string | null;

  // ── Actions ──────────────────────────────────────────────────────────
  createSession: (rawIntent: string, image?: File | null) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  submitRespond: (
    dimResponses: Record<string, string | string[]>,
    freeText?: string,
  ) => Promise<void>;
  submitConfirm: (confirmed: boolean, rejectionText?: string) => Promise<void>;
  submitSelect: (schemeId: string, action: "writeback" | "edit") => Promise<void>;
  submitEdit: (patch: PatchOp[], freeText?: string) => Promise<void>;
  /** 逐镜渲染一个方案的关键帧(基底图 + frame_edit_hint). */
  submitRender: (schemeId: string) => Promise<void>;
  /** 逐镜图生视频(以关键帧为首帧 + 十维度运动指令). */
  submitAnimate: (schemeId: string) => Promise<void>;
  /** 返回上一级页面(从历史栈恢复上一帧视图). */
  goBack: () => void;
  /** 是否可返回上一级. */
  canGoBack: () => boolean;
  processTurn: (turn: TurnResponse) => void;
}

/** 一帧可恢复的视图快照(返回上一级用). */
interface ViewSnapshot {
  currentTurn: TurnResponse | null;
  widgets: Widget[];
  schemes: ShotScript[];
  conflicts: Conflict[];
}

const API_BASE = "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(`API ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const useSessionStore = create<SessionStore>((set, get) => {
  /** Shared wrapper: run an API call, project the turn, surface errors. */
  const runTurn = async (fn: () => Promise<TurnResponse>) => {
    set({ loading: true, error: null });
    try {
      const turn = await fn();
      get().processTurn(turn);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  };

  return {
    sessionId: null,
    rawIntent: "",
    referenceImage: null,
    currentTurn: null,
    widgets: [],
    schemes: [],
    conflicts: [],
    loading: false,
    rendering: null,
    animating: null,
    history: [],
    error: null,

    createSession: async (rawIntent: string, image?: File | null) => {
      set({ rawIntent });
      await runTurn(() => {
        if (image) {
          // multipart:不手动设 Content-Type,浏览器自动带 boundary
          const form = new FormData();
          form.append("raw_intent", rawIntent);
          form.append("image", image);
          return apiFetch<TurnResponse>("/sessions", {
            method: "POST",
            headers: {},
            body: form,
          });
        }
        return apiFetch<TurnResponse>("/sessions", {
          method: "POST",
          body: JSON.stringify({ raw_intent: rawIntent }),
        });
      });
    },

    loadSession: async (sessionId: string) => {
      set({ loading: true, error: null });
      try {
        const data = await apiFetch<SessionResponse>(`/sessions/${sessionId}`);
        set({ rawIntent: data.state.raw_intent });
        get().processTurn(data.turn);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ loading: false });
      }
    },

    submitRespond: async (dimResponses, freeText) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      const body: RespondRequest = { dim_widget_responses: dimResponses };
      if (freeText) body.free_text = freeText;
      await runTurn(() =>
        apiFetch<TurnResponse>(`/sessions/${sessionId}/respond`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },

    submitConfirm: async (confirmed, rejectionText) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      const body: ConfirmRequest = { confirmed };
      if (rejectionText) body.rejection_text = rejectionText;
      await runTurn(() =>
        apiFetch<TurnResponse>(`/sessions/${sessionId}/confirm`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },

    submitSelect: async (schemeId, action) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      const body: SelectRequest = { scheme_id: schemeId, action };
      await runTurn(() =>
        apiFetch<TurnResponse>(`/sessions/${sessionId}/select`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },

    submitEdit: async (patch, freeText) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      const body: EditRequest = { patch };
      if (freeText) body.free_text = freeText;
      await runTurn(() =>
        apiFetch<TurnResponse>(`/sessions/${sessionId}/edit`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },

    submitRender: async (schemeId) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      set({ rendering: schemeId, error: null });
      try {
        const res = await apiFetch<{ scheme: ShotScript }>(
          `/sessions/${sessionId}/render`,
          {
            method: "POST",
            body: JSON.stringify({ scheme_id: schemeId }),
          },
        );
        set((state) => ({
          schemes: state.schemes.map((s) =>
            s.scheme_id === schemeId ? res.scheme : s,
          ),
        }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ rendering: null });
      }
    },

    submitAnimate: async (schemeId) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      set({ animating: schemeId, error: null });
      try {
        const res = await apiFetch<{ scheme: ShotScript }>(
          `/sessions/${sessionId}/animate`,
          {
            method: "POST",
            body: JSON.stringify({ scheme_id: schemeId }),
          },
        );
        set((state) => ({
          schemes: state.schemes.map((s) =>
            s.scheme_id === schemeId ? res.scheme : s,
          ),
        }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ animating: null });
      }
    },

    canGoBack: () => get().history.length > 0,

    goBack: () => {
      const { history } = get();
      const prev = history[history.length - 1];
      if (!prev) return;
      set({
        history: history.slice(0, -1),
        currentTurn: prev.currentTurn,
        widgets: prev.widgets,
        schemes: prev.schemes,
        conflicts: prev.conflicts,
        error: null,
      });
    },

    processTurn: (turn: TurnResponse) => {
      const prevTurn = get().currentTurn;
      const update: Partial<SessionStore> = {
        sessionId: turn.session_id,
        referenceImage: turn.reference_image,
        currentTurn: turn,
      };
      // 进入新一帧前,把当前视图压栈(供「返回上一级」);首帧无前序不压
      if (prevTurn) {
        const { widgets, schemes, conflicts } = get();
        update.history = [
          ...get().history,
          { currentTurn: prevTurn, widgets, schemes, conflicts },
        ];
      }
      switch (turn.phase) {
        case "align":
          update.widgets = turn.widgets;
          break;
        case "candidates":
          update.schemes = turn.schemes;
          update.conflicts = turn.conflicts;
          break;
        case "edit":
          update.conflicts = turn.conflicts;
          break;
        default:
          break;
      }
      set(update);
    },
  };
});
