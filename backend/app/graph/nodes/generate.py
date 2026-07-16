"""Generate node — plan→detail shot script generation (pure reasoning).

Invoked via ``Send()`` fan-out: the branch state is exactly the Send
payload (raw_intent / brief / tags / current_direction / critic_feedback),
NOT the full global state — the strategy/critic routers must pass every
field this node reads.

Knowledge cards for the converged intent set are the film-grammar anchor
(ADR-0010); every shot declares which sub-intents it serves.  The
candidate's scheme_id is forced to the direction id so critic feedback
and regeneration map 1:1.
"""

import logging

from app.graph.state import SessionState
from app.graph.utils import parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import load_ontology

logger = logging.getLogger(__name__)

_ontology = load_ontology()


async def generate_node(state: SessionState) -> dict:
    """Generate (or regenerate, with critic feedback) one direction's script."""
    if isinstance(state, dict):  # Send payload arrives unvalidated
        state = SessionState.model_validate(state)

    client = get_llm_client()
    builder = PromptBuilder()

    direction = state.current_direction or (state.directions[0] if state.directions else {})
    direction_id = direction.get("id", "A")

    intent_state = {
        "raw_intent": state.raw_intent,
        "brief": state.brief,
        "tags": state.tags,
    }

    # 知识卡覆盖:收敛 tags + 该方向主导意图(可能含 tags 外的构成手段)
    codes = list(dict.fromkeys(state.tags + direction.get("dominant_intents", [])))
    knowledge = _ontology.knowledge_digest(codes)

    feedback = state.critic_feedback.get(direction_id)

    system, user = builder.generate_direction(
        intent_state,
        direction,
        knowledge,
        critic_feedback=feedback,
        image_brief=state.image_brief,
        active_skill=state.active_skill,
    )

    try:
        result = await client.chat(system, user)
    except Exception:
        logger.exception("Generate LLM call failed for direction %s", direction_id)
        return {"candidates": []}

    data = parse_llm_json(result, log_name="generate")
    if not data or not data.get("shots"):
        logger.warning("Generate produced empty script for direction %s", direction_id)
        return {"candidates": []}

    # scheme_id 与方向 id 强制一致,反馈/重生成按此映射
    data["scheme_id"] = direction_id
    data.setdefault("strategy", direction.get("name", ""))
    data.setdefault("dominant_intents", direction.get("dominant_intents", []))
    data.setdefault("mechanism", direction.get("mechanism", ""))

    # 并行分支只写带 reducer 的 candidates,不写 phase(单写字段并行会冲突)
    return {"candidates": [data]}
