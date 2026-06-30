"""Recall record and result — hybrid pgvector search output.

RecallRecord: a single exemplar from the design space library.
RecallResult: the aggregated result with a richness signal.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.schemas.shotscript import ShotScript


class RecallRecord(BaseModel):
    """A single exemplar from the design space library."""

    record_id: str
    intent_tags: list[str]
    intent_brief: str
    shot_script: ShotScript
    provenance: Literal["curated", "user_accepted"]
    quality_signal: float | None = None


class RecallResult(BaseModel):
    """Aggregated recall output with richness signal."""

    exemplars: list[RecallRecord] = []
    signal: Literal["rich", "thin", "empty"] = "empty"
