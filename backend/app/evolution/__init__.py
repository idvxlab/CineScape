"""Evolution package — double-loop self-evolution (ADR-0017).

Outer loop over the system's *beliefs about the user*, modeled as preference
questions ``q = (c, d, a, b)`` that ordinary behaviour proposes and explicit
probe answers settle. Status is the prevailing (mode) answer; corroborated
in-scope questions are enacted into a session-level workflow skill.

- ``trace``     — append-only interaction event capture
- ``questions`` — preference-question store + prevailing-answer state machine
- ``reflect``   — trace → discovered questions (proposes, never settles)
- ``probes``    — fair verification / skill-activation probes
- ``skills``    — Enact(C_t) view + consumption helpers
"""

from app.evolution.probes import (
    ACT_APPLY,
    ACT_FORGET,
    ACT_LEAVE,
    PROBE_A,
    PROBE_B,
    PROBE_OPEN,
    build_activation_probe,
    build_verification_probe,
    recall_questions,
    select_probe,
)
from app.evolution.questions import (
    compute_status,
    get_corroborated_applicable,
    prevailing_answer,
    record_answer,
    set_user_flag,
)
from app.evolution.reflect import build_evidence_digest, reflect_session
from app.evolution.skills import (
    enact,
    evaluate_skill_adoption,
    preferred_values,
    reorder_directions,
    skill_prompt_section,
)
from app.evolution.trace import load_session_trace, record_batch, record_event

__all__ = [
    "record_event",
    "record_batch",
    "load_session_trace",
    "compute_status",
    "prevailing_answer",
    "record_answer",
    "set_user_flag",
    "get_corroborated_applicable",
    "reflect_session",
    "build_evidence_digest",
    "recall_questions",
    "select_probe",
    "build_verification_probe",
    "build_activation_probe",
    "enact",
    "reorder_directions",
    "skill_prompt_section",
    "preferred_values",
    "evaluate_skill_adoption",
    "PROBE_A",
    "PROBE_B",
    "PROBE_OPEN",
    "ACT_APPLY",
    "ACT_LEAVE",
    "ACT_FORGET",
]
