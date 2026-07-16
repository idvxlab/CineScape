"""Interaction trace capture (ADR-0015, M-A).

An append-only event log written at the API boundary. Capture is
*fire-and-forget*: it must never block the interactive path and must never
raise into a request handler — a trace write failure is strictly less
important than serving the user's turn.

The agent graph is untouched (图状态零接触, ADR-0012 先例): events are
recorded from the FastAPI endpoints, not from LangGraph nodes.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from app.db import get_pool

logger = logging.getLogger(__name__)

EventType = Literal[
    "session_start",
    "align_answer",
    "candidate_select",
    "edit_patch",
    "render_request",
    "adopt",
    "probe_response",
    "skill_activation",
    "skill_outcome",
    "memory_action",
    "frontend_event",
]

_VALID_EVENTS: set[str] = {
    "session_start",
    "align_answer",
    "candidate_select",
    "edit_patch",
    "render_request",
    "adopt",
    "probe_response",
    "skill_activation",
    "skill_outcome",
    "memory_action",
    "frontend_event",
}


async def record_event(
    session_id: str,
    event_type: EventType,
    payload: dict[str, Any] | None = None,
    user_id: str = "anonymous",
) -> None:
    """Append one interaction event. Never raises, never blocks meaningfully.

    Any DB failure is swallowed with a warning — the flywheel is non-critical
    (same contract as writeback). Unknown event types are dropped defensively
    rather than hitting the DB CHECK constraint.
    """
    if event_type not in _VALID_EVENTS:
        logger.warning("Dropping trace event with unknown type: %s", event_type)
        return
    try:
        pool = get_pool()
        async with pool.connection() as conn:
            await conn.execute(
                """
                INSERT INTO interaction_trace (session_id, user_id, event_type, payload)
                VALUES (%s, %s, %s, %s::jsonb)
                """,
                (
                    session_id,
                    user_id or "anonymous",
                    event_type,
                    json.dumps(payload or {}, ensure_ascii=False),
                ),
            )
    except Exception:
        logger.warning("Trace capture failed (non-critical): %s/%s", session_id, event_type,
                       exc_info=True)


async def record_batch(
    session_id: str,
    events: list[dict[str, Any]],
    user_id: str = "anonymous",
) -> int:
    """Record a batch of frontend events. Returns count accepted.

    Each item: ``{"event_type": ..., "payload": {...}}``. Invalid items are
    skipped. Used by ``POST /sessions/{id}/trace`` for the production frontend
    to stream fine-grained events (shot selected, slider dragged, preview
    comparison, ...).
    """
    accepted = 0
    for ev in events or []:
        et = ev.get("event_type", "frontend_event")
        if et not in _VALID_EVENTS:
            et = "frontend_event"
        await record_event(session_id, et, ev.get("payload") or {}, user_id=user_id)
        accepted += 1
    return accepted


async def load_session_trace(session_id: str) -> list[dict[str, Any]]:
    """Load the full ordered event trace for a session (for reflection)."""
    try:
        pool = get_pool()
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT event_type, payload, ts, user_id
                FROM interaction_trace
                WHERE session_id = %s
                ORDER BY event_id ASC
                """,
                (session_id,),
            )
            rows = await cursor.fetchall()
    except Exception:
        logger.warning("Loading session trace failed: %s", session_id, exc_info=True)
        return []
    return [
        {"event_type": r[0], "payload": r[1], "ts": r[2].isoformat() if r[2] else None,
         "user_id": r[3]}
        for r in rows
    ]
