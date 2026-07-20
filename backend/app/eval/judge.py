"""Agent-as-judge scoring, with the protections such judges need.

Five safeguards, matching the paper's judging protocol:
1. blinding + seeded side randomization (``metrics.assign_sides``), with each
   trial optionally re-run in both orders and averaged;
2. a judge model distinct from the generator (``EVAL_JUDGE_MODEL``);
3. no leakage: the judge sees the persona profile and the confirmed brief, never
   the ledger, the enacted skill, or any condition marker — and guardrail
   judgments withhold the profile too, so taste cannot leak into fidelity;
4. every verdict must cite shots/parameters as evidence, else it is discarded;
5. calibration controls (mismatched memory, human subsample) driven by the
   harness, which simply feeds this module different pairs.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from app.eval.metrics import assign_sides, decode_verdict
from app.graph.utils import parse_llm_json
from app.llm.client import LLMClient, LLMSettings, get_llm_settings

logger = logging.getLogger(__name__)


def get_judge_client() -> LLMClient:
    """A judge from a different model family than the generator (safeguard 2).

    Falls back to the main model with a loud warning: results from a
    self-judging run are reported as such, never silently.
    """
    s = get_llm_settings()
    model = os.environ.get("EVAL_JUDGE_MODEL", "").strip()
    if not model:
        logger.warning(
            "EVAL_JUDGE_MODEL unset — judging with the generator model (%s). "
            "Self-enhancement bias applies; report this run as self-judged.",
            s.llm_model,
        )
        return LLMClient()
    judge_settings = LLMSettings(
        llm_api_key=os.environ.get("EVAL_JUDGE_API_KEY") or s.llm_api_key,
        llm_base_url=os.environ.get("EVAL_JUDGE_BASE_URL") or s.llm_base_url,
        llm_model=model,
        llm_api_style="chat_completions",
    )
    return LLMClient(judge_settings)


def _compact(script: dict[str, Any]) -> dict[str, Any]:
    """Strip a script to what the judge should see: shots + their parameters.

    Rationale text is kept (it carries the reasoning under review) but ids,
    provenance, render URLs and any memory artefact are dropped so nothing
    reveals the condition (safeguard 3).
    """
    from app.ontology import TEN_PARAMS

    shots = []
    for s in script.get("shots") or []:
        shot = {f: s.get(f) for f in TEN_PARAMS if s.get(f) is not None}
        shot["order"] = s.get("order")
        if s.get("serves"):
            shot["serves"] = s["serves"]
        if s.get("rationale"):
            shot["rationale"] = s["rationale"]
        shots.append(shot)
    return {"strategy": script.get("strategy"), "shots": shots,
            "overall_rationale": script.get("overall_rationale")}


# ---------------------------------------------------------------------------
# Primary: pairwise taste alignment
# ---------------------------------------------------------------------------


async def judge_pairwise(
    persona_profile: str,
    brief: str,
    script_a: dict[str, Any],
    script_b: dict[str, Any],
    seed: int,
    both_orders: bool = True,
) -> dict[str, Any]:
    """Which script better matches the persona's held-out taste?

    Returns the decoded verdict ('A' | 'B' | 'tie') plus evidence. With
    ``both_orders`` the trial runs twice with sides swapped and disagreement
    collapses to a tie — position bias cancels instead of accumulating.
    """
    first = await _one_pairwise(persona_profile, brief, script_a, script_b, seed)
    if not both_orders:
        return first
    second = await _one_pairwise(persona_profile, brief, script_a, script_b, seed + 1)
    if first["verdict"] == second["verdict"]:
        return {**first, "order_consistent": True,
                "evidence": [first.get("evidence"), second.get("evidence")]}
    # judge flipped with the presentation order → no reliable preference
    return {"verdict": "tie", "order_consistent": False,
            "evidence": [first.get("evidence"), second.get("evidence")]}


async def _one_pairwise(
    persona_profile: str, brief: str,
    script_a: dict[str, Any], script_b: dict[str, Any], seed: int,
) -> dict[str, Any]:
    payload, mapping = assign_sides(_compact(script_a), _compact(script_b), seed)
    system = (
        "You judge which of two shot scripts better matches a specific creator's "
        "cinematic taste. You are given that creator's taste profile as ground truth.\n\n"
        "Rules:\n"
        "- Judge ONLY taste match, not general quality: a more polished script that "
        "contradicts the profile loses to a plainer one that follows it.\n"
        "- Both scripts serve the same brief; ignore differences that the profile "
        "does not speak to.\n"
        "- You MUST cite concrete shots and parameter values as evidence. A verdict "
        "without citations is invalid.\n"
        "- Answer 'tie' only when neither script is closer on any profile entry.\n\n"
        'Output JSON: {"verdict": "X" | "Y" | "tie", '
        '"evidence": "cite shot numbers and parameter values", '
        '"profile_entries_used": ["..."]}'
    )
    user = (
        f"## Creator's taste profile (ground truth)\n{persona_profile}\n\n"
        f"## The brief both scripts serve\n{brief}\n\n"
        f"## Script X\n{payload['X']}\n\n"
        f"## Script Y\n{payload['Y']}"
    )
    try:
        raw = await get_judge_client().chat(system, user, temperature=0.0)
        data = parse_llm_json(raw, fallback={}, log_name="judge-pairwise")
    except Exception:
        logger.warning("Pairwise judging failed; recording as tie", exc_info=True)
        return {"verdict": "tie", "evidence": None, "invalid": True}
    evidence = (data.get("evidence") or "").strip()
    if not evidence:  # safeguard 4: uncited verdicts are discarded
        return {"verdict": "tie", "evidence": None, "invalid": True}
    return {"verdict": decode_verdict(data.get("verdict", ""), mapping),
            "evidence": evidence,
            "profile_entries_used": data.get("profile_entries_used") or []}


# ---------------------------------------------------------------------------
# Guardrails: scored per script, profile withheld
# ---------------------------------------------------------------------------


async def judge_guardrails(brief: str, tags: list[str], script: dict[str, Any]) -> dict[str, Any]:
    """Rate intent fidelity and craft coherence on a single script (1-5).

    The persona profile is deliberately NOT passed: these axes must not be
    contaminated by taste, or a "personalized" script could score well on
    fidelity merely by matching the creator.
    """
    system = (
        "You review a cinematic shot script for two independent qualities.\n\n"
        "1. intent_fidelity (1-5): does the script realize the stated brief and its "
        "intent labels? Count as violations any shot serving no stated intent, or "
        "contradicting the brief.\n"
        "2. craft_coherence (1-5): are the ten camera parameters mutually consistent "
        "and cinematically sound (spatial: shot size/focal/depth/composition/angle; "
        "temporal: movement/rhythm/duration; tonal: lighting/color)?\n\n"
        "Judge the script on its own terms. You are NOT told the creator's personal "
        "taste and must not speculate about it.\n\n"
        'Output JSON: {"intent_fidelity": 1-5, "fidelity_violations": 0, '
        '"craft_coherence": 1-5, "evidence": "cite shots and parameters"}'
    )
    user = (
        f"## Brief\n{brief}\n\n## Confirmed intent labels\n{tags}\n\n"
        f"## Script\n{_compact(script)}"
    )
    try:
        raw = await get_judge_client().chat(system, user, temperature=0.0)
        data = parse_llm_json(raw, fallback={}, log_name="judge-guardrail")
    except Exception:
        logger.warning("Guardrail judging failed", exc_info=True)
        return {}
    return {
        "intent_fidelity": _clamp(data.get("intent_fidelity")),
        "fidelity_violations": data.get("fidelity_violations"),
        "craft_coherence": _clamp(data.get("craft_coherence")),
        "evidence": data.get("evidence"),
    }


async def judge_diversity(directions: list[dict[str, Any]]) -> dict[str, Any]:
    """Rate whether the candidate directions remain mechanism-distinct (1-5).

    Tests the invariant that a skill reorders but never collapses the menu;
    the harness pairs this with a deterministic set-equality check.
    """
    system = (
        "You assess whether a set of cinematic directions are genuinely distinct in "
        "MECHANISM (how the effect is produced: information asymmetry, temporal "
        "suspension, spatial confinement, subjective alignment, ...) rather than in "
        "wording or surface styling.\n\n"
        'Output JSON: {"diversity": 1-5, "distinct_mechanisms": ["..."], '
        '"evidence": "why they are or are not distinct"}'
    )
    user = f"## Candidate directions\n{directions}"
    try:
        raw = await get_judge_client().chat(system, user, temperature=0.0)
        data = parse_llm_json(raw, fallback={}, log_name="judge-diversity")
    except Exception:
        logger.warning("Diversity judging failed", exc_info=True)
        return {}
    return {"diversity": _clamp(data.get("diversity")),
            "distinct_mechanisms": data.get("distinct_mechanisms") or [],
            "evidence": data.get("evidence")}


def _clamp(v: Any) -> float | None:
    try:
        return max(1.0, min(5.0, float(v)))
    except (TypeError, ValueError):
        return None
