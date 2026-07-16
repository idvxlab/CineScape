"""Hybrid search over the design space example library using pgvector.

Combines vector similarity search (embedding-based) with structured
metadata filtering (tag-based) for recall of relevant examples.
"""

from __future__ import annotations

import json

from app.db import get_pool
from app.schemas.recall import RecallRecord, RecallResult
from app.schemas.shotscript import ShotScript


async def hybrid_search(
    tags: list[str],
    brief_embedding: list[float] | None = None,
    limit: int = 12,
) -> RecallResult:
    """Perform hybrid vector + tag search over the solution library.

    1. Filter by tags overlap (GIN index on ``intent_tags``).
    2. Order by cosine similarity to *brief_embedding* (HNSW index).
    3. Return :class:`RecallResult` with richness signal.

    Args:
        tags: Ontology leaf IDs to filter by.
        brief_embedding: 768-d embedding vector for semantic similarity.
            If None, falls back to tag-only search without vector ordering.
        limit: Maximum number of results to return.

    Returns:
        :class:`RecallResult` with exemplars and richness signal.
    """
    pool = get_pool()
    async with pool.connection() as conn:
        # ADR-0015: adopted_disputed(曾被后续行为质疑)降序召回,排在最后
        if brief_embedding is not None:
            cursor = await conn.execute(
                """
                SELECT record_id, intent_tags, intent_brief, shot_script, provenance, quality_signal
                FROM solution_library
                WHERE intent_tags && %s::text[]
                ORDER BY (provenance = 'adopted_disputed'), embedding <=> %s::vector
                LIMIT %s
                """,
                (tags, brief_embedding, limit),
            )
        else:
            cursor = await conn.execute(
                """
                SELECT record_id, intent_tags, intent_brief, shot_script, provenance, quality_signal
                FROM solution_library
                WHERE intent_tags && %s::text[]
                ORDER BY (provenance = 'adopted_disputed')
                LIMIT %s
                """,
                (tags, limit),
            )
        rows = await cursor.fetchall()

    exemplars = [
        RecallRecord(
            record_id=str(row[0]),
            intent_tags=row[1],
            intent_brief=row[2],
            shot_script=ShotScript.model_validate(row[3]),
            provenance=row[4],
            quality_signal=row[5],
        )
        for row in rows
    ]

    # ADR-0008: cold start = always empty
    if len(exemplars) == 0:
        signal = "empty"
    elif len(exemplars) < 3:
        signal = "thin"
    else:
        signal = "rich"

    return RecallResult(exemplars=exemplars, signal=signal)


async def fetch_user_exemplars(
    user_id: str,
    tags: list[str],
    limit: int = 6,
) -> list[dict]:
    """Fetch a user's own adopted exemplars overlapping *tags* (ADR-0018).

    Supplies few-shot example candidates for workflow-skill enactment:
    confirmed adoptions rank before unverified; disputed rank last. Returns
    plain dicts (record_id, intent_tags, shot_script, provenance) — the
    pure ``select_examples`` helper does the shot-level picking.
    """
    if not user_id or user_id == "anonymous" or not tags:
        return []
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT record_id, intent_tags, shot_script, provenance
            FROM solution_library
            WHERE user_id = %s AND intent_tags && %s::text[]
            ORDER BY (provenance = 'adopted_confirmed') DESC,
                     (provenance = 'adopted_disputed') ASC,
                     created_at DESC
            LIMIT %s
            """,
            (user_id, tags, limit),
        )
        rows = await cursor.fetchall()
    return [
        {
            "record_id": str(r[0]),
            "intent_tags": r[1],
            "shot_script": r[2],
            "provenance": r[3],
        }
        for r in rows
    ]


async def writeback(
    intent_tags: list[str],
    intent_brief: str,
    embedding: list[float] | None,
    shot_script: dict,
    provenance: str = "adopted_unverified",
    user_id: str | None = None,
    session_id: str | None = None,
    edit_summary: dict | None = None,
) -> str:
    """Insert a new record into the solution library (flywheel).

    ``embedding`` may be None (embedding 服务不可用时降级):该行仍可被
    tags 过滤检索到,只是不参与语义排序。

    ADR-0015: 采纳先落 ``adopted_unverified``(观察期),由后续会话行为追溯
    改级为 confirmed/disputed;记录采纳者与来源会话以支持审计与删除。

    Returns:
        The ``record_id`` of the newly inserted row.
    """
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO solution_library
                (intent_tags, intent_brief, embedding, shot_script, provenance,
                 user_id, session_id, edit_summary)
            VALUES (%s, %s, %s::vector, %s::jsonb, %s, %s, %s, %s::jsonb)
            RETURNING record_id
            """,
            (
                intent_tags,
                intent_brief,
                embedding,
                json.dumps(shot_script, ensure_ascii=False),
                provenance,
                user_id,
                session_id,
                json.dumps(edit_summary, ensure_ascii=False) if edit_summary else None,
            ),
        )
        row = await cursor.fetchone()
        return str(row[0])
