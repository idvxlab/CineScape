"""Unit tests for workflow-skill enactment and consumption (ADR-0017 §1.5)."""

from __future__ import annotations

from app.evolution.probes import (
    ACT_APPLY,
    PROBE_OPEN,
    build_activation_probe,
    build_verification_probe,
    select_probe,
)
from app.evolution.skills import enact, reorder_directions


def _q(qid, scope_id, prefer, answers, status="corroborated", decision="d"):
    """A corroborated question preferring `prefer` on movement."""
    return {
        "question_id": qid,
        "scope_type": "intent_leaf",
        "scope_id": scope_id,
        "decision": decision,
        "alt_a": {"label": "静止", "detail": {"movement": "固定"}},
        "alt_b": {"label": "推进", "detail": {"movement": "缓慢推进"}},
        "answers": answers,
        "status": status,
    }


def _agree(*sessions_answer):
    return [{"session_id": s, "answer": a} for s, a in sessions_answer]


def test_enact_empty_returns_none():
    assert enact([]) is None


def test_enact_open_question_yields_no_guidance():
    q = _q("q1", "6.2", "a", _agree(("s1", "open"), ("s2", "open")))
    assert enact([q]) is None  # indifference contributes nothing


def test_enact_prefer_and_avoid_from_prevailing():
    q = _q("q1", "6.2", "a", _agree(("s1", "a"), ("s2", "a")))  # prefers alt_a (固定)
    skill = enact([q])
    assert skill is not None
    prefer = {r["field"]: r["values"] for r in skill["detail"]["prefer"]}
    avoid = {r["field"]: r["values"] for r in skill["detail"]["avoid"]}
    assert prefer["movement"] == ["固定"]
    assert avoid["movement"] == ["缓慢推进"]
    assert "6.2" in skill["applicability"]["intent_codes"]
    assert skill["source_question_ids"] == ["q1"]


def test_enact_conflict_resolved_by_agreeing_count():
    # q1: 2 sessions prefer 固定; q2: 3 sessions prefer 缓慢推进 → q2 wins the field
    q1 = _q("q1", "6.2", "a", _agree(("s1", "a"), ("s2", "a")))
    q2 = _q("q2", "6.2", "b", _agree(("s3", "b"), ("s4", "b"), ("s5", "b")))
    skill = enact([q1, q2])
    prefer = {r["field"]: r["values"] for r in skill["detail"]["prefer"]}
    assert prefer["movement"] == ["缓慢推进"]  # stronger corroboration wins


def test_reorder_never_drops_directions():
    directions = [
        {"id": "A", "name": "共情", "dominant_intents": ["5.2"]},
        {"id": "B", "name": "空间", "dominant_intents": ["6.2"]},
    ]
    skill = {"strategy": {"prefer_intent_codes": ["6.2"]}}
    out = reorder_directions(list(directions), skill)
    assert out[0]["dominant_intents"] == ["6.2"]      # preferred leads
    assert {d["id"] for d in out} == {"A", "B"}        # set invariant: nothing dropped


def test_reorder_no_skill_is_identity():
    directions = [{"id": "A"}, {"id": "B"}]
    assert reorder_directions(list(directions), None) == directions


# --- probe selection --------------------------------------------------------


def test_verification_probe_swaps_options_but_keeps_answer_frame():
    q = _q("q1", "6.2", "a", [], status="observed")
    normal = build_verification_probe(q, swap=False)
    swapped = build_verification_probe(q, swap=True)
    assert [o["value"] for o in normal["options"]] == ["a", "b", "open"]
    assert [o["value"] for o in swapped["options"]] == ["b", "a", "open"]
    assert swapped["options"][-1]["value"] == PROBE_OPEN


def test_select_probe_prefers_activation_when_corroborated_exists():
    corrob = _q("q1", "6.2", "a", _agree(("s1", "a"), ("s2", "a")))
    observed = _q("q2", "6.2", "a", [], status="observed")
    probe = select_probe([corrob, observed], already_probed=False)
    assert probe["kind"] == "skill_activation"


def test_select_probe_verifies_when_none_corroborated():
    observed = _q("q2", "6.2", "a", [], status="observed")
    probe = select_probe([observed], already_probed=False)
    assert probe["kind"] == "preference_probe"
    assert probe["question_id"] == "q2"


def test_select_probe_respects_anti_fatigue():
    observed = _q("q2", "6.2", "a", [], status="observed")
    assert select_probe([observed], already_probed=True) is None
    assert select_probe([], already_probed=False) is None


def test_activation_probe_has_three_actions():
    skill = enact([_q("q1", "6.2", "a", _agree(("s1", "a"), ("s2", "a")))])
    probe = build_activation_probe(skill, ["q1"])
    assert {o["value"] for o in probe["options"]} == {ACT_APPLY, "leave", "forget"}
