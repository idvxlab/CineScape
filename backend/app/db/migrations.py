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
    """Run the init-db.sql script to ensure all tables exist."""
    pool = get_pool()
    sql_path = Path(__file__).parent.parent.parent.parent / "scripts" / "init-db.sql"
    sql = sql_path.read_text(encoding="utf-8")
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
