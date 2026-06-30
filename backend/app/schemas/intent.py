"""Intent state schema — creative intent dimensions and convergence state.

Dimension states use qualitative labels (open / leaning / resolved /
conflicting / blocked_by), never numeric confidence scores.
(Golden Rule 1: align with reasoning, not scoring.)
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

DimStatus = Literal["open", "leaning", "resolved", "conflicting", "blocked_by"]


class DimensionState(BaseModel):
    """State of a single ontology dimension during alignment."""

    value: str | None = None
    candidates: list[str] = []
    status: DimStatus
    blocked_by: str | None = None


class IntentState(BaseModel):
    """Full intent state carried across alignment turns.

    dimensions: key = ontology dimension id (e.g. "认知/视角控制").
    key_dimensions: sticky set — convergence predicate only checks these.
    brief: synthesized when convergence is reached.
    tags: selected ontology leaves produced at convergence.
    """

    raw_intent: str
    dimensions: dict[str, DimensionState] = {}
    key_dimensions: list[str] = []
    brief: str | None = None
    tags: list[str] = []
