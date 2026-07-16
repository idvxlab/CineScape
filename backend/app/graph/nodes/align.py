"""Align node — one LLM alignment turn (no interrupt here).

Reads the latest user input (raw intent on the first turn, widget
responses appended to ``messages`` by the ask_user gate afterwards),
updates dimension states, and proposes widgets for the next round.
Uses qualitative reasoning, never numeric scoring.

HITL wiring (the interrupt itself lives in dedicated gate nodes):
    align → convergence_check → ask_user(interrupt) → align → …
                              ↘ confirm_gate(interrupt) → strategy
"""

from __future__ import annotations

import logging

from app.evolution import recall_questions, select_probe
from app.graph.state import SessionState
from app.graph.utils import extract_last_user_input, normalize_widgets, parse_llm_json
from app.llm import PromptBuilder, get_llm_client
from app.ontology import load_ontology

logger = logging.getLogger(__name__)

_ontology = load_ontology()

_DEFAULT_WIDGET = {
    "kind": "freetext",
    "prompt": "Tell us more about your intent: what emotion or atmosphere do you want the audience to feel?",
    "suggestions": ["Tense & uneasy", "Warm & intimate", "Lonely & detached", "Awe-inspiring"],
}


def _provisional_tags(dimensions: dict) -> list[str]:
    """Collect candidate 二级意图 codes accumulated so far, for question recall.

    Tags are only finalized at convergence; during alignment we approximate the
    intent scope from each dimension update's ``candidates`` list.
    """
    tags: set[str] = set()
    for dim in (dimensions or {}).values():
        if isinstance(dim, dict):
            for c in dim.get("candidates") or []:
                tags.add(c)
    return list(tags)


def _count_user_turns(messages: list | None) -> int:
    """统计用户在 align 阶段回答过的轮数(ask_user 把回应作为 user 消息追加进 messages)。"""
    return sum(
        1
        for m in (messages or [])
        if (getattr(m, "type", None) == "human" or getattr(m, "role", None) == "user")
    )


async def align_node(state: SessionState) -> dict:
    """Run one alignment turn: parse latest user input, update dims, propose widgets."""
    client = get_llm_client()
    builder = PromptBuilder()

    user_input = extract_last_user_input(state.messages) or state.raw_intent

    design_space = _ontology.alignment_digest()
    current_intent = {
        "raw_intent": state.raw_intent,
        "dimensions": state.dimensions,
    }

    reasoning = ""
    try:
        system, user = builder.align_intent(
            design_space, current_intent, user_input, image_brief=state.image_brief
        )
        result, reasoning = await client.chat(system, user, return_reasoning=True)
        data = parse_llm_json(result, fallback={}, log_name="align")
    except Exception:
        logger.exception("Align node: LLM call or JSON parse failed")
        data = {}

    pending_widgets = normalize_widgets(data.get("widgets") or [])
    reflection = data.get("reflection") or state.reflection
    dim_updates = data.get("dimension_updates", {})

    # 用户已经回答过几轮 align 提问(ask_user 会把回应作为 user 消息追加进 messages)
    user_turns = _count_user_turns(state.messages)

    if not pending_widgets:
        # 无条件兜底:模型没产出控件就给一个自由问答控件,保证每次回到用户(ask_user)都有可交互控件。
        # 修复"只有 reflection、没有控件"的空轮 —— 成因是 align 判 ready_to_generate 但 convergence
        # 未收敛的矛盾态:align 因 ready 不出控件,convergence 又判未收敛→回 ask_user→前端拿到空 widgets。
        # 若本轮确可收敛,convergence 会判 converged→confirm,此兜底控件被忽略,不影响收敛。
        logger.info("Align node: no widgets produced, falling back to default prompt (user_turns=%d)", user_turns)
        pending_widgets = [_DEFAULT_WIDGET]

    # 记忆探针(ADR-0017):用户已答过至少一轮、本会话尚未真正探针过、非匿名时,
    # 追加至多一条探针控件(验证探针 a/b/两可 或 skill 激活探针)。匿名/库空零影响,
    # 失败绝不阻塞对齐。注意:本拓扑里 convergence 可能跳过本轮控件直接收敛,
    # 因此 ``probed`` 不在此置位,而在 ask_user 门控**实际展示**探针时置位——
    # 被跳过的探针不消耗每会话预算。
    recalled: list = list(state.recalled_questions or [])
    if user_turns >= 1 and not state.probed and state.user_id != "anonymous":
        try:
            recalled = await recall_questions(state.user_id, _provisional_tags(state.dimensions))
        except Exception:
            logger.debug("Question recall failed in align, skipping probe", exc_info=True)
            recalled = []
        # a/b 跨会话换序消位置偏差:用已答问题总数的奇偶决定本次是否 swap
        swap = sum(len(q.get("answers") or []) for q in recalled) % 2 == 1
        has_probe = any(
            w.get("kind") in ("preference_probe", "skill_activation") for w in pending_widgets
        )
        probe = (
            None if has_probe
            else select_probe(recalled, already_probed=state.probed, swap=swap)
        )
        if probe is not None:
            pending_widgets = pending_widgets + [probe]

    return {
        "dimensions": dim_updates,
        "pending_widgets": pending_widgets,
        "reflection": reflection,
        "reasoning_trace": reasoning,
        "recalled_questions": recalled,
        "phase": "align",
    }
