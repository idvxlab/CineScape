"""Workflow-skill enactment (ADR-0017 §1.5, architecture §3.5).

A workflow skill is a *view* over the ledger: ``K_t = Enact(C_t)`` where
``C_t`` is the set of corroborated, in-scope questions whose prevailing answer
is not indifference (``open``). It is not stored as a second source of truth —
it is recomputed from the corroborated question set.

``enact`` and the consumption helpers are pure so they can be unit-tested
without a database. Fields are validated against the ten-parameter whitelist;
anything outside it is dropped rather than trusted.
"""

from __future__ import annotations

import logging
from typing import Any

from app.evolution.questions import (
    ANSWER_A,
    ANSWER_B,
    prevailing_answer,
)
from app.ontology import TEN_PARAMS

logger = logging.getLogger(__name__)

_TEN = set(TEN_PARAMS)


def _preferred_avoided(question: dict[str, Any]) -> tuple[dict, dict] | None:
    """Return (preferred_alt, avoided_alt) per the prevailing answer, or None
    if the question is indifferent (open) or unsettled."""
    p = prevailing_answer(question.get("answers") or [])
    if p == ANSWER_A:
        return question.get("alt_a") or {}, question.get("alt_b") or {}
    if p == ANSWER_B:
        return question.get("alt_b") or {}, question.get("alt_a") or {}
    return None  # open / unsettled → no executable guidance


def _detail_rules(alt: dict[str, Any]) -> dict[str, str]:
    """Extract whitelisted {field: value} from an alternative's detail."""
    detail = alt.get("detail") or {}
    return {f: v for f, v in detail.items() if f in _TEN and v is not None}


def enact(
    corroborated_questions: list[dict[str, Any]],
    exemplar_records: list[dict[str, Any]] | None = None,
    version: int | None = None,
) -> dict[str, Any] | None:
    """Compose a WorkflowSkill from corroborated, applicable questions.

    Two layers, assembled from the same inputs in one pass (ADR-0018):
    - presentation layer (``workflow`` reasoning-chain steps, ``examples``
      few-shot shots from the user's own exemplar library, ``reference``
      back-pointers) — what the generator reasons with;
    - validation layer (``strategy/plan/detail/review``) — what machines
      consume (reordering, outcome detection, whitelist guards).

    Chain text comes from ledger-stored ``alt.mechanism`` written at discovery
    time; no LLM runs here. ``exemplar_records`` are pre-fetched by the caller
    (the enactment stays a pure function of its inputs). Returns None if no
    question yields executable guidance (→ pure-reasoning baseline). On a
    per-field conflict the question with more agreeing sessions wins.
    """
    prefer: dict[str, tuple[str, int]] = {}  # field → (value, agreeing_sessions)
    avoid: dict[str, set[str]] = {}
    prefer_intent_codes: list[str] = []
    applicability: list[str] = []
    shot_count: int | None = None
    sequence_pattern: str | None = None
    source_ids: list[str] = []
    review_checks: list[str] = []
    detail_steps: list[dict[str, Any]] = []  # workflow detail 步(每问题一条推理链)

    for q in corroborated_questions or []:
        pa = _preferred_avoided(q)
        if pa is None:
            continue
        preferred, avoided = pa
        agreeing = _agreeing_count(q)
        source_ids.append(q.get("question_id", ""))

        # scope → applicability + strategy ordering
        if q.get("scope_type") == "intent_leaf" and q.get("scope_id"):
            applicability.append(q["scope_id"])
            prefer_intent_codes.append(q["scope_id"])
        for code in (preferred.get("intent_codes") or []):
            prefer_intent_codes.append(code)

        # detail prefer/avoid, conflict resolved by agreeing count
        pref_fields = _detail_rules(preferred)
        for field, value in pref_fields.items():
            if field not in prefer or agreeing > prefer[field][1]:
                prefer[field] = (str(value), agreeing)
        for field, value in _detail_rules(avoided).items():
            avoid.setdefault(field, set()).add(str(value))

        # plan hints (first corroborated question that specifies them wins)
        plan = preferred.get("plan") or {}
        if shot_count is None and isinstance(plan.get("shot_count"), int):
            shot_count = plan["shot_count"]
        if sequence_pattern is None and plan.get("sequence_pattern"):
            sequence_pattern = plan["sequence_pattern"]

        if q.get("decision"):
            review_checks.append(f"是否体现:{q['decision']} → {preferred.get('label', '')}")

        # workflow detail step: 决策轴 → 倾向 → 机制理由 → 参数 (推理链片段)
        detail_steps.append(_chain_step(q, preferred, avoided, pref_fields))

    prefer_rules = [{"field": f, "values": [v]} for f, (v, _) in sorted(prefer.items())]
    # avoid only what we do not also prefer
    avoid_rules = []
    for f, vs in sorted(avoid.items()):
        remaining = vs - {prefer[f][0]} if f in prefer else vs
        if remaining:
            avoid_rules.append({"field": f, "values": sorted(remaining)})

    if not (prefer_rules or avoid_rules or prefer_intent_codes or shot_count or sequence_pattern):
        return None

    intent_codes = sorted(set(applicability))
    workflow = _build_workflow(
        prefer_intent_codes=_dedup(prefer_intent_codes),
        shot_count=shot_count,
        sequence_pattern=sequence_pattern,
        detail_steps=detail_steps,
        review_checks=review_checks,
    )
    examples = select_examples(exemplar_records or [], {f: v for f, (v, _) in prefer.items()})

    return {
        "version": version or 1,
        "source_question_ids": [s for s in source_ids if s],
        "applicability": {"intent_codes": intent_codes},
        # ---- 呈现层(ADR-0018): workflow / examples / reference ----
        "workflow": workflow,
        "examples": examples,
        "reference": {
            "question_ids": [s for s in source_ids if s],
            "intent_codes": _dedup(intent_codes + _dedup(prefer_intent_codes)),
            "exemplar_ids": _dedup([e["source"] for e in examples]),
        },
        # ---- 校验层(ADR-0017): 机器消费,排序/outcome/白名单守卫 ----
        "strategy": {"prefer_intent_codes": _dedup(prefer_intent_codes)},
        "plan": {"shot_count": shot_count, "sequence_pattern": sequence_pattern},
        "detail": {"prefer": prefer_rules, "avoid": avoid_rules},
        "review": {"checks": review_checks},
        "rationale": f"由 {len([s for s in source_ids if s])} 道已确证偏好问题合成",
    }


