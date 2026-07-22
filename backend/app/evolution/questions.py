"""Preference-question store + prevailing-answer state machine (ADR-0017).

The unit of memory is a *preference question* ``q = (c, d, a, b)``: a recurring
context ``c`` (scope), a cinematic decision axis ``d``, and two design-space
executable alternatives ``a``/``b``. Ordinary behaviour only *proposes*
questions (see ``reflect``); only explicit probe answers *settle* them.

A question's status is a deterministic function of its answer history, via the
*prevailing answer* (mode across distinct sessions). There are no scores,
weights, or evidence guards — this is the core ADR-0017 departure from the
ADR-0015 hypothesis/evidence machine.

This module has two halves:
1. **Pure functions** (``prevailing_answer``, ``compute_status``,
   ``fair_order_key``) — no I/O, exhaustively unit-testable.
2. **Async CRUD** over ``preference_questions``.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from typing import Any

from app.db import get_pool

logger = logging.getLogger(__name__)

# Answer vocabulary. "open" == the ternary indifference a∼b (no stable pref).
ANSWER_A = "a"
ANSWER_B = "b"
ANSWER_OPEN = "open"
VALID_ANSWERS = {ANSWER_A, ANSWER_B, ANSWER_OPEN}

STATUS_OBSERVED = "observed"
STATUS_TENTATIVE = "tentative"
STATUS_CORROBORATED = "corroborated"

# Statuses eligible to be recalled + probed in a new session.
RECALLABLE = {STATUS_OBSERVED, STATUS_TENTATIVE, STATUS_CORROBORATED}


# ---------------------------------------------------------------------------
# Pure state machine — the single source of truth
# ---------------------------------------------------------------------------


def _session_answers(answers: list[dict[str, Any]]) -> dict[str, str]:
    """Collapse the answer log to one answer per session (last write wins).

    A user's repeated answers within one session are not independent
    observations (ADR-0017 §1.3), so each session contributes a single vote.
    """
    per_session: dict[str, str] = {}
    for item in answers or []:
        sid = item.get("session_id")
        ans = item.get("answer")
        if sid and ans in VALID_ANSWERS:
            per_session[sid] = ans  # last within a session wins
    return per_session


def prevailing_answer(answers: list[dict[str, Any]]) -> str | None:
    """The strict mode over per-session votes, or None if tied/empty.

    A tie leaves the question unsettled (ADR-0017 §1.3). ``open`` votes count
    like any other and can themselves prevail (a corroborated indifference).
    """
    votes = _session_answers(answers)
    if not votes:
        return None
    counts = Counter(votes.values())
    top = counts.most_common()
    if len(top) >= 2 and top[0][1] == top[1][1]:
        return None  # tie → unsettled
    return top[0][0]


def merge_vote(
    answers: list[dict[str, Any]], session_id: str, answer: str, source: str
) -> tuple[list[dict[str, Any]], bool]:
    """Pure vote-merge (ADR-0017). Returns ``(new_answers, changed)``.

    ``probe`` (explicit) overwrites this session's prior vote; ``behavior``
    (recurrence) only adds when the session has no vote yet — an explicit or
    earlier behavioural vote for the same session is left standing, so behaviour
    accrues evidence but never overrules a settled answer. ``source`` is stored
    on each vote so both weigh equally in ``compute_status`` yet stay auditable.
    """
    if source == "behavior" and any(a.get("session_id") == session_id for a in answers):
        return list(answers), False
    kept = [a for a in answers if a.get("session_id") != session_id]
    kept.append({"session_id": session_id, "answer": answer, "source": source})
    return kept, True


def compute_status(answers: list[dict[str, Any]]) -> str:
    """Derive status purely from the answer history (ADR-0017 §1.3).

    observed  — no answers, or the prevailing answer is a tie (unsettled);
    tentative — a settled prevailing answer agreed by exactly one session;
    corroborated — a settled prevailing answer agreed by >= 2 distinct sessions.

    Disagreement that flips or ties the mode automatically *reopens* the
    question (drops it back), because status is recomputed, never ratcheted.
    """
    prevailing = prevailing_answer(answers)
    if prevailing is None:
        return STATUS_OBSERVED
    votes = _session_answers(answers)
    agreeing = sum(1 for v in votes.values() if v == prevailing)
    if agreeing >= 2:
        return STATUS_CORROBORATED
    return STATUS_TENTATIVE


def fair_order_key(question: dict[str, Any]) -> tuple:
    """Sort key for fair round-robin probe selection (ADR-0017 §1.4).

    Priority (ascending sort → smaller first):
    1. *finish what's under way*: a question with at least one answer but not yet
       corroborated (``tentative``) is probed before a brand-new ``observed`` one,
       which is probed before an already ``corroborated`` one.
    2. within a tier, closest-to-corroboration first (most answering sessions);
    3. then least-recently re-examined (oldest ``last_probed_at``).
    ``emphasized`` questions are pulled forward across tiers; ``revoked``
    questions must be filtered out *before* sorting (never probed).

    Rationale — this replaces a plain "unverified before verified" rule. Under
    ongoing (asynchronous) discovery, always probing the newest observed question
    means the one-probe-per-session budget never returns to give any question its
    second answer, so nothing ever corroborates. Draining tentatives first closes
    that gap: a question probed in session N is re-probed in N+1 and corroborates,
    independent of how many observed questions discovery has piled up.
    """
    status = question.get("status") or compute_status(question.get("answers") or [])
    status_rank = {STATUS_TENTATIVE: 0, STATUS_OBSERVED: 1}.get(status, 2)
    emphasized = 0 if question.get("user_flag") == "emphasized" else 1
    n_sessions = len(_session_answers(question.get("answers") or []))
    # Closer-to-corroboration first within a tier (more answering sessions).
    # Inert for observed (always 0); for corroborated, skill activation — not this
    # ordering — governs, so the tie-breaks below only affect verification order.
    last = question.get("last_probed_at") or ""  # empty sorts first (never probed)
    return (emphasized, status_rank, -n_sessions, str(last))


# ---------------------------------------------------------------------------
# Async CRUD
# ---------------------------------------------------------------------------


async def create_question(
    user_id: str,
    scope_type: str,
    scope_id: str | None,
    decision: str,
    alt_a: dict[str, Any],
    alt_b: dict[str, Any],
    context_tags: list[str] | None = None,
) -> str:
    """Insert a newly discovered preference question (status observed).

    ``context_tags`` are the discovery session's confirmed intent tags. Recall
    matches on *overlap* with a later session's tags rather than exact scope
    equality, because same-theme sessions produce overlapping-but-not-identical
    tag sets (ADR-0017: the "recurring context" is a set, not a single leaf).
    """
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO preference_questions
                (user_id, scope_type, scope_id, decision, alt_a, alt_b,
                 context_tags, status)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, 'observed')
            RETURNING question_id
            """,
            (
                user_id,
                scope_type,
                scope_id,
                decision,
                json.dumps(alt_a, ensure_ascii=False),
                json.dumps(alt_b, ensure_ascii=False),
                context_tags or [],
            ),
        )
        row = await cursor.fetchone()
        return str(row[0])


