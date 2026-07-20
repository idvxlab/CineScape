"""Memory panel endpoints (ADR-0017).

"What the system knows about me": lists every preference question with its
context, decision axis, the two alternatives, the prevailing answer so far, and
its answer history, and lets the user emphasize, revoke, or delete each one.
This is the human-in-the-loop over the outer loop — users co-curate the model
the system holds of them.

  GET  /users/{user_id}/memory                — list preference questions
  POST /users/{user_id}/memory/{question_id}  — {action: emphasize|revoke|delete}
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.evolution import record_event
from app.evolution.questions import (
    ANSWER_A,
    ANSWER_B,
    get_questions_for_user,
    prevailing_answer,
    set_user_flag,
)

logger = logging.getLogger(__name__)

memory_router = APIRouter()


class MemoryActionBody(BaseModel):
    action: str  # emphasize | revoke | delete


def _prevailing_detail(question: dict) -> dict:
    """The design-space detail of the prevailing alternative, if settled.

    Exposed so an evaluation can compare corroborated beliefs against a known
    ground-truth taste profile (ledger precision/recall); the panel itself
    renders the label, not this.
    """
    p = prevailing_answer(question.get("answers") or [])
    if p == ANSWER_A:
        return (question.get("alt_a") or {}).get("detail") or {}
    if p == ANSWER_B:
        return (question.get("alt_b") or {}).get("detail") or {}
    return {}


def _prevailing_label(question: dict) -> str:
    """Plain-language prevailing conclusion for the panel."""
    p = prevailing_answer(question.get("answers") or [])
    if p == ANSWER_A:
        return (question.get("alt_a") or {}).get("label", "选项 A")
    if p == ANSWER_B:
        return (question.get("alt_b") or {}).get("label", "选项 B")
    if p == "open":
        return "两可"
    return "尚未确定"


@memory_router.get("/{user_id}/memory")
async def list_memory(user_id: str):
    """List a user's preference questions with prevailing answers."""
    try:
        questions = await get_questions_for_user(user_id, include_revoked=True)
    except Exception:
        logger.warning("list_memory failed for %s", user_id, exc_info=True)
        raise HTTPException(status_code=503, detail="记忆服务暂不可用")
    return {
        "user_id": user_id,
        "questions": [
            {
                "question_id": q["question_id"],
                "scope_type": q["scope_type"],
                "scope_id": q["scope_id"],
                "decision": q["decision"],
                "alt_a": (q.get("alt_a") or {}).get("label", "A"),
                "alt_b": (q.get("alt_b") or {}).get("label", "B"),
                "status": q["status"],
                "prevailing": _prevailing_label(q),
                "prevailing_detail": _prevailing_detail(q),
                "answer_count": len(q.get("answers") or []),
                "user_flag": q["user_flag"],
                "updated_at": q["updated_at"],
            }
            for q in questions
        ],
    }


@memory_router.post("/{user_id}/memory/{question_id}")
async def act_on_memory(
    user_id: str, question_id: str, body: MemoryActionBody, request: Request
):
    """Emphasize, revoke, or delete a preference question (user data sovereignty)."""
    if body.action not in ("emphasize", "revoke", "delete"):
        raise HTTPException(status_code=422, detail="action 只能是 emphasize | revoke | delete")
    try:
        ok = await set_user_flag(user_id, question_id, body.action)
    except Exception:
        logger.warning("act_on_memory failed for %s/%s", user_id, question_id, exc_info=True)
        raise HTTPException(status_code=503, detail="记忆服务暂不可用")
    if not ok:
        raise HTTPException(status_code=404, detail="问题不存在或不属于该用户")
    await record_event(
        f"memory-panel:{user_id}",
        "memory_action",
        {"question_id": question_id, "action": body.action},
        user_id=user_id,
    )
    return {"ok": True, "action": body.action, "question_id": question_id}