def _chain_step(
    q: dict[str, Any],
    preferred: dict[str, Any],
    avoided: dict[str, Any],
    pref_fields: dict[str, str],
) -> dict[str, Any]:
    """One workflow detail step: a reasoning-chain fragment assembled from
    ledger-stored text (decision axis → preferred label → mechanism → params).

    The mechanism sentence was authored by the discovery LLM and audited via
    the memory panel; assembly here is a deterministic template.
    """
    parts = [f"处理「{q.get('decision', '')}」时,倾向『{preferred.get('label', '')}』"]
    mechanism = preferred.get("mechanism")
    if mechanism:
        parts.append(f"—— 机制:{mechanism}")
    if pref_fields:
        params = " · ".join(f"{f}={v}" for f, v in sorted(pref_fields.items()))
        parts.append(f"(参数落点:{params})")
    if avoided.get("label"):
        parts.append(f";避免『{avoided['label']}』")
    return {
        "stage": "detail",
        "instruction": "".join(parts),
        "fields": sorted(pref_fields.keys()),
    }


def _build_workflow(
    prefer_intent_codes: list[str],
    shot_count: int | None,
    sequence_pattern: str | None,
    detail_steps: list[dict[str, Any]],
    review_checks: list[str],
) -> list[dict[str, Any]]:
    """Assemble ordered workflow steps mirroring the generation pipeline
    (strategy → plan → detail → review)."""
    steps: list[dict[str, Any]] = []
    if prefer_intent_codes:
        steps.append(
            {
                "stage": "strategy",
                "instruction": (
                    f"优先发展服务意图 {prefer_intent_codes} 的机制方向;"
                    "只调整方向顺序,不删除任何备选方向"
                ),
                "fields": [],
            }
        )
    plan_bits = []
    if shot_count:
        plan_bits.append(f"镜头数倾向约 {shot_count} 镜")
    if sequence_pattern:
        plan_bits.append(f"序列结构倾向:{sequence_pattern}")
    if plan_bits:
        steps.append({"stage": "plan", "instruction": ";".join(plan_bits), "fields": []})
    steps.extend(detail_steps)
    if review_checks:
        steps.append(
            {
                "stage": "review",
                "instruction": "自查(软性,不覆盖意图/本体/耦合):" + " / ".join(review_checks),
                "fields": [],
            }
        )
    return steps


def select_examples(
    exemplar_records: list[dict[str, Any]],
    prefer: dict[str, str],
    limit: int = 2,
) -> list[dict[str, Any]]:
    """Pick up to *limit* shots from the user's own adopted exemplars that
    embody the preferred field values (few-shot for the presentation layer).

    Pure function: records are pre-fetched by the caller. A shot qualifies if
    it carries at least one preferred value; shots matching more preferred
    fields rank first. Shot payloads are whitelisted to the ten parameters
    plus ``serves`` (examples are illustration, never guidance-bearing).
    """
    if not exemplar_records or not prefer:
        return []
    scored: list[tuple[int, dict[str, Any]]] = []
    for rec in exemplar_records:
        shots = (rec.get("shot_script") or {}).get("shots") or []
        for shot in shots:
            matched = [f for f, v in prefer.items() if str(shot.get(f)) == v]
            if not matched:
                continue
            compact = {f: shot.get(f) for f in _TEN if shot.get(f) is not None}
            if shot.get("serves"):
                compact["serves"] = shot["serves"]
            scored.append(
                (
                    len(matched),
                    {
                        "source": str(rec.get("record_id", "")),
                        "shot": compact,
                        "note": "体现偏好:" + " · ".join(
                            f"{f}={prefer[f]}" for f in sorted(matched)
                        ),
                    },
                )
            )
    scored.sort(key=lambda t: -t[0])
    return [e for _, e in scored[:limit]]


