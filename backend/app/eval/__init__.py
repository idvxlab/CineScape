"""Evaluation harness — agent-as-judge comparison of memory conditions.

Tests the claim of Section "Evaluation" in the paper: across repeated sessions
the evolutionary memory produces scripts that better match an individual's
taste, without spending intent fidelity.

The measurement problem this package solves: taste is latent, so the judge must
be told the target taste — but telling it what the *system learned* would be
circular. We therefore use simulated personas whose taste profile is written in
advance and withheld from the system; the profile is ground truth for judging,
the system only ever sees the persona's answers.

- ``personas``  — taste profiles (ground truth) + the answering policy
- ``metrics``   — pure scoring/aggregation: ledger precision, win rates, costs
- ``judge``     — blinded, order-randomized LLM judging
- ``harness``   — drives real sessions over the HTTP API, per condition
"""

from app.eval.metrics import (
    aggregate_pairwise,
    interaction_cost,
    ledger_precision_recall,
    undo_latency,
)
from app.eval.personas import PERSONAS, Persona

__all__ = [
    "PERSONAS",
    "Persona",
    "ledger_precision_recall",
    "aggregate_pairwise",
    "interaction_cost",
    "undo_latency",
]
