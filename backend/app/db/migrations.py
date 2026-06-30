"""Database migrations — schema initialisation runner.

Runs the ``init-db.sql`` script to ensure all required tables and
indexes exist.  Idempotent — safe to call on every application startup.
"""

from __future__ import annotations

from pathlib import Path

from app.db.connection import get_pool


async def init_database() -> None:
    """Run the init-db.sql script to ensure all tables exist."""
    pool = get_pool()
    sql_path = Path(__file__).parent.parent.parent.parent / "scripts" / "init-db.sql"
    sql = sql_path.read_text()

    async with pool.connection() as conn:
        await conn.execute(sql)