def _agreeing_count(question: dict[str, Any]) -> int:
    from app.evolution.questions import _session_answers

    p = prevailing_answer(question.get("answers") or [])
    votes = _session_answers(question.get("answers") or [])
    return sum(1 for v in votes.values() if v == p)


def _dedup(seq: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for x in seq:
        if x:
            seen.setdefault(x, None)
    return list(seen.keys())


# ---------------------------------------------------------------------------
# Consumption helpers (pure) — used by the fixed graph nodes
# ---------------------------------------------------------------------------


def reorder_directions(directions: list[dict], skill: dict | None) -> list[dict]:
    """Stable-sort directions so skill-preferred ones lead (ADR-0017 §6).

    Set invariant: the returned set of directions equals the input set — a
    skill may reorder but never remove or add a direction.
    """
    if not skill or len(directions) < 2:
        return directions
    prefer = set(skill.get("strategy", {}).get("prefer_intent_codes") or [])
    if not prefer:
        return directions

    def matches(d: dict) -> int:
        dom = set(d.get("dominant_intents") or [])
        hay = f"{d.get('name', '')} {d.get('mechanism', '')} {d.get('core_technique', '')}"
        if dom & prefer:
            return 0
        if any(code in hay for code in prefer):
            return 0
        return 1

    return sorted(directions, key=matches)


def preferred_values(skill: dict | None) -> dict[str, str]:
    """Flatten a skill's detail.prefer into {field: preferred_value} (ADR-0017).

    Used for per-stage outcome detection: an edit away from a preferred value
    is a ``user_overridden`` cue; an adopted script carrying it is ``consumed``.
    """
    if not skill:
        return {}
    out: dict[str, str] = {}
    for rule in skill.get("detail", {}).get("prefer", []):
        values = rule.get("values") or []
        if rule.get("field") and values:
            out[rule["field"]] = str(values[0])
    return out


def evaluate_skill_adoption(skill: dict | None, shots: list[dict]) -> dict[str, list[str]]:
    """At adoption, judge each preferred field against the final script.

    ``consumed``: some shot carries the preferred value; ``ignored``: no shot
    does (the guidance did not survive generation/editing). These outcomes are
    discovery cues for the next reflection — they never certify a preference
    by themselves (ADR-0017 §6).
    """
    prefs = preferred_values(skill)
    consumed: list[str] = []
    ignored: list[str] = []
    for field, value in prefs.items():
        if any(str(s.get(field)) == value for s in shots or []):
            consumed.append(field)
        else:
            ignored.append(field)
    return {"consumed": consumed, "ignored": ignored}


def skill_prompt_section(skill: dict | None) -> str:
    """Render an active skill into a generate-prompt block (ADR-0018).

    Presentation layer first: workflow reasoning-chain steps (plan/detail
    stages — strategy is consumed by direction reordering, review by the
    critic), then few-shot examples from the user's own adopted work, then the
    iron law. Falls back to flat prefer/avoid lines when the skill predates
    the two-layer structure.
    """
    if not skill:
        return ""
    lines: list[str] = []

    # workflow steps (plan + detail stages carry the reasoning chain)
    for step in skill.get("workflow") or []:
        if step.get("stage") in ("plan", "detail") and step.get("instruction"):
            lines.append(f"- {step['instruction']}")

    # fallback for skills without a workflow layer: flat validation-layer lines
    if not lines:
        plan = skill.get("plan") or {}
        if plan.get("shot_count"):
            lines.append(f"- 镜头数倾向:约 {plan['shot_count']} 镜")
        if plan.get("sequence_pattern"):
            lines.append(f"- 序列结构倾向:{plan['sequence_pattern']}")
        for rule in skill.get("detail", {}).get("prefer", []):
            lines.append(f"- 倾向 {rule['field']}: {'/'.join(rule['values'])}")
        for rule in skill.get("detail", {}).get("avoid", []):
            lines.append(f"- 避免 {rule['field']}: {'/'.join(rule['values'])}")

    if not lines:
        return ""

    section = "\n\n## 个人 workflow skill(已确证偏好,软性指导)\n" + "\n".join(lines)

    examples = skill.get("examples") or []
    if examples:
        section += "\n\n该用户过往采纳方案中的实例(few-shot 参考,模仿其取舍而非照抄):"
        for ex in examples[:2]:
            shot = ex.get("shot") or {}
            params = " · ".join(f"{k}={v}" for k, v in shot.items() if k != "serves")
            section += f"\n- {params}({ex.get('note', '')})"

    section += (
        "\n应用纪律(铁律:意图忠实 > 偏好惯性):偏好只在满足当前意图前提下取舍;"
        "与 brief / 本体 / serves / 参数耦合冲突时忽略对应字段;受影响镜头仍须声明 serves。"
    )
    return section
