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
        if brief_embedding is not None:
            cursor = await conn.execute(
                """
                SELECT record_id, intent_tags, intent_brief, shot_script, provenance, quality_signal
                FROM solution_library
                WHERE intent_tags && %s::text[]
                ORDER BY embedding <=> %s::vector
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


async def writeback(
    intent_tags: list[str],
    intent_brief: str,
    embedding: list[float] | None,
    shot_script: dict,
    provenance: str = "user_accepted",
) -> str:
    """Insert a new record into the solution library (flywheel).

    ``embedding`` may be None (embedding 服务不可用时降级):该行仍可被
    tags 过滤检索到,只是不参与语义排序。

    Returns:
        The ``record_id`` of the newly inserted row.
    """
    pool = get_pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO solution_library
                (intent_tags, intent_brief, embedding, shot_script, provenance)
            VALUES (%s, %s, %s::vector, %s::jsonb, %s)
            RETURNING record_id
            """,
            (
                intent_tags,
                intent_brief,
                embedding,
                json.dumps(shot_script, ensure_ascii=False),
                provenance,
            ),
        )
        row = await cursor.fetchone()
        return str(row[0])
