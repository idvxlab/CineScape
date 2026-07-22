"""Edit node — user-driven modification of the selected shot script.

Edit is a *mode* of generation, not a separate agent class.

Interrupt-first gate: pauses with the selected scheme, captures the
patch ``[{shot_order, field, value}]`` (plus optional free-text request),
applies it deterministically, then LLM-revalidates the patched script.
Loops back to present_candidates with conflicts attached so the user can
keep editing, re-select, or adopt.
"""

from __future__ import annotations

import copy
import logging

from langgraph.types import interrupt

from app.graph.state import SessionState
from app.graph.utils import parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import TEN_PARAMS

logger = logging.getLogger(__name__)

_EDITABLE_FIELDS = set(TEN_PARAMS) | {"rationale", "frame_edit_hint"}


def _apply_patch(candidate: dict, patch: list[dict]) -> tuple[dict, list[dict]]:
    """Apply field-level patch ops to a deep-copied candidate.

    Returns (patched_candidate, rejected_ops_as_conflicts).
    """
    updated = copy.deepcopy(candidate)
    shots_by_order = {s.get("order"): s for s in updated.get("shots", [])}
    rejected: list[dict] = []

    for op in patch or []:
        order = op.get("shot_order")
        field = op.get("field", "")
        value = op.get("value")
        shot = shots_by_order.get(order)
        if shot is None:
            rejected.append(
                {"shot_order": order or 0, "field": field, "message": f"镜头 {order} 不存在"}
            )
            continue
        if field not in _EDITABLE_FIELDS:
            rejected.append(
                {"shot_order": order, "field": field, "message": f"字段 {field} 不可编辑"}
            )
            continue
        shot[field] = value

    return updated, rejected


async def edit_node(state: SessionState) -> dict:
    """Pause for an edit patch, apply it, revalidate, loop to present."""
    selected = next(
        (c for c in state.candidates if c.get("scheme_id") == state.selected_scheme_id),
        None,
    )
    if not selected:
        logger.warning("edit_node: selected scheme %s not found", state.selected_scheme_id)
        return {"phase": "candidates"}

    payload = interrupt(
        {
            "type": "edit_request",
            "scheme": selected,
            "conflicts": [
                c.model_dump() if hasattr(c, "model_dump") else c for c in state.conflicts
            ],
        }
    )

    patch = (payload or {}).get("patch", [])
    free_text = (payload or {}).get("free_text")

    updated, conflicts = _apply_patch(selected, patch)

    if patch or free_text:
        # LLM revalidate:编辑是否破坏一致性 / 削弱 serves 声称的意图
        client = get_llm_client()
        builder = PromptBuilder()
        edit_desc = {"patch": patch, "free_text": free_text or ""}
        system, user = builder.edit_revalidate(updated, edit_desc)
        try:
            result = await client.chat(system, user, enable_thinking=False)
            data = parse_llm_json(result, log_name="edit")
            conflicts.extend(data.get("conflicts", []))
        except Exception:
            logger.exception("Edit revalidation LLM call failed")
            conflicts.append(
                {
                    "shot_order": 0,
                    "field": "system",
                    "message": "校验服务暂不可用,编辑已应用但未审校",
                }
            )

    return {
        "candidates": [updated],  # upsert by scheme_id
        "conflicts": conflicts,
        "phase": "candidates",
    }
