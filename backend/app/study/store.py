"""Study store — CRUD over the ADR-0019 study tables (CineScape 载体).

participants / runs / cases / choices;psycopg3 async pool via app.db.get_pool()。
与 cinedesign 参考实现的表结构同构(见 cinedesign docs/evaluation-user-study-design.md)。
"""

from __future__ import annotations

import logging
from typing import Any

from app.db import get_pool

logger = logging.getLogger(__name__)

_PARTICIPANT_COLS = "id, participant_code, literacy, intent_code, user_id, status, created_at"


def _row_to_dict(cursor, row) -> dict:
    """psycopg3 TupleRow → dict,列名取自 cursor.description。"""
    cols = [d[0] for d in cursor.description] if cursor.description else []
    return dict(zip(cols, row)) if row is not None else {}


async def _rows_to_dicts(cursor) -> list[dict]:
    cols = [d[0] for d in cursor.description] if cursor.description else []
    rows = await cursor.fetchall()
    return [dict(zip(cols, r)) for r in rows]


async def create_participant(code: str, literacy: str, intent_code: str, user_id: str) -> dict:
    async with get_pool().connection() as conn:
        row = await conn.execute(
            f"INSERT INTO study_participants "
            f"(participant_code, literacy, intent_code, user_id) "
            f"VALUES (%s, %s, %s, %s) RETURNING {_PARTICIPANT_COLS}",
            (code, literacy, intent_code, user_id),
        )
        r = await row.fetchone()
    return _row_to_dict(row, r)


async def get_participant(pid: str) -> dict | None:
    async with get_pool().connection() as conn:
        row = await conn.execute(
            f"SELECT {_PARTICIPANT_COLS} FROM study_participants WHERE id = %s", (pid,)
        )
        r = await row.fetchone()
    return _row_to_dict(row, r) or None


async def get_participant_by_code(code: str) -> dict | None:
    async with get_pool().connection() as conn:
        row = await conn.execute(
            f"SELECT {_PARTICIPANT_COLS} FROM study_participants WHERE participant_code = %s",
            (code,),
        )
        r = await row.fetchone()
    return _row_to_dict(row, r) or None


async def list_runs(pid: str) -> list[dict]:
    async with get_pool().connection() as conn:
        rows = await conn.execute(
            "SELECT id, participant_id, run_index, scene_id, session_id, status, created_at "
            "FROM study_runs WHERE participant_id = %s ORDER BY run_index",
            (pid,),
        )
        return await _rows_to_dicts(rows)


async def list_cases(pid: str) -> list[dict]:
    async with get_pool().connection() as conn:
        rows = await conn.execute(
            "SELECT id, participant_id, case_index, scene_id, intent_code, "
            "       condition_order, align_session_id, brief_snapshot, "
            "       branch_sessions, videos, schemes, status, created_at "
            "FROM study_cases WHERE participant_id = %s ORDER BY case_index",
            (pid,),
        )
        return await _rows_to_dicts(rows)


async def get_case(case_id: str) -> dict | None:
    async with get_pool().connection() as conn:
        row = await conn.execute(
            "SELECT id, participant_id, case_index, scene_id, intent_code, "
            "       condition_order, align_session_id, brief_snapshot, "
            "       branch_sessions, videos, schemes, status, created_at "
            "FROM study_cases WHERE id = %s",
            (case_id,),
        )
        r = await row.fetchone()
    return _row_to_dict(row, r) or None


async def create_plan(pid: str, intent_code: str, seed_offset: int) -> None:
    """为参与者生成计划:5 个 learning runs + 6 个 heldout cases。

    - learning 场景固定 learning-01..05(每人相同素材,便于跨人比较);
    - heldout 场景从 20 个里按 seed_offset 轮转取 6 个,避免所有人同场景;
    - condition_order 按 case 交替(顺序平衡)。
    """
    from app.study.protocol import HELDOUT_SCENES, LEARNING_SCENES

    async with get_pool().connection() as conn:
        for i, scene in enumerate(LEARNING_SCENES[:5], start=1):
            await conn.execute(
                "INSERT INTO study_runs (participant_id, run_index, scene_id, status) "
                "VALUES (%s, %s, %s, 'pending')",
                (pid, i, scene),
            )
        for i in range(1, 7):
            scene = HELDOUT_SCENES[(seed_offset + i - 1) % len(HELDOUT_SCENES)]
            order = "with_first" if i % 2 == 1 else "without_first"
            await conn.execute(
                "INSERT INTO study_cases "
                "(participant_id, case_index, scene_id, intent_code, condition_order, status) "
                "VALUES (%s, %s, %s, %s, %s, 'pending')",
                (pid, i, scene, intent_code, order),
            )


