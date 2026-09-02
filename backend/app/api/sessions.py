"""Session management endpoints — create, resume, edit, retrieve.

HITL contract: every POST runs the graph until the next interrupt (or END)
and returns a TurnResponse derived from the *pending interrupt payload*
(the single source of truth for "what the UI should show"), falling back
to graph state when no interrupt is pending (generating / done).

User decisions always travel through ``Command(resume=...)`` and are
captured inside the gate nodes — the API layer never mutates graph state
directly.

  POST  /sessions               — create session, run to first interrupt
  POST  /sessions/{id}/respond  — submit alignment widget responses
  POST  /sessions/{id}/confirm  — confirm/reject converged brief
  POST  /sessions/{id}/select   — select scheme (action: writeback|edit)
  POST  /sessions/{id}/edit     — submit shot-level edit patch
  GET   /sessions/{id}          — retrieve current session state + turn
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from app.evolution import (
    ACT_APPLY,
    ACT_FORGET,
    enact,
    evaluate_skill_adoption,
    load_session_trace,
    preferred_values,
    recall_questions,
    record_batch,
    record_event,
    reflect_session,
    select_and_advance_probe,
)
from app.evolution.questions import (
    VALID_ANSWERS,
    get_corroborated_applicable,
    record_answer,
    set_user_flag,
)
from app.graph.state import SessionState
from app.llm import get_llm_client
from app.llm.client import reasoning_stream_cb
from app.render import RenderError, animate_scheme, hydrate_frames, render_scheme
from app.storage import UPLOADS_DIR, UPLOADS_URL_PREFIX, save_reference_image

logger = logging.getLogger(__name__)

sessions_router = APIRouter()

# Strong refs to background reflection tasks so the event loop doesn't GC them
# mid-flight (asyncio only holds weak refs to tasks).
_background_tasks: set = set()


def _frozen_alignment_allowed(user_id: str) -> bool:
    """Keep the evaluation checkpoint path impossible in normal deployments."""
    return user_id.startswith("eval-") and os.environ.get("EVAL_ALLOW_FROZEN_ALIGNMENT") == "1"


def _spawn_background(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ---------------------------------------------------------------------------
# Request body models
# ---------------------------------------------------------------------------


class CreateBody(BaseModel):
    raw_intent: str
    user_id: str = "anonymous"
    memory_mode: str = "full"  # full | naive | off — experimental arm (Evaluation §Design)


class TraceBody(BaseModel):
    """Batch of fine-grained frontend events (ADR-0017)."""

    events: list[dict] = []


class AlignRespondBody(BaseModel):
    dim_widget_responses: dict[str, str | list[str]] = {}
    free_text: str | None = None


class ConfirmBody(BaseModel):
    confirmed: bool = True
    rejection_text: str | None = None
    # ADR-0017: confirm 门控上展示的探针回答
    #   验证探针 → {"question_id": ..., "answer": "a"|"b"|"open"}
    #   激活探针 → {"skill_activation": "apply"|"leave"|"forget"}
    probe_response: dict | None = None


class SelectBody(BaseModel):
    scheme_id: str
    action: str = "writeback"  # writeback(采纳) | edit(进入编辑)


class PatchOp(BaseModel):
    shot_order: int
    field: str
    value: str


class EditBody(BaseModel):
    patch: list[PatchOp] = []
    free_text: str | None = None


class RenderBody(BaseModel):
    scheme_id: str
    shot_order: int | None = None  # 只渲/仅取这一镜;None = 整方案
    patch: list[PatchOp] = []  # 前端本地编辑直接随渲染应用(无需先走 graph 的 edit interrupt)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _thread_id(session_id: str) -> str:
    return f"thread_{session_id}"


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


def _pending_interrupt(state) -> dict | None:
    """Return the payload of the pending interrupt, if any."""
    for task in state.tasks or []:
        for intr in task.interrupts or []:
            if isinstance(intr.value, dict):
                return intr.value
    return None


def _build_turn_response(state, session_id: str) -> dict:
    """Map the pending interrupt payload (preferred) or graph state to a turn.

    Every turn carries ``reference_image`` so the UI can keep showing the
    user-uploaded base image across phases.
    """
    turn = _build_turn(state, session_id)
    turn["reference_image"] = (state.values or {}).get("reference_image")
    return turn


def _build_turn(state, session_id: str) -> dict:
    payload = _pending_interrupt(state)
    values = state.values or {}

    if payload is not None:
        kind = payload.get("type")
        if kind == "widgets":
            return {
                "session_id": session_id,
                "phase": "align",
                "reflection": payload.get("reflection", ""),
                "reasoning": payload.get("reasoning", ""),
                "widgets": payload.get("widgets", []),
                "converged": False,
            }
        if kind == "confirm":
            return {
                "session_id": session_id,
                "phase": "confirm",
                "reflection": payload.get("reflection", ""),
                "reasoning": payload.get("reasoning", ""),
                "brief": payload.get("brief", ""),
                "tags": payload.get("tags", []),
                "converged": True,
                # ADR-0017: 收敛直达 confirm 时,探针在此展示(applicability 对用户透明)
                "probe": payload.get("probe"),
            }
        if kind == "candidates":
            return {
                "session_id": session_id,
                "phase": "candidates",
                "schemes": hydrate_frames(session_id, payload.get("schemes", [])),
                "conflicts": payload.get("conflicts", []),
                "selected_scheme_id": payload.get("selected_scheme_id"),
                # ADR-0017: 候选页展示"已应用你的偏好 skill"徽标(可为空)
                "active_skill": values.get("active_skill"),
            }
        if kind == "edit_request":
            scheme = payload.get("scheme", {})
            if scheme:
                scheme = hydrate_frames(session_id, [scheme])[0]
            return {
                "session_id": session_id,
                "phase": "edit",
                "scheme": scheme,
                "conflicts": payload.get("conflicts", []),
            }

    # No pending interrupt — derive from state
    phase = values.get("phase", "align")
    if phase in ("strategy", "generate"):
        directions = values.get("directions") or []
        return {
            "session_id": session_id,
            "phase": "generating",
            "progress": [{"dir": d.get("name", ""), "done": False} for d in directions],
        }
    if phase in ("writeback", "done"):
        candidates = values.get("candidates") or []
        selected = next(
            (c for c in candidates if c.get("scheme_id") == values.get("selected_scheme_id")),
            None,
        )
        if selected:
            selected = hydrate_frames(session_id, [selected])[0]
        return {"session_id": session_id, "phase": "done", "scheme": selected}

    # Fallback: align view from state
    return {
        "session_id": session_id,
        "phase": "align",
        "reflection": values.get("reflection") or "",
        "widgets": values.get("pending_widgets") or [],
        "converged": False,
    }


async def _run_to_interrupt(graph, thread_id: str, input_) -> object:
    """Run the graph until the next interrupt or END; return the state snapshot."""
    async for _chunk in graph.astream(input_, config=_config(thread_id), stream_mode="values"):
        pass
    return await graph.aget_state(_config(thread_id))


async def _get_values(graph, session_id: str) -> dict:
    """Fetch the current graph state values (empty dict if missing)."""
    try:
        state = await graph.aget_state(_config(_thread_id(session_id)))
    except Exception:
        return {}
    return state.values or {}


def _session_user_id(values: dict) -> str:
    return values.get("user_id") or "anonymous"


async def _resume_state(
    graph, session_id: str, resume_value: dict, expected_types: tuple[str, ...]
):
    """Validate there is a matching pending interrupt, then resume; return the new state."""
    thread_id = _thread_id(session_id)
    try:
        state = await graph.aget_state(_config(thread_id))
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")

    payload = _pending_interrupt(state)
    if payload is None:
        raise HTTPException(status_code=409, detail="Session is not waiting for input")
    if payload.get("type") not in expected_types:
        raise HTTPException(
            status_code=409,
            detail=f"Session is waiting for '{payload.get('type')}', not {expected_types}",
        )

    return await _run_to_interrupt(graph, thread_id, Command(resume=resume_value))


async def _resume(graph, session_id: str, resume_value: dict, expected_types: tuple[str, ...]):
    new_state = await _resume_state(graph, session_id, resume_value, expected_types)
    return _build_turn_response(new_state, session_id)


# ---------------------------------------------------------------------------
# SSE streaming: run a graph step while forwarding the model's reasoning_content
# deltas live, then a final `turn` event. Used by ?stream=1 so the UI can show
# the thinking trace (gray) while waiting.
# ---------------------------------------------------------------------------


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _stream_turn(session_id: str, runner) -> "StreamingResponse":
    async def gen():
        queue: asyncio.Queue[str] = asyncio.Queue()
        token = reasoning_stream_cb.set(lambda d: queue.put_nowait(d))
        try:
            task = asyncio.create_task(runner())
            while True:
                try:
                    delta = await asyncio.wait_for(queue.get(), timeout=0.3)
                    yield _sse("reasoning", {"delta": delta})
                except asyncio.TimeoutError:
                    if task.done() and queue.empty():
                        break
                    yield ": keepalive\n\n"
            if task.exception() is not None:
                yield _sse("error", {"detail": str(task.exception())[:300]})
                return
            yield _sse("turn", _build_turn_response(task.result(), session_id))
        finally:
            reasoning_stream_cb.reset(token)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@sessions_router.post("")
async def create_session(request: Request):
    """Create a session — multipart only: ``raw_intent`` + ``image``(必填).

    会话语义 = 为上传画面设计重拍摄方案(ADR-0012):图片锚定主体与空间,
    拍摄风格完全服从用户意图。图片存盘、生成视觉描述(可降级),
    贯穿整个会话;关键帧渲染以它为基底。
    """
    content_type = request.headers.get("content-type", "")
    image: UploadFile | None = None

    user_id = "anonymous"
    memory_mode = "full"
    image_brief_override = ""
    frozen_alignment_raw = ""
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        raw_intent = str(form.get("raw_intent") or "").strip()
        user_id = str(form.get("user_id") or "anonymous").strip() or "anonymous"
        memory_mode = str(form.get("memory_mode") or "full").strip() or "full"
        image_brief_override = str(form.get("image_brief") or "").strip()
        frozen_alignment_raw = str(form.get("frozen_alignment") or "").strip()
        # form() 产出 starlette UploadFile(非 fastapi 子类),按基类判断
        candidate = form.get("image")
        if isinstance(candidate, UploadFile) and candidate.filename:
            image = candidate
    else:
        try:
            body = CreateBody.model_validate(await request.json())
        except Exception:
            raise HTTPException(status_code=422, detail="raw_intent is required")
        raw_intent = body.raw_intent.strip()
        user_id = body.user_id or "anonymous"
        memory_mode = body.memory_mode or "full"

    if not raw_intent:
        raise HTTPException(status_code=422, detail="raw_intent is required")
    if image is None:
        raise HTTPException(
            status_code=422,
            detail="Please upload a reference image (multipart field 'image'): this system designs re-shoot schemes for an image",
        )
    if image_brief_override and not user_id.startswith("eval-"):
        raise HTTPException(
            status_code=422,
            detail="image_brief override is restricted to evaluation users",
        )
    if frozen_alignment_raw and not _frozen_alignment_allowed(user_id):
        raise HTTPException(
            status_code=422,
            detail="frozen_alignment is disabled outside an authorized evaluation run",
        )

    frozen_alignment: dict | None = None
    if frozen_alignment_raw:
        try:
            candidate = json.loads(frozen_alignment_raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"invalid frozen_alignment JSON: {exc.msg}",
            )
        if not isinstance(candidate, dict):
            raise HTTPException(status_code=422, detail="frozen_alignment must be an object")
        frozen_brief = str(candidate.get("brief") or "").strip()
        frozen_tags = candidate.get("tags")
        frozen_raw_intent = str(candidate.get("raw_intent") or "").strip()
        if (
            not frozen_brief
            or not isinstance(frozen_tags, list)
            or not frozen_tags
            or frozen_raw_intent != raw_intent
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    "frozen_alignment requires a non-empty brief/tags and "
                    "the same raw_intent as the new branch"
                ),
            )
        frozen_alignment = candidate

    session_id = str(uuid.uuid4())
    graph = request.app.state.graph

    try:
        content = await image.read()
        reference_image, local_path = save_reference_image(
            session_id, content, image.content_type or ""
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    async def runner():
        frozen_image_brief = str((frozen_alignment or {}).get("image_brief") or "").strip()
        if frozen_alignment and image_brief_override and frozen_image_brief != image_brief_override:
            raise HTTPException(
                status_code=422,
                detail="frozen alignment image_brief does not match the supplied scene card",
            )
        image_brief = (
            frozen_image_brief
            or image_brief_override
            or await get_llm_client().describe_image(str(local_path))
        )
        logger.info(
            "Session %s reference image saved (%s), brief=%s source=%s",
            session_id[:8],
            reference_image,
            "yes" if image_brief else "degraded",
            "frozen_eval_card" if image_brief_override else "vision_model",
        )
        normalized_mode = memory_mode if memory_mode in ("full", "naive", "off") else "full"
        if frozen_alignment is None:
            initial_state = SessionState(
                raw_intent=raw_intent,
                user_id=user_id,
                memory_mode=normalized_mode,
                reference_image=reference_image,
                image_brief=image_brief,
            ).model_dump()
        else:
            tags = [str(tag) for tag in frozen_alignment["tags"]]
            recalled_questions: list[dict] = []
            pending_widgets: list[dict] = []
            if normalized_mode == "full":
                try:
                    recalled_questions = await recall_questions(user_id, tags)
                    swap = (
                        sum(len(question.get("answers") or []) for question in recalled_questions)
                        % 2
                        == 1
                    )
                    # ADR-0020 A+C:读/推进用户探针调度状态(验证保底 + 激活不重复)
                    probe = await select_and_advance_probe(
                        user_id,
                        recalled_questions,
                        already_probed=False,
                        swap=swap,
                    )
                    if probe is not None:
                        pending_widgets = [probe]
                except Exception:
                    logger.debug(
                        "Frozen branch question recall failed; continuing without probe",
                        exc_info=True,
                    )
            stable_alignment = {
                key: frozen_alignment.get(key)
                for key in (
                    "source_session_id",
                    "raw_intent",
                    "image_brief",
                    "dimensions",
                    "key_dimensions",
                    "brief",
                    "tags",
                    "reflection",
                )
            }
            alignment_hash = hashlib.sha256(
                json.dumps(
                    stable_alignment,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            initial_state = SessionState(
                raw_intent=raw_intent,
                user_id=user_id,
                memory_mode=normalized_mode,
                reference_image=reference_image,
                image_brief=image_brief,
                dimensions=frozen_alignment.get("dimensions") or {},
                key_dimensions=frozen_alignment.get("key_dimensions") or [],
                brief=str(frozen_alignment["brief"]),
                tags=tags,
                reflection=str(frozen_alignment.get("reflection") or ""),
                recalled_questions=recalled_questions,
                pending_widgets=pending_widgets,
                converged=True,
                phase="confirm",
            ).model_dump()
            await record_event(
                session_id,
                "alignment_cloned",
                {
                    "source_session_id": frozen_alignment.get("source_session_id"),
                    "alignment_hash": alignment_hash,
                    "fields": [
                        "raw_intent",
                        "image_brief",
                        "dimensions",
                        "key_dimensions",
                        "brief",
                        "tags",
                        "reflection",
                    ],
                },
                user_id=user_id,
            )
        return await _run_to_interrupt(graph, _thread_id(session_id), initial_state)

    await record_event(
        session_id,
        "session_start",
        {
            "raw_intent": raw_intent,
            "has_image": True,
            "image_brief_source": ("frozen_eval_card" if image_brief_override else "vision_model"),
            "alignment_source": (
                "frozen_eval_branch" if frozen_alignment is not None else "live_alignment"
            ),
        },
        user_id=user_id,
    )
    if request.query_params.get("stream") == "1":
        return await _stream_turn(session_id, runner)
    return _build_turn_response(await runner(), session_id)


@sessions_router.post("/{session_id}/respond")
async def respond_to_align(session_id: str, body: AlignRespondBody, request: Request):
    graph = request.app.state.graph
    values = await _get_values(graph, session_id)
    user_id = _session_user_id(values)

    # 分离普通维度回答与探针回答(ADR-0017):验证探针的 key = question_id;
    # skill 激活探针的 key = "skill_activation"。答案只入 trace,不在此裁决——
    # 最终裁决(record_answer / enact / revoke)延到 confirm 门控(tags 已确认)。
    recalled_ids = {q["question_id"] for q in values.get("recalled_questions", [])}
    activation_widget = next(
        (w for w in values.get("pending_widgets") or [] if w.get("kind") == "skill_activation"),
        None,
    )
    dim_answers: dict = {}
    for key, answer in (body.dim_widget_responses or {}).items():
        if key == "skill_activation" and isinstance(answer, str):
            await record_event(
                session_id,
                "skill_activation",
                {
                    "answer": answer,
                    "question_ids": (activation_widget or {}).get("question_ids", []),
                },
                user_id=user_id,
            )
        elif key in recalled_ids and isinstance(answer, str) and answer in VALID_ANSWERS:
            await record_event(
                session_id,
                "probe_response",
                {"question_id": key, "answer": answer},
                user_id=user_id,
            )
        else:
            dim_answers[key] = answer

    await record_event(
        session_id,
        "align_answer",
        {"dim_widget_responses": dim_answers, "free_text": body.free_text},
        user_id=user_id,
    )

    resume_value = {
        "type": "widgets_response",
        "dim_widget_responses": dim_answers,
        "free_text": body.free_text,
    }
    if request.query_params.get("stream") == "1":
        return await _stream_turn(
            session_id,
            lambda: _resume_state(graph, session_id, resume_value, ("widgets",)),
        )
    return await _resume(graph, session_id, resume_value, expected_types=("widgets",))


@sessions_router.post("/{session_id}/confirm")
async def confirm_alignment(session_id: str, body: ConfirmBody, request: Request):
    graph = request.app.state.graph
    active_skill = None
    if body.confirmed:
        values = await _get_values(graph, session_id)
        # confirm 门控上展示的探针:先把回答落 trace(与 respond 路径同构),再 finalize
        if body.probe_response:
            await _record_confirm_probe(session_id, values, body.probe_response)
        # 显式 probe 回答延到此处落账；它是与跨 session 行为复现并列的投票来源。
        # tags 已确认，因此先做 applicability 二次校验，再决定是否激活 skill。
        active_skill = await _finalize_probe(session_id, values)

    resume_value = {
        "type": "confirm",
        "confirmed": body.confirmed,
        "rejection_text": body.rejection_text,
        "active_skill": active_skill,
    }
    if request.query_params.get("stream") == "1":
        return await _stream_turn(
            session_id,
            lambda: _resume_state(graph, session_id, resume_value, ("confirm",)),
        )
    return await _resume(graph, session_id, resume_value, expected_types=("confirm",))


async def _record_confirm_probe(session_id: str, values: dict, pr: dict) -> None:
    """Record a probe answered on the confirm gate as trace events (ADR-0017).

    Mirrors the respond-path split: verification answers keyed by question_id,
    activation by 'skill_activation'. Best-effort; never blocks the turn.
    """
    user_id = _session_user_id(values)
    activation = pr.get("skill_activation")
    if isinstance(activation, str):
        probe_widget = next(
            (w for w in values.get("pending_widgets") or [] if w.get("kind") == "skill_activation"),
            None,
        )
        await record_event(
            session_id,
            "skill_activation",
            {"answer": activation, "question_ids": (probe_widget or {}).get("question_ids", [])},
            user_id=user_id,
        )
        return
    qid = pr.get("question_id")
    answer = pr.get("answer")
    recalled_ids = {q["question_id"] for q in values.get("recalled_questions", [])}
    if qid in recalled_ids and isinstance(answer, str) and answer in VALID_ANSWERS:
        await record_event(
            session_id,
            "probe_response",
            {"question_id": qid, "answer": answer},
            user_id=user_id,
        )


async def _finalize_probe(session_id: str, values: dict) -> dict | None:
    """After the user confirms brief+tags, settle the session's probe answer.

    - verification answer → applicability check vs confirmed tags → record_answer
      (updates the question's prevailing status). No skill is activated by a
      mere verification (never silently applied).
    - skill activation ``apply`` → enact a session skill from corroborated,
      applicable questions (with the user's own exemplars as few-shot,
      ADR-0018); ``forget`` → revoke the presented questions.

    Returns the active WorkflowSkill dict, or None. Best-effort; never blocks.
    """
    user_id = _session_user_id(values)
    if user_id == "anonymous" or values.get("memory_mode", "full") != "full":
        return None
    tags = values.get("tags", [])
    recalled = {q["question_id"]: q for q in values.get("recalled_questions", [])}
    trace = await load_session_trace(session_id)

    verification: dict | None = None
    activation: str | None = None
    activation_qids: list[str] = []
    for ev in trace:
        if ev.get("event_type") == "probe_response":
            verification = ev.get("payload") or {}
        elif ev.get("event_type") == "skill_activation":
            payload = ev.get("payload") or {}
            activation = payload.get("answer")
            activation_qids = payload.get("question_ids") or []

    try:
        if verification:
            qid = verification.get("question_id")
            q = recalled.get(qid)
            if q and _question_applies(q, tags):
                await record_answer(session_id, qid, verification.get("answer"))
            else:
                await record_event(
                    session_id,
                    "skill_outcome",
                    {
                        "stage": "confirm",
                        "question_id": qid,
                        "result": "inapplicable_after_confirm",
                    },
                    user_id=user_id,
                )
        if activation == ACT_FORGET:
            # 只撤销激活探针实际呈现的问题;缺 id 时兜底为召回中的已确证问题
            targets = activation_qids or [
                qid for qid, q in recalled.items() if q.get("status") == "corroborated"
            ]
            for qid in targets:
                await set_user_flag(user_id, qid, "revoke")
        elif activation == ACT_APPLY:
            corroborated = await get_corroborated_applicable(user_id, tags)
            # ADR-0018: 呈现层 examples 取自该用户自己的范例库(预取,enact 保持纯函数)
            try:
                from app.recall import fetch_user_exemplars

                exemplars = await fetch_user_exemplars(user_id, tags)
            except Exception:
                logger.debug("Exemplar fetch failed, enacting without examples", exc_info=True)
                exemplars = []
            skill = enact(corroborated, exemplar_records=exemplars)
            if skill is not None:
                await record_event(
                    session_id,
                    "skill_outcome",
                    {
                        "stage": "activate",
                        "result": "consumed",
                        "source_question_ids": skill.get("source_question_ids", []),
                    },
                    user_id=user_id,
                )
            return skill
    except Exception:
        logger.warning("Probe finalization failed for %s (non-critical)", session_id, exc_info=True)
    return None


def _question_applies(question: dict, tags: list[str]) -> bool:
    """A question applies if global, its scope is among the confirmed tags, or
    its discovery context overlaps them (ADR-0017: recurring context is a tag
    set, matched by overlap — same-theme sessions vary in exact tags)."""
    if question.get("scope_type") == "global":
        return True
    tagset = set(tags or [])
    if question.get("scope_id") in tagset:
        return True
    return bool(set(question.get("context_tags") or []) & tagset)


@sessions_router.post("/{session_id}/select")
async def select_scheme(session_id: str, body: SelectBody, request: Request):
    graph = request.app.state.graph
    values = await _get_values(graph, session_id)
    user_id = _session_user_id(values)

    # 比较证据(ADR-0017):仅实际展示的多方案选择才是机制层偏好表态
    candidates = values.get("candidates", [])
    presented = list(dict.fromkeys(c.get("scheme_id") for c in candidates if c.get("scheme_id")))
    rejected = [scheme_id for scheme_id in presented if scheme_id != body.scheme_id]
    await record_event(
        session_id,
        "candidate_select",
        {
            "selected": body.scheme_id,
            # A strategy direction is not necessarily a candidate the user
            # actually saw: a branch may fail generation. Comparative evidence
            # must therefore be bounded by the presented candidate set.
            "presented": presented,
            "rejected": rejected,
            "action": body.action,
            "directions": values.get("directions", []),
            "tags": values.get("tags", []),
            "brief": values.get("brief", ""),
        },
        user_id=user_id,
    )

    result = await _resume(
        graph,
        session_id,
        {
            "type": "candidates_response",
            "scheme_id": body.scheme_id,
            "action": body.action,
        },
        expected_types=("candidates",),
    )

    # 采纳即会话结束:记 adopt 证据、skill 采纳结果,并异步触发反思(非阻塞)
    if body.action == "writeback":
        await record_event(
            session_id,
            "adopt",
            {
                "scheme_id": body.scheme_id,
                "tags": values.get("tags", []),
                "brief": values.get("brief", ""),
            },
            user_id=user_id,
        )
        active_skill = values.get("active_skill")
        if active_skill:
            selected = next((c for c in candidates if c.get("scheme_id") == body.scheme_id), None)
            outcomes = evaluate_skill_adoption(active_skill, (selected or {}).get("shots", []))
            await record_event(
                session_id,
                "skill_outcome",
                {
                    "stage": "adopt",
                    **outcomes,
                    "source_question_ids": active_skill.get("source_question_ids", []),
                },
                user_id=user_id,
            )
        if user_id != "anonymous" and values.get("memory_mode", "full") == "full":
            # Evaluation can request a synchronous outer-loop update so the
            # next simulated session observes exactly this completed trace.
            # Production remains non-blocking by default.
            if request.query_params.get("await_reflection") == "1":
                # The experiment must fail/retry this required session if its
                # memory consolidation failed; otherwise session t+1 would not
                # observe the evidence produced by session t.
                await reflect_session(session_id, raise_errors=True)
            else:
                _spawn_background(reflect_session(session_id))

    return result


@sessions_router.post("/{session_id}/edit")
async def edit_shot(session_id: str, body: EditBody, request: Request):
    graph = request.app.state.graph
    values = await _get_values(graph, session_id)
    await _record_patch_events(
        session_id,
        values,
        [op.model_dump() for op in body.patch],
        free_text=body.free_text,
        scheme_id=values.get("selected_scheme_id"),
    )

    return await _resume(
        graph,
        session_id,
        {
            "type": "edit_patch",
            "patch": [op.model_dump() for op in body.patch],
            "free_text": body.free_text,
        },
        expected_types=("edit_request",),
    )


async def _record_patch_events(
    session_id: str,
    values: dict,
    ops_in: list[dict],
    free_text: str | None = None,
    scheme_id: str | None = None,
) -> None:
    """参数证据(ADR-0017):补齐每个编辑的 from 值,记 edit_patch;若激活了 skill,
    把改走偏好字段的编辑记为 user_overridden(下次反思的发现线索)。

    同时被 /edit 与「渲染/动画随带 patch」路径复用——后者绕过 graph 的 edit
    interrupt,若不在此补录,参数证据会静默丢失。Best-effort,绝不阻塞。
    """
    if not ops_in:
        return
    from app.ontology import TEN_PARAMS

    user_id = _session_user_id(values)
    target_id = scheme_id or values.get("selected_scheme_id")
    scheme = next(
        (c for c in values.get("candidates", []) if c.get("scheme_id") == target_id),
        None,
    )
    shots_by_order = {s.get("order"): s for s in (scheme or {}).get("shots", [])}
    ten = set(TEN_PARAMS)
    ops = []
    for op in ops_in:
        field = op.get("field")
        # 证据降噪:只留十参数字段(frame_edit_hint 等注解不是偏好证据),
        # 且跳过 no-op(前端渲染路径每次全量发 patch,未改字段无证据价值)。
        if field not in ten:
            continue
        shot = shots_by_order.get(op.get("shot_order"), {})
        before = shot.get(field)
        after = op.get("value")
        if before is not None and str(before) == str(after):
            continue
        ops.append(
            {
                "shot_order": op.get("shot_order"),
                "field": field,
                "from": before,
                "to": after,
            }
        )
    if not ops:
        return
    await record_event(
        session_id,
        "edit_patch",
        {"scheme_id": target_id, "ops": ops, "free_text": free_text},
        user_id=user_id,
    )

    active_skill = values.get("active_skill")
    if active_skill:
        prefs = preferred_values(active_skill)
        overridden = [
            {"field": op["field"], "preferred": prefs[op["field"]], "to": op["to"]}
            for op in ops
            if op["field"] in prefs and str(op["to"]) != prefs[op["field"]]
        ]
        if overridden:
            await record_event(
                session_id,
                "skill_outcome",
                {"stage": "edit", "result": "user_overridden", "fields": overridden},
                user_id=user_id,
            )


@sessions_router.post("/{session_id}/render")
async def render_keyframes(session_id: str, body: RenderBody, request: Request):
    """逐镜渲染一个方案的关键帧(ADR-0012)。

    以会话基底图为起点、frame_edit_hint 为编辑指令;渲染结果回写图状态
    (candidates upsert),返回带 frame_image 的方案。渲染是工具调用,
    不推进图,不影响挂起的 interrupt。
    """
    graph = request.app.state.graph
    config = _config(_thread_id(session_id))
    try:
        state = await graph.aget_state(config)
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")
    values = state.values or {}
    if not values:
        raise HTTPException(status_code=404, detail="Session not found")

    reference_image = values.get("reference_image")
    if not reference_image:
        raise HTTPException(status_code=409, detail="This session has no base image; cannot render")
    base_path = UPLOADS_DIR / reference_image.rsplit("/", 1)[-1]
    if not base_path.exists():
        raise HTTPException(status_code=409, detail="Base image file not found")

    scheme = next(
        (c for c in values.get("candidates", []) if c.get("scheme_id") == body.scheme_id),
        None,
    )
    if scheme is None:
        raise HTTPException(status_code=404, detail=f"Scheme {body.scheme_id} not found")

    # 前端本地编辑(含 frame_edit_hint)随渲染一并应用 —— 不依赖会话是否停在 edit interrupt,
    # 这样载入历史(会话已不在 candidates 等待态)也能渲染编辑后的方案。
    # ADR-0017: 该路径绕过 graph 的 edit interrupt,须在此补录参数证据,否则外环失明。
    if body.patch:
        await _record_patch_events(
            session_id,
            values,
            [op.model_dump() for op in body.patch],
            scheme_id=body.scheme_id,
        )
        from app.graph.nodes.edit import _apply_patch

        scheme, _rejected = _apply_patch(scheme, [op.model_dump() for op in body.patch])

    updated = await render_scheme(session_id, scheme, base_path, only_order=body.shot_order)
    # Merge this render with any previously rendered shots from disk.
    updated = hydrate_frames(session_id, [updated])[0]
    rendered = sum(1 for s in updated.get("shots", []) if s.get("frame_image"))
    requested_shots = [
        shot
        for shot in updated.get("shots", [])
        if body.shot_order is None or shot.get("order") == body.shot_order
    ]
    preview_succeeded = bool(requested_shots) and all(
        shot.get("frame_image") for shot in requested_shots
    )
    if preview_succeeded:
        # A perceptual verdict requires an observable preview, not merely an
        # attempted tool call. Reflection consumes only successful renders.
        await record_event(
            session_id,
            "render_request",
            {"scheme_id": body.scheme_id, "shot_order": body.shot_order, "status": "succeeded"},
            user_id=_session_user_id(values),
        )
    else:
        await record_event(
            session_id,
            "frontend_event",
            {"type": "render_failed", "scheme_id": body.scheme_id, "shot_order": body.shot_order},
            user_id=_session_user_id(values),
        )

    # 不写图状态(aupdate_state 会清掉挂起的 interrupt):
    # 渲染产物以 uploads/ 文件为事实存储,响应构建时 hydrate_frames 运行时合并

    return {
        "session_id": session_id,
        "scheme": updated,
        "rendered": rendered,
        "total": len(updated.get("shots", [])),
        "reference_image": reference_image,
    }


@sessions_router.post("/{session_id}/animate")
async def animate_shots(session_id: str, body: RenderBody, request: Request):
    """全能参考(即梦 multimodal2video):方案全部关键帧按顺序作参考 + 整合 prompt
    (带时间轴 + 镜头衔接)→ 一段连贯的多镜头视频。

    需先调 /render 生成关键帧。视频产物落 uploads/{sid}_{scheme}.mp4,经
    hydrate_frames 运行时合并为 scheme.scheme_video。不推进图、不影响 interrupt。
    合成失败时把即梦真实报错以 502 冒泡(不再静默吞)。
    """
    graph = request.app.state.graph
    config = _config(_thread_id(session_id))
    try:
        state = await graph.aget_state(config)
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")
    values = state.values or {}
    if not values:
        raise HTTPException(status_code=404, detail="Session not found")

    scheme = next(
        (c for c in values.get("candidates", []) if c.get("scheme_id") == body.scheme_id),
        None,
    )
    if scheme is None:
        raise HTTPException(status_code=404, detail=f"Scheme {body.scheme_id} not found")

    # 前端本地编辑随 animate 一并应用,使视频运镜/镜头语言 prompt 也反映改动
    # (state.candidates 没被 render 写回,不 apply 的话视频会用旧参数)。
    # ADR-0017: 同 /render,绕过 edit interrupt 的编辑在此补录参数证据。
    if body.patch:
        await _record_patch_events(
            session_id,
            values,
            [op.model_dump() for op in body.patch],
            scheme_id=body.scheme_id,
        )
        from app.graph.nodes.edit import _apply_patch

        scheme, _rejected = _apply_patch(scheme, [op.model_dump() for op in body.patch])

    # 关键帧是图生视频的首帧前置;按磁盘存在性回填,缺帧则拒绝
    scheme = hydrate_frames(session_id, [scheme])[0]
    if not any(s.get("frame_image") for s in scheme.get("shots", [])):
        raise HTTPException(status_code=409, detail="This scheme has no keyframes yet; call /render first")

    try:
        updated = await animate_scheme(session_id, scheme)
    except RenderError as exc:
        raise HTTPException(status_code=502, detail=f"Video composition failed: {exc}")
    await record_event(
        session_id,
        "render_request",
        {"scheme_id": body.scheme_id, "mode": "animate", "shot_order": None, "status": "succeeded"},
        user_id=_session_user_id(values),
    )

    scheme_video = updated.get("scheme_video")
    if not scheme_video:
        raise HTTPException(status_code=409, detail="This scheme has no usable keyframes; cannot compose video")

    return {
        "session_id": session_id,
        "scheme": updated,
        "scheme_video": scheme_video,
        "shots_used": sum(1 for s in updated.get("shots", []) if s.get("frame_image")),
        "total": len(updated.get("shots", [])),
    }


@sessions_router.post("/{session_id}/backplate")
async def make_backplate(session_id: str, request: Request):
    """即梦 image2image 把上传底图里的人物/主体移除,补全成纯背景空场 → 作为 3D 舞台的背景墙。"""
    from app.render import edit_image

    graph = request.app.state.graph
    try:
        state = await graph.aget_state(_config(_thread_id(session_id)))
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")
    reference_image = (state.values or {}).get("reference_image")
    if not reference_image:
        raise HTTPException(status_code=409, detail="This session has no base image")
    base_path = UPLOADS_DIR / reference_image.rsplit("/", 1)[-1]
    if not base_path.exists():
        raise HTTPException(status_code=409, detail="Base image file not found")

    instruction = (
        "Remove the person/subject from the frame, keeping only the empty scene background; "
        "naturally fill in the environment areas the person was covering. "
        "Strictly preserve the original scene, composition, lighting, color and perspective; "
        "do not add any people or new objects."
    )
    try:
        img = await edit_image([base_path], instruction)
    except RenderError as exc:
        raise HTTPException(status_code=502, detail=f"Backplate generation failed: {exc}")
    fname = f"{session_id}_backplate.png"
    (UPLOADS_DIR / fname).write_bytes(img)
    return {"session_id": session_id, "url": f"{UPLOADS_URL_PREFIX}/{fname}"}


@sessions_router.post("/{session_id}/trace")
async def push_trace(session_id: str, body: TraceBody, request: Request):
    """Batch-ingest fine-grained frontend events (ADR-0017).

    The production frontend streams interaction detail (shot selected, slider
    dragged, preview compared, ...) here. Capture is best-effort and never
    touches the agent graph.
    """
    values = await _get_values(request.app.state.graph, session_id)
    accepted = await record_batch(session_id, body.events, user_id=_session_user_id(values))
    return {"session_id": session_id, "accepted": accepted}


@sessions_router.get("/{session_id}")
async def get_session(session_id: str, request: Request):
    graph = request.app.state.graph
    try:
        state = await graph.aget_state(_config(_thread_id(session_id)))
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")
    if not state.values:
        raise HTTPException(status_code=404, detail="Session not found")

    values = state.values
    return {
        "session_id": session_id,
        "turn": _build_turn_response(state, session_id),
        "state": {
            "phase": values.get("phase", "align"),
            "raw_intent": values.get("raw_intent", ""),
            "reference_image": values.get("reference_image"),
            "image_brief": values.get("image_brief"),
            "dimensions": values.get("dimensions", {}),
            "key_dimensions": values.get("key_dimensions", []),
            "brief": values.get("brief"),
            "tags": values.get("tags", []),
            "reflection": values.get("reflection"),
            "converged": values.get("converged", False),
            "selected_scheme_id": values.get("selected_scheme_id"),
        },
    }
