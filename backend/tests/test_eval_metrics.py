"""Unit tests for the evaluation's deterministic core.

These cover the parts that decide whether a reported number means anything:
blinding/decoding, tie-tolerant aggregation, ledger precision against a known
profile, and the pre-registered guardrail failure check.
"""

from __future__ import annotations

from app.eval.metrics import (
    aggregate_pairwise,
    assign_sides,
    decode_verdict,
    guardrail_verdict,
    interaction_cost,
    ledger_precision_recall,
    mean_rubric,
    undo_latency,
)
from app.eval.personas import PERSONAS, ground_truth_pairs
from app.eval.simulate import answer_probe, edit_toward_profile

# --- blinding -----------------------------------------------------------------


def test_assign_sides_is_deterministic_and_decodes_back():
    for seed in range(12):
        payload, mapping = assign_sides({"id": "A"}, {"id": "B"}, seed)
        # whichever way it flipped, decoding recovers the true condition
        x_is = mapping["X"]
        assert payload["X"]["id"] == x_is
        assert decode_verdict("X", mapping) == x_is
        assert decode_verdict("Y", mapping) == mapping["Y"]
        # same seed → same assignment (reproducible trials)
        assert assign_sides({"id": "A"}, {"id": "B"}, seed)[1] == mapping


def test_assign_sides_actually_randomizes_across_seeds():
    maps = {assign_sides({"id": "A"}, {"id": "B"}, s)[1]["X"] for s in range(20)}
    assert maps == {"A", "B"}, "side assignment must vary, else position bias is baked in"


def test_decode_treats_anything_else_as_tie():
    _, mapping = assign_sides({}, {}, 1)
    assert decode_verdict("tie", mapping) == "tie"
    assert decode_verdict("", mapping) == "tie"
    assert decode_verdict("both", mapping) == "tie"


# --- aggregation ---------------------------------------------------------------


def test_aggregate_counts_ties_as_half():
    r = aggregate_pairwise(["A", "A", "B", "tie"])
    assert r["wins"] == 2 and r["losses"] == 1 and r["ties"] == 1
    assert r["win_rate"] == (2 + 0.5) / 4


def test_aggregate_all_ties_is_even():
    assert aggregate_pairwise(["tie", "tie"])["win_rate"] == 0.5


def test_aggregate_empty_is_not_a_win():
    r = aggregate_pairwise([])
    assert r["n"] == 0 and r["win_rate"] != r["win_rate"]  # NaN, not 0.0 or 1.0


def test_confidence_interval_brackets_the_estimate_and_widens_when_small():
    few = aggregate_pairwise(["A", "A", "A"])
    many = aggregate_pairwise(["A"] * 30)
    assert few["ci_low"] <= few["win_rate"] <= few["ci_high"]
    assert (few["ci_high"] - few["ci_low"]) > (many["ci_high"] - many["ci_low"])


# --- ledger precision against known ground truth --------------------------------


def _q(scope, detail):
    return {"scope_id": scope, "decision": "d", "prevailing_detail": detail}


def test_ledger_precision_rewards_true_beliefs():
    truth = [{"scope": "8.3", "field": "movement", "prefer": "locked-off static",
              "avoid": "handheld", "decision": "stillness"}]
    got = ledger_precision_recall([_q("8.3", {"movement": "static, locked off"})], truth)
    assert got["precision"] == 1.0 and got["recall"] == 1.0


def test_ledger_precision_penalizes_learned_distractors():
    truth = [{"scope": "8.3", "field": "movement", "prefer": "locked-off static",
              "avoid": "handheld", "decision": "stillness"}]
    corroborated = [
        _q("8.3", {"movement": "static, locked off"}),   # true
        _q("1.4", {"shot_size": "extreme wide"}),        # never in the profile
    ]
    got = ledger_precision_recall(corroborated, truth)
    assert got["precision"] == 0.5
    assert got["recall"] == 1.0  # found the real one, but over-claimed


def test_ledger_wrong_pole_does_not_count_as_learned():
    truth = [{"scope": "global", "field": "movement", "prefer": "locked-off static",
              "avoid": "handheld follow", "decision": "stillness"}]
    got = ledger_precision_recall([_q("global", {"movement": "handheld follow"})], truth)
    assert got["precision"] == 0.0 and got["recall"] == 0.0


