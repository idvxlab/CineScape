"""Strategy node — derive A/B/C creative directions from the design space.

ADR-0010 (pure reasoning): directions are *enumerated over the design space*
— for the converged intent set, propose up to three genuinely different
mechanism paths (which intent family dominates, which mechanism carries the
effect).  No exemplar library is required.

Retrieval is an optional enhancer: if the solution library happens to hold
matching records (flywheel-grown), they are attached as extra context, but
their absence never blocks or degrades the base path.
"""

import logging

from app.evolution import reorder_directions
from app.graph.state import SessionState
from app.graph.utils import parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import load_ontology

logger = logging.getLogger(__name__)

_ontology = load_ontology()


async def _try_recall_enrichment(tags: list[str]) -> list:
    """Best-effort library lookup. Empty list on any failure — never blocks."""
    try:
        from app.recall import hybrid_search

        result = await hybrid_search(tags, brief_embedding=None, limit=6)
        return result.exemplars
    except Exception:
        logger.debug("Recall enrichment unavailable, proceeding pure-reasoning", exc_info=True)
        return []


async def strategy_node(state: SessionState) -> dict:
    """Enumerate up to three mechanism paths for the aligned intent set."""
    client = get_llm_client()
    builder = PromptBuilder()

    valid_tags, rejected = _ontology.validate_tags(state.tags)
    if rejected:
        logger.warning("Dropping unknown intent codes from tags: %s", rejected)

    intent_state = {
        "raw_intent": state.raw_intent,
        "brief": state.brief,
        "tags": valid_tags,
    }

    exemplars = await _try_recall_enrichment(valid_tags)

    system, user = builder.strategy_directions(
        intent_state,
        knowledge=_ontology.knowledge_digest(valid_tags),
        constraints=_ontology.critic_digest(valid_tags),
        exemplars=[e.model_dump() for e in exemplars],
        image_brief=state.image_brief,
    )

    try:
        result = await client.chat(system, user, enable_thinking=False)
        data = parse_llm_json(result, fallback={}, log_name="strategy")
    except Exception:
        logger.exception("Strategy LLM call failed")
        data = {}

    directions = data.get("directions") or []
    if not directions:
        # 单方向兜底:仍走纯推理生成,只是不再分叉
        directions = [
            {
                "id": "A",
                "name": "Direct reasoning scheme",
                "dominant_intents": valid_tags,
                "mechanism": "",
                "core_technique": "",
            }
        ]
    directions = directions[:3]
    # skill 只排序、不过滤(ADR-0017 集合不变式):匹配偏好机制/意图的方向排到前面,
    # 但所有方向都保留——个性化不剥夺探索。id 在排序后再按序赋 A/B/C。
    directions = reorder_directions(directions, state.active_skill)
    # 方向 id 强制为按序 A/B/C:scheme_id、critic 反馈、重生成都按它映射
    for i, d in enumerate(directions):
        d["id"] = chr(ord("A") + i)

    return {
        "directions": directions,
        "tags": valid_tags,
        "exemplars": exemplars,
        "recall_signal": "rich" if len(exemplars) >= 3 else ("thin" if exemplars else "empty"),
        "phase": "generate",
    }
