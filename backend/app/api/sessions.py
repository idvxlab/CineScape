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
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from app.graph.state import SessionState
from app.llm import get_llm_client
from app.llm.client import reasoning_stream_cb
from app.render import RenderError, animate_scheme, hydrate_frames, render_scheme
from app.storage import UPLOADS_DIR, UPLOADS_URL_PREFIX, save_reference_image

logger = logging.getLogger(__name__)

sessions_router = APIRouter()


# ---------------------------------------------------------------------------
# Request body models
# ---------------------------------------------------------------------------


class CreateBody(BaseModel):
    raw_intent: str


class AlignRespondBody(BaseModel):
    dim_widget_responses: dict[str, str | list[str]] = {}
    free_text: str | None = None


class ConfirmBody(BaseModel):
    confirmed: bool = True
    rejection_text: str | None = None


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
            }
        if kind == "candidates":
            return {
                "session_id": session_id,
                "phase": "candidates",
                "schemes": hydrate_frames(session_id, payload.get("schemes", [])),
                "conflicts": payload.get("conflicts", []),
                "selected_scheme_id": payload.get("selected_scheme_id"),
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


async def _resume_state(graph, session_id: str, resume_value: dict, expected_types: tuple[str, ...]):
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

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


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

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        raw_intent = str(form.get("raw_intent") or "").strip()
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

    if not raw_intent:
        raise HTTPException(status_code=422, detail="raw_intent is required")
    if image is None:
        raise HTTPException(
            status_code=422,
            detail="请上传一张参考画面(multipart 的 image 字段):本系统为画面设计重拍摄方案",
        )

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
        image_brief = await get_llm_client().describe_image(str(local_path))
        logger.info(
            "Session %s reference image saved (%s), brief=%s",
            session_id[:8],
            reference_image,
            "yes" if image_brief else "degraded",
        )
        initial_state = SessionState(
            raw_intent=raw_intent,
            reference_image=reference_image,
            image_brief=image_brief,
        ).model_dump()
        return await _run_to_interrupt(graph, _thread_id(session_id), initial_state)

    if request.query_params.get("stream") == "1":
        return await _stream_turn(session_id, runner)
    return _build_turn_response(await runner(), session_id)


@sessions_router.post("/{session_id}/respond")
async def respond_to_align(session_id: str, body: AlignRespondBody, request: Request):
    graph = request.app.state.graph
    resume_value = {
        "type": "widgets_response",
        "dim_widget_responses": body.dim_widget_responses,
        "free_text": body.free_text,
    }
    if request.query_params.get("stream") == "1":
        return await _stream_turn(session_id, lambda: _resume_state(graph, session_id, resume_value, ("widgets",)))
    return await _resume(graph, session_id, resume_value, expected_types=("widgets",))


@sessions_router.post("/{session_id}/confirm")
async def confirm_alignment(session_id: str, body: ConfirmBody, request: Request):
    graph = request.app.state.graph
    resume_value = {
        "type": "confirm",
        "confirmed": body.confirmed,
        "rejection_text": body.rejection_text,
    }
    if request.query_params.get("stream") == "1":
        return await _stream_turn(session_id, lambda: _resume_state(graph, session_id, resume_value, ("confirm",)))
    return await _resume(graph, session_id, resume_value, expected_types=("confirm",))


@sessions_router.post("/{session_id}/select")
async def select_scheme(session_id: str, body: SelectBody, request: Request):
    return await _resume(
        request.app.state.graph,
        session_id,
        {
            "type": "candidates_response",
            "scheme_id": body.scheme_id,
            "action": body.action,
        },
        expected_types=("candidates",),
    )


@sessions_router.post("/{session_id}/edit")
async def edit_shot(session_id: str, body: EditBody, request: Request):
    return await _resume(
        request.app.state.graph,
        session_id,
        {
            "type": "edit_patch",
            "patch": [op.model_dump() for op in body.patch],
            "free_text": body.free_text,
        },
        expected_types=("edit_request",),
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
        raise HTTPException(status_code=409, detail="该会话没有基底图,无法渲染")
    base_path = UPLOADS_DIR / reference_image.rsplit("/", 1)[-1]
    if not base_path.exists():
        raise HTTPException(status_code=409, detail="基底图文件不存在")

    scheme = next(
        (c for c in values.get("candidates", []) if c.get("scheme_id") == body.scheme_id),
        None,
    )
    if scheme is None:
        raise HTTPException(status_code=404, detail=f"方案 {body.scheme_id} 不存在")

    # 前端本地编辑(含 frame_edit_hint)随渲染一并应用 —— 不依赖会话是否停在 edit interrupt,
    # 这样载入历史(会话已不在 candidates 等待态)也能渲染编辑后的方案。
    if body.patch:
        from app.graph.nodes.edit import _apply_patch
        scheme, _rejected = _apply_patch(scheme, [op.model_dump() for op in body.patch])

    updated = await render_scheme(session_id, scheme, base_path, only_order=body.shot_order)
    # merge all on-disk frames (this render + any previously rendered shots) so the response is complete
    updated = hydrate_frames(session_id, [updated])[0]
    rendered = sum(1 for s in updated.get("shots", []) if s.get("frame_image"))

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
        raise HTTPException(status_code=404, detail=f"方案 {body.scheme_id} 不存在")

    # 前端本地编辑随 animate 一并应用,使视频运镜/镜头语言 prompt 也反映改动
    # (state.candidates 没被 render 写回,不 apply 的话视频会用旧参数)。
    if body.patch:
        from app.graph.nodes.edit import _apply_patch
        scheme, _rejected = _apply_patch(scheme, [op.model_dump() for op in body.patch])

    # 关键帧是图生视频的首帧前置;按磁盘存在性回填,缺帧则拒绝
    scheme = hydrate_frames(session_id, [scheme])[0]
    if not any(s.get("frame_image") for s in scheme.get("shots", [])):
        raise HTTPException(status_code=409, detail="该方案尚无关键帧,请先调用 /render")

    try:
        updated = await animate_scheme(session_id, scheme)
    except RenderError as exc:
        raise HTTPException(status_code=502, detail=f"视频合成失败: {exc}")

    scheme_video = updated.get("scheme_video")
    if not scheme_video:
        raise HTTPException(status_code=409, detail="该方案没有可用关键帧,无法合成视频")

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
        raise HTTPException(status_code=409, detail="该会话没有基底图")
    base_path = UPLOADS_DIR / reference_image.rsplit("/", 1)[-1]
    if not base_path.exists():
        raise HTTPException(status_code=409, detail="基底图文件不存在")

    instruction = (
        "移除画面中的人物/主体,只保留空场景背景,自然补全人物原本遮挡的环境区域;"
        "严格保持原有场景、构图、光线、色调与透视一致,不要添加任何人物或新的物体。"
    )
    try:
        img = await edit_image([base_path], instruction)
    except RenderError as exc:
        raise HTTPException(status_code=502, detail=f"背景生成失败: {exc}")
    fname = f"{session_id}_backplate.png"
    (UPLOADS_DIR / fname).write_bytes(img)
    return {"session_id": session_id, "url": f"{UPLOADS_URL_PREFIX}/{fname}"}


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
            "selected_scheme_id": values.get("selected_scheme_id"),
        },
    }
