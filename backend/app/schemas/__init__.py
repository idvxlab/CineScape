"""Pydantic schemas for API contracts and internal data models."""

from app.schemas.intent import DimensionState, DimStatus, IntentState
from app.schemas.recall import RecallRecord, RecallResult
from app.schemas.session import (
    AlignPhase,
    CandidatesPhase,
    ConfirmPhase,
    Conflict,
    EditPhase,
    GeneratingPhase,
    GeneratingProgress,
    SessionCreate,
    SessionResponse,
    TurnResponse,
)
from app.schemas.shotscript import Shot, ShotScript
from app.schemas.widget import (
    ConfirmWidget,
    FreeTextWidget,
    MultiWidget,
    Opt,
    SingleWidget,
    SliderWidget,
    Widget,
)

__all__ = [
    # Widget protocol
    "Opt",
    "SingleWidget",
    "MultiWidget",
    "SliderWidget",
    "FreeTextWidget",
    "ConfirmWidget",
    "Widget",
    # Intent state
    "DimStatus",
    "DimensionState",
    "IntentState",
    # Shot script
    "Shot",
    "ShotScript",
    # Recall
    "RecallRecord",
    "RecallResult",
    # Session API
    "Conflict",
    "AlignPhase",
    "ConfirmPhase",
    "GeneratingPhase",
    "GeneratingProgress",
    "CandidatesPhase",
    "EditPhase",
    "TurnResponse",
    "SessionCreate",
    "SessionResponse",
]
