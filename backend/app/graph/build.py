"""LangGraph StateGraph assembly.

Graph topology (ADR-0010 pure-reasoning baseline + HITL gate nodes):

    START → align → convergence_check ──┬─ 未收敛 → ask_user(interrupt) → align
                                        └─ 已收敛 → confirm_gate(interrupt)
                                                      ├─ 确认 → strategy
                                                      └─ 否决 → align
    strategy → [Send("generate") × N 方向, 带完整上下文] → critic
    critic ──┬─ 有失败方案且未达重试上限 → [Send("generate") × 失败方向, 带反馈]
             └─ 全过 / 重试耗尽 → present_candidates(interrupt)
                   ├─ action=writeback → writeback → END
                   └─ action=edit → edit(interrupt 等 patch) → present_candidates

All interrupts live in gate nodes with the interrupt() call at the top —
resume re-execution is cheap and the resume payload is always captured
into state (never discarded).
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from app.graph.nodes import (
    align_node,
    ask_user_node,
    confirm_gate_node,
    convergence_node,
    critic_node,
    edit_node,
    generate_node,
    present_candidates_node,
    strategy_node,
    writeback_node,
)
from app.graph.state import SessionState

# ---------------------------------------------------------------------------
# Router functions — determine which node to transition to next
# ---------------------------------------------------------------------------


def convergence_router(state: SessionState) -> str:
    """converged → confirm_gate;not converged → ask_user (interrupt for widgets)."""
    return "confirm_gate" if state.converged else "ask_user"


def confirm_router(state: SessionState) -> str:
    """User confirmed → strategy;rejected → another align turn."""
    return "strategy" if state.phase == "strategy" else "align"


def _generate_send(state: SessionState, direction: dict) -> Send:
    """Build a Send carrying everything generate_node reads.

    Send 的 payload 会被原样交给分支节点(不经 state schema 校验),
    所以这里直接构造 SessionState,且必须显式带上 raw_intent/brief/tags,
    否则 generate 拿不到意图。
    """
    return Send(
        "generate",
        SessionState(
            raw_intent=state.raw_intent,
            image_brief=state.image_brief,
            brief=state.brief,
            tags=state.tags,
            directions=state.directions,
            current_direction=direction,
            critic_feedback=state.critic_feedback,
            active_skill=state.active_skill,  # ADR-0017: 会话级 skill 随分支下传
            user_id=state.user_id,
            memory_mode=state.memory_mode,  # 实验臂随分支下传(naive 需在 generate 内取记忆)
        ),
    )


def strategy_router(state: SessionState) -> list[Send]:
    """Fan-out: one Send per enumerated direction."""
    directions = state.directions or [{"id": "A", "name": "意图直推方案"}]
    return [_generate_send(state, d) for d in directions]


def critic_router(state: SessionState) -> list[Send] | str:
    """Failed schemes (with feedback, under regen cap) → regenerate those
    directions only;otherwise present."""
    if state.phase == "candidates" or not state.critic_feedback:
        return "present_candidates"
    directions_by_id = {d.get("id"): d for d in state.directions}
    sends = [
        _generate_send(state, directions_by_id[scheme_id])
        for scheme_id in state.critic_feedback
        if scheme_id in directions_by_id
    ]
    return sends or "present_candidates"


def candidates_router(state: SessionState) -> str:
    """After the user's decision: edit loop or adopt (writeback). present 在
    candidates 为空时直接置 done。"""
    if state.phase == "edit":
        return "edit"
    if state.phase == "done":
        return END
    return "writeback"


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------


def build_graph() -> StateGraph:
    """Assemble and return the LangGraph state graph builder.

    The checkpointer (PostgresSaver) is wired in the FastAPI lifespan,
    not here — this function returns an *uncompiled* builder so the caller
    can supply the checkpointer.
    """
    builder = StateGraph(SessionState)

    # -- register nodes --
    builder.add_node("align", align_node)
    builder.add_node("convergence_check", convergence_node)
    builder.add_node("ask_user", ask_user_node)
    builder.add_node("confirm_gate", confirm_gate_node)
    builder.add_node("strategy", strategy_node)
    builder.add_node("generate", generate_node)
    builder.add_node("critic", critic_node)
    builder.add_node("present_candidates", present_candidates_node)
    builder.add_node("edit", edit_node)
    builder.add_node("writeback", writeback_node)

    # -- alignment loop --
    builder.add_edge(START, "align")
    builder.add_edge("align", "convergence_check")
    builder.add_conditional_edges(
        "convergence_check",
        convergence_router,
        {"ask_user": "ask_user", "confirm_gate": "confirm_gate"},
    )
    builder.add_edge("ask_user", "align")
    builder.add_conditional_edges(
        "confirm_gate",
        confirm_router,
        {"strategy": "strategy", "align": "align"},
    )

    # -- generation fan-out & critic loop --
    builder.add_conditional_edges("strategy", strategy_router, ["generate"])
    builder.add_edge("generate", "critic")
    builder.add_conditional_edges(
        "critic", critic_router, ["generate", "present_candidates"]
    )

    # -- selection / edit loop --
    builder.add_conditional_edges(
        "present_candidates",
        candidates_router,
        {"edit": "edit", "writeback": "writeback", END: END},
    )
    builder.add_edge("edit", "present_candidates")
    builder.add_edge("writeback", END)

    return builder
