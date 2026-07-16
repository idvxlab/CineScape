"""HITL gate nodes — the only places the align loop pauses for the user.

Both nodes call ``interrupt()`` at the very top with no LLM work before
it, so re-execution on resume is cheap and deterministic.  The resume
payload is *captured* (not discarded) and written into graph state —
this is the wiring that feeds user responses back into the align loop.

ask_user      未收敛:抛出 align 产出的 widgets,把用户回应序列化进 messages。
confirm_gate  已收敛:抛出 brief/tags 复述;确认 → strategy,否决 → 回 align。
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from app.graph.state import SessionState
from app.graph.utils import format_widget_responses

logger = logging.getLogger(__name__)


async def ask_user_node(state: SessionState) -> dict:
    """Pause with the pending widgets; capture the user's responses."""
    response = interrupt(
        {
            "type": "widgets",
            "widgets": state.pending_widgets,
            "reflection": state.reflection or "",
            "reasoning": state.reasoning_trace or "",
        }
    )

    # 探针答案不进对话文本(它是元交互,不是意图澄清);API 层已剥离并记入 trace。
    text = format_widget_responses(
        (response or {}).get("dim_widget_responses"),
        (response or {}).get("free_text"),
    )
    logger.info("ask_user captured response: %s", text[:200])
    updates: dict = {
        "messages": [{"role": "user", "content": text}],
        "pending_widgets": [],
        "phase": "align",
    }
    # ADR-0017: 探针在此**实际展示**过才消耗每会话预算(align 侧不置位,
    # 因为本拓扑中 convergence 可能跳过控件直接收敛)。
    if any(
        w.get("kind") in ("preference_probe", "skill_activation")
        for w in (state.pending_widgets or [])
    ):
        updates["probed"] = True
    return updates


async def confirm_gate_node(state: SessionState) -> dict:
    """Pause with the converged brief/tags; capture confirm or reject.

    ADR-0017: 若 align 本轮搭车了探针但 convergence 直接收敛(未经 ask_user 展示),
    探针改挂到 confirm 门控——收敛必经之路,且此刻 brief+tags 就在眼前,
    applicability 对用户透明。展示过即消耗每会话预算。
    """
    probe = next(
        (
            w for w in (state.pending_widgets or [])
            if w.get("kind") in ("preference_probe", "skill_activation")
        ),
        None,
    ) if not state.probed else None
    decision = interrupt(
        {
            "type": "confirm",
            "reflection": state.reflection or "",
            "reasoning": state.reasoning_trace or "",
            "brief": state.brief or "",
            "tags": state.tags,
            "probe": probe,
        }
    )

    if (decision or {}).get("confirmed", False):
        logger.info("User confirmed alignment, proceeding to strategy")
        updates: dict = {"phase": "strategy"}
        if probe is not None:
            updates["probed"] = True  # 在 confirm 门控实际展示过
        # API 层在 confirm 时已完成探针裁决与 applicability 二次校验,把激活的
        # 会话级 workflow skill 经 resume payload 注入(ADR-0017),供 strategy/generate 消费。
        active_skill = (decision or {}).get("active_skill")
        if active_skill:
            updates["active_skill"] = active_skill
        return updates

    rejection = (decision or {}).get("rejection_text") or "用户否决了当前复述,请进一步澄清。"
    logger.info("User rejected alignment: %s", rejection[:200])
    updates_rej: dict = {
        "messages": [{"role": "user", "content": f"[否决复述] {rejection}"}],
        "converged": False,
        "phase": "align",
    }
    if probe is not None:
        updates_rej["probed"] = True
    return updates_rej
