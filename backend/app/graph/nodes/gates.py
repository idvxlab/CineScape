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

    text = format_widget_responses(
        (response or {}).get("dim_widget_responses"),
        (response or {}).get("free_text"),
    )
    logger.info("ask_user captured response: %s", text[:200])
    return {
        "messages": [{"role": "user", "content": text}],
        "pending_widgets": [],
        "phase": "align",
    }


async def confirm_gate_node(state: SessionState) -> dict:
    """Pause with the converged brief/tags; capture confirm or reject."""
    decision = interrupt(
        {
            "type": "confirm",
            "reflection": state.reflection or "",
            "reasoning": state.reasoning_trace or "",
            "brief": state.brief or "",
            "tags": state.tags,
        }
    )

    if (decision or {}).get("confirmed", False):
        logger.info("User confirmed alignment, proceeding to strategy")
        return {"phase": "strategy"}

    rejection = (decision or {}).get("rejection_text") or "用户否决了当前复述,请进一步澄清。"
    logger.info("User rejected alignment: %s", rejection[:200])
    return {
        "messages": [{"role": "user", "content": f"[否决复述] {rejection}"}],
        "converged": False,
        "phase": "align",
    }
