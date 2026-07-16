"""Database migrations — schema initialisation runner.

Runs the ``init-db.sql`` script to ensure all required tables and
indexes exist.  Idempotent — safe to call on every application startup.
"""

from __future__ import annotations

import logging
from pathlib import Path

from psycopg.errors import FeatureNotSupported, UndefinedFile

from app.db.connection import get_pool


logger = logging.getLogger(__name__)


async def init_database() -> None:
    """Run the schema scripts to ensure all tables exist.

    ``init-evolution.sql`` (ADR-0017 outer loop: trace / preference questions /
    profile) is pgvector-free and always runs, so the evolutionary memory works
    even where ``init-db.sql`` degrades below.
    """
    pool = get_pool()
    scripts_dir = Path(__file__).parent.parent.parent.parent / "scripts"

    evolution_sql = scripts_dir / "init-evolution.sql"
    if evolution_sql.exists():
        async with pool.connection() as conn:
            await conn.execute(evolution_sql.read_text(encoding="utf-8"))

    sql = (scripts_dir / "init-db.sql").read_text(encoding="utf-8")
    try:
        async with pool.connection() as conn:
            await conn.execute(sql)
    except (FeatureNotSupported, UndefinedFile) as exc:
        # pgvector backs the optional recall/flywheel enhancer.  A native
        # Windows PostgreSQL install may not provide it; checkpoint-backed
        # sessions must still be allowed to start in that configuration.
        if "vector" not in str(exc).lower():
            raise
        logger.warning(
            "pgvector is unavailable; skipping the optional solution library initialization"
        )
