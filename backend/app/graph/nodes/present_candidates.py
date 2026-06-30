"""Present candidates node — show A/B/C and capture the user's decision.

Interrupt-first gate node: pauses with the generated schemes (plus any
edit-revalidation conflicts from a previous loop), then captures the
resume payload ``{scheme_id, action}`` into state.

action: "writeback"(采纳)| "edit"(进入编辑循环)
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from app.graph.state import SessionState

logger = logging.getLogger(__name__)


async def present_candidates_node(state: SessionState) -> dict:
    """Pause with candidates; capture {scheme_id, action} on resume."""
    candidates = state.candidates or []
    if not candidates:
        # critic 全军覆没且重试耗尽:无东西可选,只能结束会话
        logger.error("present_candidates: no candidates to show, ending session")
        return {"phase": "done"}

    decision = interrupt(
        {
            "type": "candidates",
            "schemes": candidates,
            "conflicts": [
                c.model_dump() if hasattr(c, "model_dump") else c for c in state.conflicts
            ],
            "selected_scheme_id": state.selected_scheme_id,
        }
    )

    scheme_id = (decision or {}).get("scheme_id")
    action = (decision or {}).get("action") or "writeback"
    known_ids = {c.get("scheme_id") for c in candidates}
    if scheme_id not in known_ids:
        logger.warning("Unknown scheme_id %s, defaulting to first candidate", scheme_id)
        scheme_id = candidates[0].get("scheme_id")
    if action not in ("writeback", "edit"):
        action = "writeback"

    logger.info("User selected scheme %s, action=%s", scheme_id, action)
    return {
        "selected_scheme_id": scheme_id,
        "conflicts": [],
        "phase": action,
    }
