"""Critic node — review generated shot scripts (pure-reasoning fidelity).

Three layers (ADR-0009 + ADR-0010):
1. Hardcoded parameter coupling rules (deterministic, runs first).
2. Deterministic serves-code check: every shot may only serve codes from
   the converged tags + direction dominant intents.
3. LLM judgment: mechanism-chain fidelity against knowledge cards,
   confusable misuse, bipolar-axis consistency.

Verdicts are collected per scheme into ``critic_feedback``; the router
re-Sends only failed directions (capped by regen limit) so passing
schemes are kept as-is.
"""

import logging

from app.graph.coupling import check_all_couplings
from app.graph.state import SessionState
from app.graph.utils import parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import load_ontology

logger = logging.getLogger(__name__)

_ontology = load_ontology()

#: 每个方案最多重生成一轮,防 LLM 永不满意导致死循环
MAX_REGEN_ROUNDS = 1


def _check_serves_codes(candidate: dict, allowed: set[str]) -> list[str]:
    """Deterministic check: shot.serves must stay inside the allowed code set."""
    issues = []
    for shot in candidate.get("shots", []):
        unknown = [c for c in shot.get("serves", []) if c not in allowed]
        if unknown:
            issues.append(
                f"镜头{shot.get('order', '?')} serves 引用了收敛意图之外的 code: {unknown}"
            )
    return issues


async def critic_node(state: SessionState) -> dict:
    """Review every candidate; collect per-scheme revision feedback."""
    client = get_llm_client()
    builder = PromptBuilder()

    intent_state = {
        "raw_intent": state.raw_intent,
        "brief": state.brief,
        "tags": state.tags,
    }

    if not state.candidates:
        logger.warning("Critic: no candidates produced, presenting empty set anyway")
        return {"critic_feedback": {}, "phase": "candidates"}

    feedback: dict[str, str] = {}
    for candidate in state.candidates:
        scheme_id = candidate.get("scheme_id", "?")
        problems: list[str] = []

        # 1. Hardcoded coupling check (deterministic)
        coupling_issues = check_all_couplings(candidate.get("shots", []))
        problems.extend(
            f"[参数耦合] 镜头{i.shot_order} {i.field}: {i.message}" for i in coupling_issues
        )

        # 2. Deterministic serves-code check
        allowed = set(state.tags) | set(candidate.get("dominant_intents", []))
        problems.extend(f"[意图引用] {msg}" for msg in _check_serves_codes(candidate, allowed))

        # 3. LLM mechanism-chain / confusable / axis judgment (only if 1-2 pass)
        if not problems:
            codes = list(dict.fromkeys(state.tags + candidate.get("dominant_intents", [])))
            constraints = _ontology.critic_digest(codes)
            knowledge = _ontology.knowledge_digest(codes)
            # ADR-0017: 激活 skill 的 review.checks 作软检查(仅 suggestions,恒低于硬规则)
            skill_checks = (
                (state.active_skill or {}).get("review", {}).get("checks")
                if state.active_skill
                else None
            )
            system, user = builder.critic(
                intent_state, candidate, constraints, knowledge, skill_checks=skill_checks
            )
            try:
                result = await client.chat(system, user, enable_thinking=False)
                data = parse_llm_json(result, log_name="critic")
                if not data.get("passed", False):
                    issues = data.get("issues", [])
                    problems.extend(
                        f"[{i.get('type', '?')}] 镜头{i.get('shot_order', '?')} "
                        f"{i.get('field', '')}: {i.get('message', '')}"
                        for i in issues
                    )
                    problems.extend(f"[建议] {s}" for s in data.get("suggestions", []))
                    if not issues:
                        problems.append("[意图忠实] 未通过审校(模型未给出具体 issue)")
            except Exception:
                logger.exception("Critic LLM call failed for %s, letting it pass", scheme_id)

        if problems:
            feedback[scheme_id] = "\n".join(problems)
            logger.info("Critic failed scheme %s: %d problems", scheme_id, len(problems))

    if feedback and state.regen_count < MAX_REGEN_ROUNDS:
        return {
            "critic_feedback": feedback,
            "regen_count": state.regen_count + 1,
            "phase": "generate",
        }

    if feedback:
        logger.warning(
            "Regen limit reached, presenting with unresolved feedback: %s", list(feedback)
        )
    return {"critic_feedback": {}, "phase": "candidates"}
