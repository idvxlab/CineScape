"""Pure scoring and aggregation for the evaluation (no I/O, no model calls).

Everything here is a deterministic function of recorded data, so the numbers a
run reports can be re-derived and unit-tested. Judge-dependent measures enter
only as already-collected verdicts.
"""

from __future__ import annotations

import math
import random
from typing import Any

# ---------------------------------------------------------------------------
# Ledger accuracy against the held-out persona profile
# ---------------------------------------------------------------------------


def _matches(entry: dict[str, Any], question: dict[str, Any]) -> bool:
    """Does a corroborated question express this ground-truth preference?

    A match requires the same parameter field and a prevailing answer whose
    detail carries the preferred value; scope must agree unless the truth is
    global. Comparison is substring-insensitive to phrasing so that "locked-off
    static" matches "static, locked off".
    """
    scope_ok = entry["scope"] == "global" or entry["scope"] == (question.get("scope_id") or "")
    if not scope_ok:
        return False
    prevailing = question.get("prevailing_detail") or {}
    value = prevailing.get(entry["field"])
    if value is None:
        return False
    return _loose_eq(str(value), entry["prefer"])


def _loose_eq(a: str, b: str) -> bool:
    """Phrase-tolerant equality: shared content words, either direction."""
    ta = {w for w in _words(a) if len(w) > 2}
    tb = {w for w in _words(b) if len(w) > 2}
    if not ta or not tb:
        return a.strip().lower() == b.strip().lower()
    return bool(ta & tb)


def _words(s: str) -> list[str]:
    out, cur = [], []
    for ch in s.lower():
        if ch.isalnum():
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def ledger_precision_recall(
    corroborated: list[dict[str, Any]],
    truth: list[dict[str, Any]],
) -> dict[str, float]:
    """Compare what the system corroborated against the persona's real taste.

    Precision = share of corroborated beliefs that are true of the persona
    (a system that "learns" distractors is over-claiming); recall = share of
    the profile that was discovered and confirmed. Exact because the profile
    is known — this is the measure no in-vivo study can compute.
    """
    if not corroborated:
        return {"precision": 1.0 if not truth else 0.0,
                "recall": 0.0, "f1": 0.0, "n_corroborated": 0}
    hits = [q for q in corroborated if any(_matches(t, q) for t in truth)]
    covered = [t for t in truth if any(_matches(t, q) for q in corroborated)]
    precision = len(hits) / len(corroborated)
    recall = len(covered) / len(truth) if truth else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"precision": precision, "recall": recall, "f1": f1,
            "n_corroborated": len(corroborated)}


# ---------------------------------------------------------------------------
# Pairwise judging: blinding, de-biasing, aggregation
# ---------------------------------------------------------------------------


def assign_sides(
    script_a: Any, script_b: Any, seed: int
) -> tuple[dict[str, Any], dict[str, str]]:
    """Blind two scripts as X/Y with deterministic, seeded side randomization.

    Returns the presentation payload and the mapping needed to decode the
    verdict. The judge never receives condition labels.
    """
    rng = random.Random(seed)
    flip = rng.random() < 0.5
    x, y = (script_b, script_a) if flip else (script_a, script_b)
    mapping = {"X": "B", "Y": "A"} if flip else {"X": "A", "Y": "B"}
    return {"X": x, "Y": y}, mapping


def decode_verdict(verdict: str, mapping: dict[str, str]) -> str:
    """Map a judge's X/Y/tie verdict back to condition labels A/B/tie."""
    v = (verdict or "").strip().upper()
    if v in ("X", "Y"):
        return mapping[v]
    return "tie"


def aggregate_pairwise(verdicts: list[str]) -> dict[str, float]:
    """Win rate of condition A over B, ties counted as half (chess scoring).

    Includes a Wilson 95% interval, which behaves sanely at the small trial
    counts this design produces (unlike the normal approximation).
    """
    n = len(verdicts)
    if n == 0:
        return {"n": 0, "win_rate": float("nan"), "wins": 0, "losses": 0, "ties": 0,
                "ci_low": float("nan"), "ci_high": float("nan")}
    wins = sum(1 for v in verdicts if v == "A")
    losses = sum(1 for v in verdicts if v == "B")
    ties = n - wins - losses
    score = (wins + 0.5 * ties) / n
    low, high = _wilson(score, n)
    return {"n": n, "win_rate": score, "wins": wins, "losses": losses,
            "ties": ties, "ci_low": low, "ci_high": high}


def _wilson(p: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return float("nan"), float("nan")
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(max(p * (1 - p) / n + z * z / (4 * n * n), 0.0)) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def mean_rubric(scores: list[float]) -> dict[str, float]:
    """Mean and standard error of a rubric axis (fidelity, craft, diversity)."""
    n = len(scores)
    if n == 0:
        return {"n": 0, "mean": float("nan"), "se": float("nan")}
    mean = sum(scores) / n
    if n == 1:
        return {"n": 1, "mean": mean, "se": 0.0}
    var = sum((s - mean) ** 2 for s in scores) / (n - 1)
    return {"n": n, "mean": mean, "se": math.sqrt(var / n)}


def guardrail_verdict(
    treatment: list[float], control: list[float], margin: float = 0.5
) -> dict[str, Any]:
    """Pre-registered failure check: did a guardrail axis degrade?

    The paper commits in advance that a taste gain bought with intent fidelity
    is not a gain. We flag degradation when the treatment mean falls below the
    control mean by more than *margin* (a rubric point on the 1-5 scale).
    """
    t, c = mean_rubric(treatment), mean_rubric(control)
    if t["n"] == 0 or c["n"] == 0:
        return {"degraded": False, "delta": float("nan"), **{"treatment": t, "control": c}}
    delta = t["mean"] - c["mean"]
    return {"degraded": bool(delta < -margin), "delta": delta,
            "treatment": t, "control": c}


# ---------------------------------------------------------------------------
# Objective (judge-free) measures
# ---------------------------------------------------------------------------


def interaction_cost(trace: list[dict[str, Any]], draft: dict, adopted: dict) -> dict[str, Any]:
    """Cost the user paid this session: turns, edit distance, render calls.

    ``edit_distance`` is the share of the ten controlled parameters that
    changed between the generated draft and the adopted script — the cheapest
    honest proxy for "how much did the user have to fix".
    """
    turns = sum(1 for e in trace if e.get("event_type") == "align_answer")
    renders = sum(1 for e in trace if e.get("event_type") == "render_request")
    d_shots = (draft or {}).get("shots") or []
    a_shots = (adopted or {}).get("shots") or []
    from app.ontology import TEN_PARAMS

    changed = total = 0
    by_order = {s.get("order"): s for s in d_shots}
    for a in a_shots:
        d = by_order.get(a.get("order"))
        if not d:
            continue
        for f in TEN_PARAMS:
            if f in d or f in a:
                total += 1
                if str(d.get(f)) != str(a.get(f)):
                    changed += 1
    return {
        "clarification_turns": turns,
        "render_calls": renders,
        "edit_distance": (changed / total) if total else 0.0,
    }


def undo_latency(applied_by_session: list[bool], shift_index: int) -> int | None:
    """Sessions from an injected taste reversal until stale guidance stops.

    ``applied_by_session[i]`` records whether the now-stale preference was
    still applied in session i. Returns None if it never stopped.
    """
    for offset, applied in enumerate(applied_by_session[shift_index:]):
        if not applied:
            return offset
    return None
