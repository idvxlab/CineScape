"""Convergence check node — LLM-based convergence judgment (ADR-0003).

Pure judgment, no interrupt: maintains the sticky key-dimension set and
decides converged / not converged from dimension states + dialogue
history.  The human-in-the-loop pauses live in the gate nodes
(ask_user / confirm_gate) that follow.

收敛产物:brief + tags(经本体校验)。converge=True 但 tags 为空时
视为未收敛——下游 strategy 没有意图可推。
"""

from __future__ import annotations

import logging

from app.graph.state import SessionState
from app.graph.utils import parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import load_ontology

logger = logging.getLogger(__name__)

_ontology = load_ontology()


async def convergence_node(state: SessionState) -> dict:
    """Evaluate convergence using LLM qualitative reasoning."""
    client = get_llm_client()
    builder = PromptBuilder()

    design_space = _ontology.alignment_digest()
    intent_state = {
        "raw_intent": state.raw_intent,
        "dimensions": state.dimensions,
        "key_dimensions": state.key_dimensions,
    }

    dialogue_history = [
        {
            "role": getattr(m, "type", None) or getattr(m, "role", ""),
            "content": getattr(m, "content", ""),
        }
        for m in (state.messages or [])
    ]

    system, prompt = builder.check_convergence(
        design_space, intent_state, dialogue_history, image_brief=state.image_brief
    )

    reasoning = ""
    try:
        result, reasoning = await client.chat(system, prompt, return_reasoning=True)
        data = parse_llm_json(result, fallback={}, log_name="convergence")
    except Exception:
        logger.exception("Convergence LLM call failed, defaulting to not converged")
        return {"converged": False, "phase": "align"}

    key_dims = (
        list(data.get("key_dimensions", {}).keys())
        if data.get("key_dimensions")
        else state.key_dimensions
    )
    reflection = data.get("reflection", state.reflection) or ""

    tags = data.get("tags", []) or state.tags or []
    valid_tags, rejected = _ontology.validate_tags(tags)
    if rejected:
        logger.warning("Convergence produced unknown intent codes, dropped: %s", rejected)
    brief = data.get("brief", "") or state.brief or ""

    converged = bool(data.get("converge", False)) and bool(valid_tags) and bool(brief)

    # 询问步骤是必须的:用户还没回答过任何 align 提问前,一律不许收敛 ——
    # 否则首轮 align→convergence 直接收敛会跳过 ask_user,用户没被问过就进确认。
    user_turns = sum(
        1
        for m in (state.messages or [])
        if (getattr(m, "type", None) == "human" or getattr(m, "role", None) == "user")
    )
    if converged and user_turns == 0:
        logger.info("Convergence suppressed: mandatory first ask_user round not completed yet")
        converged = False

    if not converged:
        logger.info("Convergence NOT reached (LLM judgment)")
        return {
            "key_dimensions": key_dims,
            "reflection": reflection,
            "reasoning_trace": reasoning,
            "converged": False,
            "phase": "align",
        }

    logger.info("Convergence reached, awaiting user confirmation. tags=%s", valid_tags)
    return {
        "key_dimensions": key_dims,
        "brief": brief,
        "tags": valid_tags,
        "reflection": reflection,
        "reasoning_trace": reasoning,
        "converged": True,
        "phase": "confirm",
    }