async def set_run_session(run_id: str, session_id: str) -> None:
    async with get_pool().connection() as conn:
        await conn.execute(
            "UPDATE study_runs SET session_id = %s, status = 'in_progress' WHERE id = %s",
            (session_id, run_id),
        )


async def set_run_done(run_id: str) -> None:
    async with get_pool().connection() as conn:
        await conn.execute("UPDATE study_runs SET status = 'done' WHERE id = %s", (run_id,))


async def get_run(run_id: str) -> dict | None:
    """Fetch one learning run by id (join participant for user_id)."""
    async with get_pool().connection() as conn:
        row = await conn.execute(
            "SELECT r.id, r.participant_id, r.run_index, r.scene_id, r.session_id, "
            "       r.status, p.user_id "
            "FROM study_runs r JOIN study_participants p ON p.id = r.participant_id "
            "WHERE r.id = %s",
            (run_id,),
        )
        r = await row.fetchone()
    return _row_to_dict(row, r) or None


async def get_memory_summary(user_id: str) -> dict:
    """Preference ledger 状态分布(供 finish 端点返回给前端展示)。"""
    async with get_pool().connection() as conn:
        rows = await conn.execute(
            "SELECT status, COUNT(*) AS n FROM preference_questions "
            "WHERE user_id = %s GROUP BY status",
            (user_id,),
        )
        out = {"observed": 0, "tentative": 0, "corroborated": 0}
        for r in await rows.fetchall():
            status, n = r[0], int(r[1])
            if status in out:
                out[status] = n
        return out


async def has_incomplete_learning(pid: str) -> bool:
    """该参与者是否还有未完成的 learning run(评测前置守卫用)。"""
    async with get_pool().connection() as conn:
        row = await conn.execute(
            "SELECT COUNT(*) FROM study_runs WHERE participant_id = %s AND status != 'done'",
            (pid,),
        )
        r = await row.fetchone()
    return (int(r[0]) if r else 0) > 0


async def set_case_align(case_id: str, session_id: str, snapshot: dict) -> None:
    async with get_pool().connection() as conn:
        await conn.execute(
            "UPDATE study_cases SET align_session_id = %s, brief_snapshot = %s, "
            "status = 'aligning' WHERE id = %s",
            (session_id, snapshot, case_id),
        )


async def set_case_generated(case_id: str, schemes: dict) -> None:
    async with get_pool().connection() as conn:
        await conn.execute(
            "UPDATE study_cases SET schemes = %s, status = 'generating' WHERE id = %s",
            (schemes, case_id),
        )


async def set_case_videos(case_id: str, videos: dict, status: str = "comparing") -> None:
    async with get_pool().connection() as conn:
        await conn.execute(
            "UPDATE study_cases SET videos = %s, status = %s WHERE id = %s",
            (videos, status, case_id),
        )


async def save_choice(case_id: str, preference: str, ratings: dict, comment: str | None) -> None:
    async with get_pool().connection() as conn:
        await conn.execute(
            "INSERT INTO study_choices (case_id, preference, ratings, comment) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (case_id) DO UPDATE SET preference = EXCLUDED.preference, "
            "ratings = EXCLUDED.ratings, comment = EXCLUDED.comment",
            (case_id, preference, ratings, comment),
        )
        await conn.execute("UPDATE study_cases SET status = 'done' WHERE id = %s", (case_id,))


async def get_choice(case_id: str) -> dict | None:
    async with get_pool().connection() as conn:
        row = await conn.execute(
            "SELECT id, case_id, preference, ratings, comment, created_at "
            "FROM study_choices WHERE case_id = %s",
            (case_id,),
        )
        r = await row.fetchone()
    return _row_to_dict(row, r) or None
