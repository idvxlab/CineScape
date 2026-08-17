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
        "options": first_two
        + [{"value": PROBE_OPEN, "label": "Either \u2014 let the system decide"}],
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


def _activation_fingerprint(question_ids: list[str]) -> str:
    """Corroborated 问题集合指纹(ADR-0020 C):排序后 join,变化即"出现新确证"。

    指纹只由问题 ID 构成 —— 同一集合的重复激活不触发(不反复问同一件事);
    集合增减(新确证 / revoke)都会改变指纹 → 重新值得问一次。
    """
    return ",".join(sorted(qid for qid in question_ids if qid))


def select_probe(
    recalled: list[dict[str, Any]],
    already_probed: bool,
    swap: bool = False,
    probe_turn: int = 0,
    last_activation_fingerprint: str | None = None,
) -> dict[str, Any] | None:
    """Pick at most one probe for this session (ADR-0017 §1.4; ADR-0020 A+C 调度).

    调度规则(修复"激活探针独占唯一探针槽"):
    - **A 交替轮换**:``probe_turn`` 偶数轮验证优先、奇数轮激活优先 → 验证通道
      保底 50% 份额,新偏好不再因第一个确证而永久饥饿;
    - **C 事件驱动激活**:激活探针仅在 corroborated 集合指纹与上次不同(出现
      新确证)时出现;指纹未变则即使轮到激活轮也发验证(或无探针),不反复问
      同一件事;
    - 退化:无 corroborated → 纯验证;无验证候选且指纹未变 → None。

    ``recalled`` 假设已由 ``get_recallable_for_scopes`` 公平排序。
    纯函数:调度状态由调用方(``select_and_advance_probe``)读入/推进。
    """
    if already_probed or not recalled:
        return None

    corroborated = [q for q in recalled if q.get("status") == STATUS_CORROBORATED]
    verifiable = [q for q in recalled if q.get("status") != STATUS_CORROBORATED]

    skill = enact(corroborated) if corroborated else None
    activation_due = probe_turn % 2 == 1  # A: 奇数轮激活优先

    if (
        skill is not None
        and _activation_fingerprint([q["question_id"] for q in corroborated])
        != last_activation_fingerprint  # C: 指纹变化(新确证)才值得再问
        and (activation_due or not verifiable)
    ):
        return build_activation_probe(skill, [q["question_id"] for q in corroborated])
    if verifiable:
        return build_verification_probe(verifiable[0], swap=swap)
    return None


# ---------------------------------------------------------------------------
# A+C 调度状态读写(ADR-0020):user_profile.probe_turn + 激活指纹
# ---------------------------------------------------------------------------


async def get_probe_state(user_id: str) -> tuple[int, str | None]:
    """Read the user's probe scheduling state (probe_turn, activation fingerprint)."""
    if user_id == "anonymous" or not user_id:
        return 0, None
    from app.db import get_pool

    try:
        async with get_pool().connection() as conn:
            row = await conn.execute(
                "SELECT probe_turn, last_activation_fingerprint "
                "FROM user_profile WHERE user_id = %s",
                (user_id,),
            )
            r = await row.fetchone()
        if r is None:
            return 0, None
        return int(r[0]), (r[1] if r[1] else None)
    except Exception:
        logger.debug("Probe state read failed for %s", user_id, exc_info=True)
        return 0, None


async def advance_probe_state(user_id: str, fingerprint: str | None) -> None:
    """Advance the scheduling state after issuing a probe: turn+1; update the
    fingerprint when an activation probe was issued (best-effort, never blocks)."""
    if user_id == "anonymous" or not user_id:
        return
    from app.db import get_pool

    try:
        async with get_pool().connection() as conn:
            await conn.execute(
                """
                INSERT INTO user_profile (user_id, probe_turn, last_activation_fingerprint, updated_at)
                VALUES (%s, 1, %s, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    probe_turn = user_profile.probe_turn + 1,
                    last_activation_fingerprint =
                        COALESCE(EXCLUDED.last_activation_fingerprint,
                                 user_profile.last_activation_fingerprint),
                    updated_at = NOW()
                """,
                (user_id, fingerprint),
            )
    except Exception:
        logger.debug("Probe state advance failed for %s", user_id, exc_info=True)


async def select_and_advance_probe(
    user_id: str,
    recalled: list[dict[str, Any]],
    already_probed: bool,
    swap: bool = False,
) -> dict[str, Any] | None:
    """A+C 探针调度入口(ADR-0020):读状态 → 选探针 → 推进状态。

    替代调用点直接调 ``select_probe``:统一从 ``user_profile`` 读/写调度状态,
    保证验证通道保底份额且激活探针不重复轰炸。best-effort,失败退化为
    旧行为(无状态激活优先)。``recalled`` 假设公平排序。
    """
    if already_probed or not recalled:
        return None
    turn, last_fp = await get_probe_state(user_id)
    probe = select_probe(
        recalled,
        already_probed=False,
        swap=swap,
        probe_turn=turn,
        last_activation_fingerprint=last_fp,
    )
    if probe is None:
        return None
    fp = (
        _activation_fingerprint(probe.get("question_ids") or [])
        if probe.get("kind") == "skill_activation"
        else None
    )
    await advance_probe_state(user_id, fp)
    return probe
