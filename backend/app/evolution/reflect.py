"""Reflection pipeline (ADR-0017).

Runs asynchronously after a session ends. It turns the interaction trace into
candidate preference questions ``q = (c, d, a, b)`` and, on *recurrence*, lets
behaviour advance a question's status.

Steps:
1. Deterministic preprocessing (``build_evidence_digest``): net edits,
   perceptual verdicts, candidate comparisons. Pure and unit-testable.
2. LLM proposes preference questions grounded in the design space (or matches
   existing ones by id).
3. A *first* sighting is inserted at status ``observed`` (a hypothesis, no
   vote). A *match* — the same decision recurring in a later session — casts a
   behavioural vote for the side this session leaned to, which advances the
   question just like a probe answer (ADR-0017: behaviour proposes, and its
   recurrence corroborates; an explicit probe still settles and outweighs it).
   Recurring behaviour therefore consolidates onto one question instead of
   minting duplicate ``observed`` copies.

Non-critical (flywheel semantics): any failure is logged, never raised.
"""

from __future__ import annotations

import logging
from typing import Any

from app.evolution.questions import (
    create_question,
    get_questions_for_user,
    record_answer,
)
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
            # 去重:采纳流程会两次经过 /select(edit → writeback),同一选择只算一次表态
            if not any(
                c.get("selected", {}).get("id") == selected_id for c in comparisons
            ):
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

    # The *driving* intents: dominant_intents of the directions the user chose.
    # A preference discovered from a choice belongs to what that direction was
    # about, not to an arbitrary session tag — so scope questions to these.
    dominant: list[str] = []
    for c in comparisons:
        dominant += (c.get("selected") or {}).get("dominant_intents") or []
    dominant = list(dict.fromkeys(dominant))  # dedup, preserve order

    return {
        "session_id": session_id,
        "tags": tags,
        "dominant_intents": dominant,
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
    import os
    import time

    t0 = time.perf_counter()
    try:
        await _reflect_session_inner(session_id)
    except Exception:
        logger.warning("Reflection failed for session %s (non-critical)", session_id,
                       exc_info=True)
    finally:
        if os.environ.get("STAGE_TIMING") == "1":
            logging.getLogger("stage_timing").info(
                "STAGE reflect %.2f sid=%s", time.perf_counter() - t0, session_id)


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
        result = await client.chat(system, user, enable_thinking=False)
        data = parse_llm_json(result, fallback={}, log_name="reflect")
    except Exception:
        logger.warning("Reflection LLM call failed for %s", session_id, exc_info=True)
        return

    # Per-session discovery brake: reflection tends to over-produce, so cap how
    # many *new* questions one session may mint (default 1). Recurrence no longer
    # needs a probe to advance a question (behavioural votes do), so runaway
    # discovery is self-correcting — a recurring decision matches and votes
    # rather than minting a duplicate ``observed``.
    import os

    max_new = int(os.environ.get("REFLECT_MAX_NEW_QUESTIONS", "1"))
    revoked_ids = {q["question_id"] for q in existing if q["user_flag"] == "revoked"}
    created = 0
    existing_ids = {q["question_id"] for q in existing}
    for q in data.get("questions") or []:
        match_id = q.get("match_question_id")
        if match_id:
            # Recurrence: the same decision seen again casts a behavioural vote
            # for the side this session leaned to, advancing the question just
            # like a probe (record_answer leaves an explicit vote untouched).
            if match_id in revoked_ids or match_id not in existing_ids:
                logger.info("Reflection: skipping match %s (revoked/unknown)", match_id)
                continue
            side = str(q.get("match_answer") or "").strip().lower()
            if side not in ("a", "b", "open"):
                logger.info("Reflection: match %s without a side, no vote", match_id)
                continue
            try:
                new_status = await record_answer(
                    session_id, match_id, side, source="behavior"
                )
                logger.info("Reflection: behavioural vote %s on %s → %s",
                            side, match_id, new_status)
            except Exception:
                logger.warning("Reflection: behavioural vote failed for %s",
                               match_id, exc_info=True)
            continue
        if created >= max_new:
            break
        decision = (q.get("decision") or "").strip()
        alt_a, alt_b = q.get("alt_a"), q.get("alt_b")
        if not decision or not isinstance(alt_a, dict) or not isinstance(alt_b, dict):
            continue
        scope_type = q.get("scope_type") or "intent_leaf"
        if scope_type not in ("intent_leaf", "mechanism", "global"):
            scope_type = "intent_leaf"
        scope_id = q.get("scope_id")
        # Scope attribution guard: an intent_leaf preference must belong to an
        # intent the *chosen* direction actually served (digest.dominant_intents).
        # If the LLM scoped it to an unrelated session tag, record it as a
        # cross-context (global) preference rather than mis-filing it under a
        # leaf where it will never be recalled or credited.
        dominant = digest.get("dominant_intents") or []
        if scope_type == "intent_leaf" and dominant and scope_id not in dominant:
            logger.info("Reflection: scope %s not in driving intents %s → global",
                        scope_id, dominant)
            scope_type, scope_id = "global", None
        qid = await create_question(
            user_id=user_id,
            scope_type=scope_type,
            scope_id=scope_id,
            decision=decision,
            alt_a=alt_a,
            alt_b=alt_b,
            # Recall context = the driving intents (not all session tags), so a
            # later same-intent session recalls it precisely.
            context_tags=dominant or digest.get("tags") or [],
        )
        created += 1
        logger.info("Reflection: discovered question %s scope=%s/%s (%s)",
                    qid, scope_type, scope_id, decision[:40])
