"""Reflection pipeline (ADR-0017).

Runs asynchronously after a session ends. Its job is *discovery*, not
adjudication: it turns the interaction trace into candidate preference
questions ``q = (c, d, a, b)`` but never changes a question's status. Only
explicit probe answers (via ``questions.record_answer``) settle a question.

Steps:
1. Deterministic preprocessing (``build_evidence_digest``): net edits,
   perceptual verdicts, candidate comparisons. Pure and unit-testable.
2. LLM proposes preference questions grounded in the design space (or matches
   existing ones by id).
3. New questions are inserted at status ``observed``; matches are left
   untouched (behaviour proposes, probes settle).

Non-critical (flywheel semantics): any failure is logged, never raised.
"""

from __future__ import annotations

import logging
from typing import Any

from app.evolution.questions import create_question, get_questions_for_user
from app.evolution.trace import load_session_trace
from app.llm import PromptBuilder, get_llm_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Step 1 — deterministic preprocessing (pure, testable)
# ---------------------------------------------------------------------------


def build_evidence_digest(trace: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn a raw event trace into a structured digest of *discovery cues*.

    These cues only help the reflection agent propose questions; they never
    settle one. Derives, without any LLM:
    - ``comparisons``: which mechanism direction was chosen over which.
    - ``perceptual_verdicts``: per (shot, field), kept vs reverted after render.
    - ``net_edits``: the net from→to per (shot, field).
    - ``tags`` / ``brief``: the aligned intent (from candidate_select/adopt).
    """
    comparisons: list[dict[str, Any]] = []
    tags: list[str] = []
    brief: str = ""
    session_id: str = ""

    edit_events: list[dict[str, Any]] = []
    render_seqs: list[int] = []

    for i, ev in enumerate(trace or []):
        et = ev.get("event_type")
        p = ev.get("payload") or {}
        if not session_id:
            session_id = ev.get("session_id") or p.get("session_id") or ""

        if et == "candidate_select":
            dirs = {d.get("id"): d for d in p.get("directions") or []}
            selected_id = p.get("selected")
            rejected_ids = p.get("rejected") or [k for k in dirs if k != selected_id]
            comparisons.append(
                {
                    "selected": dirs.get(selected_id, {"id": selected_id}),
                    "rejected": [dirs.get(r, {"id": r}) for r in rejected_ids],
                }
            )
            tags = p.get("tags") or tags
            brief = p.get("brief") or brief

        elif et == "edit_patch":
            for op in p.get("ops") or []:
                edit_events.append(
                    {
                        "seq": i,
                        "shot_order": op.get("shot_order"),
                        "field": op.get("field"),
                        "from": op.get("from"),
                        "to": op.get("to"),
                    }
                )

        elif et == "render_request":
            render_seqs.append(i)

        elif et == "adopt":
            tags = p.get("tags") or tags
            brief = p.get("brief") or brief

    net: dict[tuple[int, str], dict[str, Any]] = {}
    for e in edit_events:
        key = (e["shot_order"], e["field"])
        if key not in net:
            net[key] = {"shot_order": e["shot_order"], "field": e["field"], "from": e["from"]}
        net[key]["to"] = e["to"]

    perceptual_verdicts = []
    for key, info in net.items():
        edits_seq = [e["seq"] for e in edit_events if (e["shot_order"], e["field"]) == key]
        first_edit = min(edits_seq)
        covering_renders = [r for r in render_seqs if r > first_edit]
        if not covering_renders:
            continue
        last_render = max(covering_renders)
        reverted = any(s > last_render for s in edits_seq)
        perceptual_verdicts.append(
            {
                "shot_order": key[0],
                "field": key[1],
                "verdict": "reverted" if reverted else "kept",
                "to": info.get("to"),
            }
        )

    return {
        "session_id": session_id,
        "tags": tags,
        "brief": brief,
        "comparisons": comparisons,
        "net_edits": list(net.values()),
        "perceptual_verdicts": perceptual_verdicts,
        "has_edits": bool(edit_events),
        "has_renders": bool(render_seqs),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def reflect_session(session_id: str) -> None:
    """Discover candidate preference questions from a session. Never raises."""
    try:
        await _reflect_session_inner(session_id)
    except Exception:
        logger.warning("Reflection failed for session %s (non-critical)", session_id,
                       exc_info=True)


async def _reflect_session_inner(session_id: str) -> None:
    trace = await load_session_trace(session_id)
    if not trace:
        logger.info("Reflection: empty trace for %s, skipping", session_id)
        return

    user_id = next((ev.get("user_id") for ev in trace if ev.get("user_id")), "anonymous")
    if user_id == "anonymous":
        logger.info("Reflection: anonymous session %s, skipping personalization", session_id)
        return

    digest = build_evidence_digest(trace)
    if not digest["comparisons"] and not digest["has_edits"]:
        logger.info("Reflection: no discovery cues for %s", session_id)
        return

    existing = await get_questions_for_user(user_id, include_revoked=True)
    # Compact existing questions for the prompt (id + context + decision only).
    existing_summ = [
        {
            "question_id": q["question_id"],
            "scope_type": q["scope_type"],
            "scope_id": q["scope_id"],
            "decision": q["decision"],
            "revoked": q["user_flag"] == "revoked",
        }
        for q in existing
    ]

    # Lazy import avoids an app.evolution → app.graph import cycle at module load.
    from app.graph.utils import parse_llm_json

    client = get_llm_client()
    builder = PromptBuilder()
    system, user = builder.discover_questions(digest, existing_summ)
    try:
        result = await client.chat(system, user)
        data = parse_llm_json(result, fallback={}, log_name="reflect")
    except Exception:
        logger.warning("Reflection LLM call failed for %s", session_id, exc_info=True)
        return

    revoked_ids = {q["question_id"] for q in existing if q["user_flag"] == "revoked"}
    for q in data.get("questions") or []:
        match_id = q.get("match_question_id")
        if match_id:
            # Behaviour proposes but never settles; a matched question is left
            # untouched (its status changes only through probe answers).
            if match_id in revoked_ids:
                logger.info("Reflection: skipping revoked question %s", match_id)
            continue
        decision = (q.get("decision") or "").strip()
        alt_a, alt_b = q.get("alt_a"), q.get("alt_b")
        if not decision or not isinstance(alt_a, dict) or not isinstance(alt_b, dict):
            continue
        scope_type = q.get("scope_type") or "intent_leaf"
        if scope_type not in ("intent_leaf", "mechanism", "global"):
            scope_type = "intent_leaf"
        qid = await create_question(
            user_id=user_id,
            scope_type=scope_type,
            scope_id=q.get("scope_id"),
            decision=decision,
            alt_a=alt_a,
            alt_b=alt_b,
        )
        logger.info("Reflection: discovered question %s (%s)", qid, decision[:40])
