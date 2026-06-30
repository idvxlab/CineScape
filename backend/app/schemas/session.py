"""Session API schemas — request/response models for session endpoints.

Based on 架构设计.md §4 TurnResponse contract.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.schemas.shotscript import ShotScript
from app.schemas.widget import Widget


class Conflict(BaseModel):
    """A conflict detected during edit revalidation."""

    shot_order: int
    field: str
    message: str


class AlignPhase(BaseModel):
    """Alignment phase — widgets presented to user, not yet converged."""

    phase: Literal["align"] = "align"
    reflection: str
    widgets: list[Widget]
    converged: Literal[False] = False


class ConfirmPhase(BaseModel):
    """Confirmation phase — reflection presented for final acceptance."""

    phase: Literal["confirm"] = "confirm"
    reflection: str
    brief: str = ""
    tags: list[str] = []
    converged: Literal[True] = True


class GeneratingPhase(BaseModel):
    """Generating phase — parallel direction generation in progress."""

    phase: Literal["generating"] = "generating"
    progress: list[GeneratingProgress]


class GeneratingProgress(BaseModel):
    """Progress of a single generation direction."""

    dir: str
    done: bool


class CandidatesPhase(BaseModel):
    """Candidates phase — A/B/C schemes ready for user selection."""

    phase: Literal["candidates"] = "candidates"
    schemes: list[ShotScript]


class EditPhase(BaseModel):
    """Edit phase — user is editing a selected scheme."""

    phase: Literal["edit"] = "edit"
    scheme: ShotScript
    conflicts: list[Conflict] = []


TurnResponse = AlignPhase | ConfirmPhase | GeneratingPhase | CandidatesPhase | EditPhase


class SessionCreate(BaseModel):
    """Request body for creating a new alignment session."""

    raw_intent: str


class SessionResponse(BaseModel):
    """Response body for session retrieval."""

    session_id: str
    state: dict