def test_empty_ledger_has_zero_recall():
    truth = [{"scope": "8.3", "field": "movement", "prefer": "x", "avoid": "y",
              "decision": "d"}]
    got = ledger_precision_recall([], truth)
    assert got["recall"] == 0.0 and got["n_corroborated"] == 0


# --- guardrails ------------------------------------------------------------------


def test_guardrail_flags_fidelity_degradation():
    v = guardrail_verdict(treatment=[3.0, 3.0], control=[4.5, 4.5])
    assert v["degraded"] is True and v["delta"] < 0


def test_guardrail_passes_when_fidelity_holds():
    v = guardrail_verdict(treatment=[4.4, 4.6], control=[4.5, 4.5])
    assert v["degraded"] is False


def test_guardrail_ignores_improvement():
    assert guardrail_verdict(treatment=[5.0], control=[3.0])["degraded"] is False


def test_mean_rubric_reports_spread():
    r = mean_rubric([4.0, 4.0, 4.0])
    assert r["mean"] == 4.0 and r["se"] == 0.0
    assert mean_rubric([])["n"] == 0


# --- objective measures ----------------------------------------------------------


def test_interaction_cost_counts_turns_and_edit_distance():
    trace = [{"event_type": "align_answer"}, {"event_type": "align_answer"},
             {"event_type": "render_request"}]
    draft = {"shots": [{"order": 1, "movement": "static", "shot_size": "wide"}]}
    adopted = {"shots": [{"order": 1, "movement": "handheld", "shot_size": "wide"}]}
    c = interaction_cost(trace, draft, adopted)
    assert c["clarification_turns"] == 2 and c["render_calls"] == 1
    assert 0 < c["edit_distance"] < 1  # one of the present params changed


def test_undo_latency_counts_sessions_until_stale_guidance_stops():
    assert undo_latency([True, True, True, False, False], shift_index=2) == 1
    assert undo_latency([True, True], shift_index=0) is None


# --- persona agent ----------------------------------------------------------------


def test_persona_answers_probe_from_its_profile():
    p = PERSONAS[0]  # withholder: prefers locked-off static over handheld
    widget = {
        "kind": "preference_probe",
        "alt_a": {"label": "Locked-off static frame", "detail": {"movement": "locked-off static"}},
        "alt_b": {"label": "Handheld instability", "detail": {"movement": "handheld"}},
        "options": [{"value": "a"}, {"value": "b"}, {"value": "open"}],
    }

    class NoNoise:
        def random(self):
            return 1.0  # never trips the noise branch

    assert answer_probe(p, widget, NoNoise()) == "a"


def test_persona_answers_real_recall_probe_shape_from_labels():
    """The live probe (build_verification_probe) carries text only in option
    labels, not alt_a/alt_b dicts. The persona must still answer a/b, not tie
    to 'open' — otherwise the ledger can never corroborate."""
    from app.evolution.probes import build_verification_probe

    p = PERSONAS[0]  # withholder: prefers locked-off static over handheld
    question = {
        "question_id": "q-movement",
        "decision": "camera stillness under tension",
        "alt_a": {"label": "locked-off static frame"},
        "alt_b": {"label": "handheld instability"},
    }
    widget = build_verification_probe(question, swap=False)
    assert "alt_a" not in widget  # real widget shape: labels only

    class NoNoise:
        def random(self):
            return 1.0

    assert answer_probe(p, widget, NoNoise()) == "a"
    # order swap must not change the answer (value stays question-framed)
    assert answer_probe(p, build_verification_probe(question, swap=True), NoNoise()) == "a"


def test_persona_edits_script_toward_its_taste():
    p = PERSONAS[0]
    scheme = {"shots": [{"order": 1, "movement": "handheld instability, shaky"}]}
    ops = edit_toward_profile(p, scheme, tags=["8.3"])
    assert ops and ops[0]["field"] == "movement"
    assert "locked" in ops[0]["value"] or "static" in ops[0]["value"]


def test_persona_profile_text_is_ground_truth_not_system_input():
    p = PERSONAS[0]
    text = p.profile_text()
    assert "prefers" in text and len(ground_truth_pairs(p)) == len(p.profile)