async def get_questions_for_user(
    user_id: str,
    include_revoked: bool = False,
) -> list[dict[str, Any]]:
    """Fetch all of a user's questions (optionally including revoked ones)."""
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT question_id, scope_type, scope_id, decision, alt_a, alt_b,
                   answers, status, user_flag, last_probed_at, created_at, updated_at,
                   context_tags
            FROM preference_questions
            WHERE user_id = %s AND (%s OR user_flag <> 'revoked')
            ORDER BY updated_at DESC
            """,
            (user_id, include_revoked),
        )
        rows = await cursor.fetchall()
    return [_row_to_dict(r) for r in rows]


async def get_recallable_for_scopes(
    user_id: str,
    intent_leaves: list[str],
    mechanisms: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Recall non-revoked questions whose scope overlaps, fairly ordered.

    Matches ``intent_leaf`` in *intent_leaves*, ``mechanism`` in *mechanisms*,
    or ``global``. Ordering is done in Python via ``fair_order_key`` so the
    round-robin policy stays a single testable function.
    """
    pool = get_pool()
    mechanisms = mechanisms or []
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT question_id, scope_type, scope_id, decision, alt_a, alt_b,
                   answers, status, user_flag, last_probed_at, created_at, updated_at,
                   context_tags
            FROM preference_questions
            WHERE user_id = %s
              AND user_flag <> 'revoked'
              AND (
                    scope_type = 'global'
                 OR (scope_type = 'intent_leaf' AND scope_id = ANY(%s))
                 OR (scope_type = 'mechanism'   AND scope_id = ANY(%s))
                 OR context_tags && %s::text[]   -- 上下文 tag 集与当前会话重叠
              )
            """,
            (user_id, intent_leaves or [""], mechanisms or [""],
             intent_leaves or [""]),
        )
        rows = await cursor.fetchall()
    questions = [_row_to_dict(r) for r in rows]
    questions.sort(key=fair_order_key)
    return questions


async def record_answer(
    session_id: str, question_id: str, answer: str, source: str = "probe"
) -> str:
    """Append a vote and recompute status. Returns the new status.

    Two vote *sources* carry equal weight in ``compute_status`` (ADR-0017):
    - ``probe`` — an explicit answer at the confirm gate. Overwrites any earlier
      vote from the same session (a re-answer supersedes) and stamps
      ``last_probed_at`` for the fair-selection recency tier.
    - ``behavior`` — a recurring behavioural signal recorded by reflection when a
      later session's edits/comparisons match an existing question. Behaviour
      *accrues* but never overwrites: if the session already has a vote (explicit
      or a prior behavioural one), it is left as-is — a probe settles, behaviour
      only adds evidence. It does not stamp ``last_probed_at`` (we didn't ask).

    Idempotent per (session, question) in both cases.
    """
    if answer not in VALID_ANSWERS:
        raise ValueError(f"invalid answer '{answer}'")
    if source not in ("probe", "behavior"):
        raise ValueError(f"invalid vote source '{source}'")
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            "SELECT answers FROM preference_questions WHERE question_id = %s",
            (question_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise ValueError(f"question {question_id} not found")
        existing = row[0] or []
        answers, changed = merge_vote(existing, session_id, answer, source)
        status = compute_status(answers)
        if not changed:
            # behaviour left an existing (explicit/earlier) vote untouched.
            return status
        probed_clause = ", last_probed_at = NOW()" if source == "probe" else ""
        await conn.execute(
            f"""
            UPDATE preference_questions
            SET answers = %s::jsonb, status = %s{probed_clause}, updated_at = NOW()
            WHERE question_id = %s
            """,
            (json.dumps(answers, ensure_ascii=False), status, question_id),
        )
        return status


async def get_corroborated_applicable(
    user_id: str,
    intent_leaves: list[str],
    mechanisms: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Corroborated, non-revoked, in-scope questions — the input to Enact."""
    recalled = await get_recallable_for_scopes(user_id, intent_leaves, mechanisms)
    return [q for q in recalled if q["status"] == STATUS_CORROBORATED]


async def set_user_flag(user_id: str, question_id: str, action: str) -> bool:
    """Apply a user memory action: emphasize | revoke | delete. Returns success.

    ``ignore`` is a per-session frontend choice and never reaches the DB.
    """
    flag = {"emphasize": "emphasized", "revoke": "revoked"}.get(action)
    pool = get_pool()
    async with pool.connection() as conn:
        if action == "delete":
            cursor = await conn.execute(
                "DELETE FROM preference_questions WHERE question_id = %s AND user_id = %s",
                (question_id, user_id),
            )
            return cursor.rowcount > 0
        if flag is None:
            return False
        cursor = await conn.execute(
            """
            UPDATE preference_questions
            SET user_flag = %s, updated_at = NOW()
            WHERE question_id = %s AND user_id = %s
            """,
            (flag, question_id, user_id),
        )
        return cursor.rowcount > 0


def _row_to_dict(r: tuple) -> dict[str, Any]:
    return {
        "question_id": str(r[0]),
        "scope_type": r[1],
        "scope_id": r[2],
        "decision": r[3],
        "alt_a": r[4],
        "alt_b": r[5],
        "answers": r[6] or [],
        "status": r[7],
        "user_flag": r[8],
        "last_probed_at": r[9].isoformat() if r[9] else None,
        "created_at": r[10].isoformat() if r[10] else None,
        "updated_at": r[11].isoformat() if r[11] else None,
        "context_tags": r[12] if len(r) > 12 else [],
    }
