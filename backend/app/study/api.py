"""Study API — 纵向用户评测端点 (ADR-0019, CineScape 载体)。

端点:
  POST /api/study/participants            创建参与者(自动生成 5 learning + 6 heldout 计划)
  GET  /api/study/participants/{code}     按 participant_code 查参与者
  GET  /api/study/participants/{id}/plan  任务清单(learning + heldout,含盲标 X/Y 与视频 URL)
  POST /api/study/cases/{id}/generate-pair  双分支生成(with/without,利用 frozen_alignment)
  POST /api/study/cases/{id}/choice       提交偏好 + 6 项评分
  GET  /api/study/participants/{id}/export  汇总导出(轨迹/选择/评分/skill 使用)

双分支生成(复用 CineScape 原生能力,不动图拓扑):
  - with    分支:memory_mode=full + frozen_alignment(复制已确认的对齐状态),
               confirm 时 probe_response={"skill_activation":"apply"} → 自动 enact 技能
  - without 分支:memory_mode=off(无记忆,不召回/不探针/不激活),同一 frozen_alignment
  两个分支各自独立 thread,confirm 后停在 candidates,取主方案(A),异步
  render_scheme(关键帧) → animate_scheme(即梦 multimodal2video) → 回写 videos。
  需 EVAL_ALLOW_FROZEN_ALIGNMENT=1(评测部署必设,与 sessions.py 一致)。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from langgraph.types import Command
from pydantic import BaseModel, Field

from app.storage import UPLOADS_DIR, save_reference_image

logger = logging.getLogger(__name__)

study_router = APIRouter()

#: Strong refs to background video-render tasks
_background_tasks: set = set()


def _spawn_background(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class ParticipantBody(BaseModel):
    code: str  # P01..P06
    literacy: str  # novice | intermediate | expert
    intent_code: str  # 1.5 | 3.4 | 8.2


class ChoiceBody(BaseModel):
    preference: str  # left | right | tie
    ratings: dict = Field(default_factory=dict)
    comment: str | None = None


# ---------------------------------------------------------------------------
# Graph helpers (reuse CineScape sessions.py 的语义,不跨模块 import 私有函数)
# ---------------------------------------------------------------------------


def _thread_id(session_id: str) -> str:
    return f"thread_{session_id}"


def _config(thread_id: str) -> dict:
    return {"configurable": {"thread_id": thread_id}}


async def _run_to_interrupt(graph, thread_id: str, input_):
    """Run the graph until the next interrupt or END; return the state snapshot."""
    async for _chunk in graph.astream(input_, config=_config(thread_id), stream_mode="values"):
        pass
    return await graph.aget_state(_config(thread_id))


async def _get_values(graph, session_id: str) -> dict:
    try:
        state = await graph.aget_state(_config(_thread_id(session_id)))
    except Exception:
        return {}
    return state.values or {}


async def _create_branch_session(
    graph,
    *,
    session_id: str,
    raw_intent: str,
    user_id: str,
    memory_mode: str,
    reference_image: str,
    image_brief: str,
    frozen: dict,
) -> dict:
    """创建 frozen_alignment 分支会话(memory_mode=full|off),返回第一轮 turn 的 values。

    复用 sessions.py create_session 的 frozen 分支逻辑:converged=True、
    phase="confirm"、pending_widgets 含探针(仅 full 模式召回)。
    """
    from app.evolution import recall_questions, select_and_advance_probe
    from app.graph.state import SessionState

    normalized_mode = memory_mode if memory_mode in ("full", "naive", "off") else "full"
    tags = [str(t) for t in frozen["tags"]]
    recalled_questions: list[dict] = []
    pending_widgets: list[dict] = []
    if normalized_mode == "full":
        try:
            recalled_questions = await recall_questions(user_id, tags)
            swap = sum(len(q.get("answers") or []) for q in recalled_questions) % 2 == 1
            # ADR-0020 A+C:读/推进用户探针调度状态(验证保底 + 激活不重复)
            probe = await select_and_advance_probe(
                user_id, recalled_questions, already_probed=False, swap=swap
            )
            if probe is not None:
                pending_widgets = [probe]
        except Exception:
            logger.debug("Frozen branch question recall failed", exc_info=True)

    initial_state = SessionState(
        raw_intent=raw_intent,
        user_id=user_id,
        memory_mode=normalized_mode,
        reference_image=reference_image,
        image_brief=image_brief,
        dimensions=frozen.get("dimensions") or {},
        key_dimensions=frozen.get("key_dimensions") or [],
        brief=str(frozen["brief"]),
        tags=tags,
        reflection=str(frozen.get("reflection") or ""),
        recalled_questions=recalled_questions,
        pending_widgets=pending_widgets,
        converged=True,
        phase="confirm",
    ).model_dump()

    state = await _run_to_interrupt(graph, _thread_id(session_id), initial_state)
    return state.values or {}


async def _confirm_branch(graph, session_id: str, active_skill: dict | None = None) -> dict:
    """confirm 分支(停在 confirm gate):把 active_skill 经 resume payload 注入
    (gates.py confirm_gate 消费 decision.active_skill 写入 state)。
    with 分支传已 enact 的技能;without 分支传 None。"""
    resume_value = {
        "type": "confirm",
        "confirmed": True,
        "rejection_text": None,
        "active_skill": active_skill,
    }
    state = await _run_to_interrupt(
        graph,
        _thread_id(session_id),
        Command(resume=resume_value),
    )
    return state.values or {}


def _primary_scheme(values: dict) -> dict | None:
    """主方案 = A 方向候选;保底第一个候选。"""
    candidates = values.get("candidates") or []
    return next(
        (c for c in candidates if c.get("scheme_id") == "A"),
        candidates[0] if candidates else None,
    )


async def _enact_active_skill(graph, session_id: str, values: dict) -> dict | None:
    """with 分支:confirm 前先落 skill_activation=apply 事件并 enact 技能。

    复刻 sessions.py _finalize_probe 的 apply 分支:从已确证、适用的问题
    enact 会话级技能(带用户范例 few-shot)。best-effort,失败返回 None。
    """
    from app.evolution import (
        ACT_APPLY,
        enact,
        get_corroborated_applicable,
        record_event,
    )

    user_id = values.get("user_id") or "anonymous"
    tags = values.get("tags") or []
    if user_id == "anonymous" or values.get("memory_mode", "full") != "full":
        return None
    try:
        corroborated = await get_corroborated_applicable(user_id, tags)
        try:
            from app.recall import fetch_user_exemplars

            exemplars = await fetch_user_exemplars(user_id, tags)
        except Exception:
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
        logger.warning("Study enact failed for %s (non-critical)", session_id, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# 视频渲染(即梦,后台)
# ---------------------------------------------------------------------------


async def _render_branch_video(
    case_id: str, branch: str, session_id: str, scheme: dict, ref_url: str
):
    """后台任务:即梦 render_scheme(关键帧) → animate_scheme(整方案视频) → 回写 videos。"""
    try:
        from app.render import animate_scheme, render_scheme
        from app.study import store as study_store

        base_path = UPLOADS_DIR / ref_url.rsplit("/", 1)[-1] if ref_url else None
        if base_path is None or not base_path.exists():
            logger.warning("Branch base image missing for case %s branch %s", case_id, branch)
            return

        # 1) 关键帧(chained 连贯模式;不写图状态,纯工具调用)
        updated = await render_scheme(session_id, scheme, base_path)

        # 2) 整方案视频(即梦 multimodal2video)
        try:
            animated = await animate_scheme(session_id, updated)
            video_url = animated.get("scheme_video") or animated.get("video_url")
        except Exception:
            logger.exception("Animate failed for case %s branch %s", case_id, branch)
            video_url = None

        # 3) 回写 videos JSON
        case = await study_store.get_case(case_id)
        videos = dict(case.get("videos") or {}) if case else {}
        videos[branch] = video_url
        await study_store.set_case_videos(case_id, videos)
        logger.info("Case %s branch %s video ready: %s", case_id, branch, video_url)
    except Exception:
        logger.exception("Branch video render failed for case %s branch %s", case_id, branch)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@study_router.post("/participants")
async def create_participant(body: ParticipantBody):
    from app.study import store as study_store
    from app.study.protocol import ensure_study_assets

    if body.literacy not in ("novice", "intermediate", "expert"):
        raise HTTPException(status_code=422, detail="literacy 必须为 novice/intermediate/expert")
    if body.intent_code not in ("1.5", "3.4", "8.2"):
        raise HTTPException(status_code=422, detail="intent_code 必须为 1.5/3.4/8.2")

    ensure_study_assets()
    existing = await study_store.get_participant_by_code(body.code)
    if existing:
        return existing

    seed = sum(ord(c) for c in body.code)
    # user_id 必须 eval- 前缀:create_session 的 frozen_alignment 只对 eval 用户开放
    user_id = f"eval-{body.code}"
    participant = await study_store.create_participant(
        body.code, body.literacy, body.intent_code, user_id
    )
    await study_store.create_plan(str(participant["id"]), body.intent_code, seed_offset=seed)
    return participant


@study_router.get("/participants/{code}")
async def get_participant(code: str):
    from app.study import store as study_store

    p = await study_store.get_participant_by_code(code)
    if not p:
        raise HTTPException(status_code=404, detail=f"参与者 {code} 不存在")
    return p


@study_router.get("/participants/{pid}/plan")
async def get_plan(pid: str):
    from app.study import store as study_store
    from app.study.protocol import intent_brief, scene_card, study_asset_url

    participant = await study_store.get_participant(pid)
    if not participant:
        raise HTTPException(status_code=404, detail="参与者不存在")

    runs = await study_store.list_runs(pid)
    cases = await study_store.list_cases(pid)

    learning = []
    for r in runs:
        learning.append(
            {
                "run_index": r["run_index"],
                "scene_id": r["scene_id"],
                "scene_card": scene_card(r["scene_id"]),
                "reference_image": study_asset_url(r["scene_id"]),
                "brief": intent_brief(participant["intent_code"], participant["literacy"]),
                "status": r["status"],
                "session_id": r["session_id"],
                "run_id": str(r["id"]),
            }
        )

    heldout = []
    for c in cases:
        cond_order = c["condition_order"]  # with_first | without_first
        left_is_with = cond_order == "with_first"
        videos = c.get("videos") or {}
        schemes = c.get("schemes") or {}
        heldout.append(
            {
                "id": str(c["id"]),
                "case_index": c["case_index"],
                "scene_id": c["scene_id"],
                "scene_card": scene_card(c["scene_id"]),
                "reference_image": study_asset_url(c["scene_id"]),
                "brief": intent_brief(participant["intent_code"], participant["literacy"]),
                "condition_order": cond_order,
                "status": c["status"],
                "align_session_id": c["align_session_id"],
                "left": {
                    "label": "X",
                    "is_with": left_is_with,
                    "video_url": videos.get("with" if left_is_with else "without"),
                    "scheme": schemes.get("with" if left_is_with else "without"),
                },
                "right": {
                    "label": "Y",
                    "is_with": not left_is_with,
                    "video_url": videos.get("without" if left_is_with else "with"),
                    "scheme": schemes.get("without" if left_is_with else "with"),
                },
            }
        )

    return {
        "participant": participant,
        "intent_code": participant["intent_code"],
        "literacy": participant["literacy"],
        "learning": learning,
        "heldout": heldout,
    }


@study_router.post("/runs/{run_id}/finish")
async def finish_run(run_id: str):
    """学习会话完成屏障(ADR-0019 会话边界同步整理)。

    用户点「完成本学习会话」后调用:同步完成该会话的 memory consolidation
    (reflection 落账),再标记 run done —— 保证下一个会话/heldout with 分支
    能观察到本会话产生的偏好证据,消除异步 reflection 与用户切换步进的竞态。
    """
    from app.evolution import reflect_session
    from app.study import store as study_store

    run = await study_store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run 不存在")

    if run["status"] == "done":
        # 幂等:已整理过直接返回摘要
        summary = await study_store.get_memory_summary(run["user_id"])
        return {"run_id": run_id, "status": "done", "memory": summary}

    if not run.get("session_id"):
        raise HTTPException(
            status_code=409,
            detail="该学习会话尚无 session;请先完成会话交互再点击完成",
        )

    # 同步反射:整理本会话证据到偏好账本(失败则让前端看到错误,不静默丢记忆)
    try:
        await reflect_session(str(run["session_id"]), raise_errors=True)
    except Exception:
        logger.exception(
            "Study run %s reflection failed (session %s)",
            run_id,
            run["session_id"],
        )
        raise HTTPException(
            status_code=500,
            detail="偏好记忆整理失败,请重试或联系实验员",
        )

    await study_store.set_run_done(run_id)
    summary = await study_store.get_memory_summary(run["user_id"])
    logger.info("Study run %s finished; memory=%s", run_id, summary)
    return {"run_id": run_id, "status": "done", "memory": summary}


@study_router.post("/cases/{case_id}/generate-pair")
async def generate_pair(case_id: str, request: Request):
    from app.study import store as study_store
    from app.study.protocol import scene_asset_path

    graph = request.app.state.graph
    case = await study_store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="case 不存在")
    if case["status"] in ("comparing", "done"):
        return {"case_id": case_id, "status": case["status"]}

    participant = await study_store.get_participant(str(case["participant_id"]))
    if not participant:
        raise HTTPException(status_code=404, detail="参与者不存在")

    # 守卫:所有 learning run 必须已 finish(记忆已整理)才能生成 with 分支,
    # 否则 with 分支的 skill 可能缺最新偏好,损害双分支对比的公平性。
    if await study_store.has_incomplete_learning(str(case["participant_id"])):
        raise HTTPException(
            status_code=409,
            detail="仍有未完成的学习会话;请先完成并整理全部 5 个学习会话再进入评测",
        )

    snapshot = case.get("brief_snapshot") or {}
    if not snapshot.get("brief") or not snapshot.get("tags"):
        raise HTTPException(
            status_code=409,
            detail="case 尚未完成对齐(brief/tags 为空);请先在 align 会话确认",
        )

    user_id = participant["user_id"]
    raw_intent = snapshot.get("raw_intent") or case.get("intent_code") or ""
    frozen = {
        "raw_intent": raw_intent,
        "image_brief": snapshot.get("image_brief") or "",
        "dimensions": snapshot.get("dimensions") or {},
        "key_dimensions": snapshot.get("key_dimensions") or [],
        "brief": snapshot.get("brief", ""),
        "tags": snapshot.get("tags", []),
        "reflection": snapshot.get("reflection") or "",
    }

    # 基底图:场景参考图(评测素材) → 落 uploads/ 供分支会话引用
    scene_img = scene_asset_path(case["scene_id"])
    if not scene_img.exists():
        raise HTTPException(status_code=409, detail=f"场景素材缺失: {scene_img}")
    with_session = str(uuid.uuid4())
    without_session = str(uuid.uuid4())
    ref_url, _ = save_reference_image(with_session, scene_img.read_bytes(), "image/png")

    # with 分支:memory_mode=full,frozen_alignment 注入
    with_values = await _create_branch_session(
        graph,
        session_id=with_session,
        raw_intent=raw_intent,
        user_id=user_id,
        memory_mode="full",
        reference_image=ref_url,
        image_brief=frozen["image_brief"],
        frozen=frozen,
    )
    # with 分支:enact 技能(基于已确证、适用问题)并注入 confirm
    skill = await _enact_active_skill(graph, with_session, with_values)
    with_vals2 = await _confirm_branch(graph, with_session, active_skill=skill)

    # without 分支:memory_mode=off(无记忆),同一 frozen_alignment,不注入技能
    without_values = await _create_branch_session(
        graph,
        session_id=without_session,
        raw_intent=raw_intent,
        user_id=user_id,
        memory_mode="off",
        reference_image=ref_url,
        image_brief=frozen["image_brief"],
        frozen=frozen,
    )
    without_vals2 = await _confirm_branch(graph, without_session, active_skill=None)

    with_scheme = _primary_scheme(with_vals2)
    without_scheme = _primary_scheme(without_vals2)
    # 异步渲染两个分支(即梦关键帧 → 整方案视频),完成后回写 videos
    if with_scheme:
        _spawn_background(_render_branch_video(case_id, "with", with_session, with_scheme, ref_url))
    if without_scheme:
        _spawn_background(
            _render_branch_video(case_id, "without", without_session, without_scheme, ref_url)
        )
    return {
        "case_id": case_id,
        "status": "rendering",
        "with": {"scheme_id": (with_scheme or {}).get("scheme_id")},
        "without": {"scheme_id": (without_scheme or {}).get("scheme_id")},
    }


@study_router.post("/cases/{case_id}/choice")
async def submit_choice(case_id: str, body: ChoiceBody):
    from app.study import store as study_store

    if body.preference not in ("left", "right", "tie"):
        raise HTTPException(status_code=422, detail="preference 必须为 left/right/tie")
    case = await study_store.get_case(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="case 不存在")
    await study_store.save_choice(case_id, body.preference, body.ratings, body.comment)
    return {"case_id": case_id, "status": "done"}


@study_router.get("/participants/{pid}/export")
async def export_participant(pid: str):
    from app.study import store as study_store

    participant = await study_store.get_participant(pid)
    if not participant:
        raise HTTPException(status_code=404, detail="参与者不存在")

    runs = await study_store.list_runs(pid)
    cases = await study_store.list_cases(pid)
    choices = []
    for c in cases:
        ch = await study_store.get_choice(str(c["id"]))
        if ch:
            choices.append(
                {
                    "case_index": c["case_index"],
                    "scene_id": c["scene_id"],
                    "condition_order": c["condition_order"],
                    "preference": ch["preference"],
                    "ratings": ch["ratings"],
                    "comment": ch["comment"],
                }
            )

    traces = []
    for r in runs:
        if r["session_id"]:
            try:
                from app.evolution import load_session_trace

                traces.append(
                    {
                        "run_index": r["run_index"],
                        "session_id": r["session_id"],
                        "events": await load_session_trace(r["session_id"]),
                    }
                )
            except Exception:
                logger.warning("Trace load failed for run %s", r["run_index"], exc_info=True)

    return {
        "participant": participant,
        "learning_runs": runs,
        "heldout_choices": choices,
        "learning_traces": traces,
    }
