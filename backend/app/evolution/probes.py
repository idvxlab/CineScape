"""Memory probes (ADR-0017 §1.4, §3.3).

At most one probe per session, chosen by fair round-robin (never score-driven).
Two probe kinds share the single slot:

- **Verification probe**: for the highest-priority not-yet-corroborated
  applicable question, ask ``a`` vs ``b`` vs *leave open*. The a/b options are
  reordered across probes to cancel position bias. The answer settles the
  question (once the final brief confirms it applies).
- **Skill-activation probe**: if corroborated applicable questions exist, offer
  the enacted skill for the user to *apply / leave aside / stop remembering*.

Skill activation takes precedence when available (a settled preference is more
valuable to apply than one more verification). Everything here is pure except
the DB recall.
"""

from __future__ import annotations

import logging
from typing import Any

from app.evolution.questions import (
    STATUS_CORROBORATED,
    get_recallable_for_scopes,
)
from app.evolution.skills import enact

logger = logging.getLogger(__name__)

# Verification-probe answers.
PROBE_A = "a"
PROBE_B = "b"
PROBE_OPEN = "open"

# Skill-activation answers.
ACT_APPLY = "apply"
ACT_LEAVE = "leave"
ACT_FORGET = "forget"


async def recall_questions(
    user_id: str,
    tags: list[str],
    mechanisms: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Recall in-scope, non-revoked questions (fairly ordered). Best-effort."""
    if user_id == "anonymous" or not user_id:
        return []
    try:
        return await get_recallable_for_scopes(user_id, tags or [], mechanisms or [])
    except Exception:
        logger.debug("Question recall unavailable, proceeding without", exc_info=True)
        return []


def build_verification_probe(question: dict[str, Any], swap: bool = False) -> dict[str, Any]:
    """Shape a not-yet-corroborated question into an a/b/open probe widget.

    ``swap`` reorders the first two options to cancel position bias; the answer
    value is kept in question-frame (``a``/``b``) regardless of display order.
    """
    alt_a = question.get("alt_a") or {}
    alt_b = question.get("alt_b") or {}
    opt_a = {"value": PROBE_A, "label": alt_a.get("label", "Option A")}
    opt_b = {"value": PROBE_B, "label": alt_b.get("label", "Option B")}
    first_two = [opt_b, opt_a] if swap else [opt_a, opt_b]
    return {
        "kind": "preference_probe",
        "question_id": question["question_id"],
        "prompt": (
            f"About \u201c{question.get('decision', 'this choice')}\u201d \u2014 "
            "which do you usually prefer?"
        ),
        "options": first_two + [{"value": PROBE_OPEN, "label": "Either \u2014 let the system decide"}],
    }


def build_activation_probe(skill: dict[str, Any], question_ids: list[str]) -> dict[str, Any]:
    """Shape an enacted skill into an apply/leave/forget activation widget."""
    n = len(skill.get("source_question_ids") or question_ids)
    return {
        "kind": "skill_activation",
        "question_ids": question_ids,
        "prompt": (
            f"I remember {n} confirmed preference{'s' if n != 1 else ''} of yours for "
            "similar scenes. Develop this plan with them?"
        ),
        "options": [
            {"value": ACT_APPLY, "label": "Apply my preferences"},
            {"value": ACT_LEAVE, "label": "Not this time"},
            {"value": ACT_FORGET, "label": "Stop remembering these"},
        ],
    }


def select_probe(
    recalled: list[dict[str, Any]],
    already_probed: bool,
    swap: bool = False,
) -> dict[str, Any] | None:
    """Pick at most one probe for this session (ADR-0017 §1.4).

    Precedence: if any corroborated applicable questions exist, offer a
    skill-activation probe over the enacted skill; otherwise verify the
    fairest not-yet-corroborated question. ``recalled`` is assumed already
    fairly ordered by ``get_recallable_for_scopes``.
    """
    if already_probed or not recalled:
        return None

    corroborated = [q for q in recalled if q.get("status") == STATUS_CORROBORATED]
    if corroborated:
        skill = enact(corroborated)
        if skill is not None:
            return build_activation_probe(skill, [q["question_id"] for q in corroborated])

    for q in recalled:
        if q.get("status") != STATUS_CORROBORATED:
            return build_verification_probe(q, swap=swap)
    return None
