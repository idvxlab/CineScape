"""Database connection pool management.

Uses psycopg3 async connection pool with pgvector extension support.
Configuration via pydantic-settings environment variables.
"""

from __future__ import annotations

from functools import lru_cache

from psycopg_pool import AsyncConnectionPool
from pydantic_settings import BaseSettings


class DBSettings(BaseSettings):
    """Database configuration from environment / .env."""

    database_url: str = "postgresql://cinedesign:cinedesign_dev@localhost:5432/cinedesign"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


_pool: AsyncConnectionPool | None = None


@lru_cache
def get_settings() -> DBSettings:
    return DBSettings()


async def init_pool() -> AsyncConnectionPool:
    """Create and open the global connection pool."""
    global _pool
    settings = get_settings()
    _pool = AsyncConnectionPool(
        conninfo=settings.database_url,
        min_size=1,
        max_size=10,
        open=True,
    )
    return _pool


async def close_pool() -> None:
    """Close the global connection pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> AsyncConnectionPool:
    """Return the global connection pool (must be initialized first)."""
    if _pool is None:
        raise RuntimeError("Database pool not initialized. Call init_pool() first.")
    return _pool
