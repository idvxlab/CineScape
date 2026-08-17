"""Study package — 纵向用户评测编排层 (ADR-0019, CineScape 载体)."""

from app.study.api import study_router
from app.study.protocol import ensure_study_assets

__all__ = ["study_router", "ensure_study_assets"]
