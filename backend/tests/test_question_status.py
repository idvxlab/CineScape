"""Unit tests for the prevailing-answer state machine (ADR-0017).

Status is a pure function of the answer history via the prevailing (mode)
answer across distinct sessions. These tests pin the observed→tentative→
corroborated ladder, the tie-is-unsettled rule, and automatic reopening.
"""

from __future__ import annotations

from app.evolution.questions import (
    compute_status,
    fair_order_key,
    merge_vote,
    prevailing_answer,
)


def _ans(session, answer, source="probe"):
    return {"session_id": session, "answer": answer, "source": source}


# --- prevailing answer ------------------------------------------------------


def test_no_answers_is_none_and_observed():
    assert prevailing_answer([]) is None
    assert compute_status([]) == "observed"


def test_single_answer_is_tentative():
    a = [_ans("s1", "a")]
    assert prevailing_answer(a) == "a"
    assert compute_status(a) == "tentative"


def test_two_agreeing_sessions_corroborate():
    a = [_ans("s1", "a"), _ans("s2", "a")]
    assert compute_status(a) == "corroborated"


def test_repeated_answers_one_session_stay_tentative():
    # a user's repeated answers in one session are one vote, not two
    a = [_ans("s1", "a"), _ans("s1", "a"), _ans("s1", "a")]
    assert compute_status(a) == "tentative"


# --- behavioural votes weigh equally to probes (ADR-0017) -------------------


def test_behavioural_recurrence_corroborates_like_probes():
    # the same decision recurring (behaviour) across two sessions → corroborated,
    # no explicit probe needed
    a = [_ans("s1", "a", "behavior"), _ans("s2", "a", "behavior")]
    assert compute_status(a) == "corroborated"


def test_mixed_probe_and_behaviour_agree_corroborate():
    a = [_ans("s1", "a", "probe"), _ans("s2", "a", "behavior")]
    assert compute_status(a) == "corroborated"


def test_merge_probe_overwrites_same_session_vote():
    existing = [_ans("s1", "a", "behavior")]
    merged, changed = merge_vote(existing, "s1", "b", "probe")
    assert changed
    assert merged == [{"session_id": "s1", "answer": "b", "source": "probe"}]


def test_merge_behaviour_never_overwrites_a_settled_session():
    existing = [_ans("s1", "a", "probe")]
    merged, changed = merge_vote(existing, "s1", "b", "behavior")
    assert not changed
    assert merged == existing  # explicit vote stands, behaviour does not overrule


def test_merge_behaviour_adds_a_new_session_and_can_corroborate():
    existing = [_ans("s1", "a", "probe")]
    merged, changed = merge_vote(existing, "s2", "a", "behavior")
    assert changed
    assert compute_status(merged) == "corroborated"


def test_last_answer_within_session_wins():
    a = [_ans("s1", "a"), _ans("s1", "b")]
    assert prevailing_answer(a) == "b"


def test_tie_is_unsettled_observed():
    a = [_ans("s1", "a"), _ans("s2", "b")]
    assert prevailing_answer(a) is None
    assert compute_status(a) == "observed"


def test_strict_majority_wins_over_tie():
    a = [_ans("s1", "a"), _ans("s2", "a"), _ans("s3", "b")]
    assert prevailing_answer(a) == "a"
    assert compute_status(a) == "corroborated"  # 2 agree on 'a'


def test_disagreement_reopens_by_recompute():
    # corroborated on 'a', then two sessions flip to 'b' → prevailing flips
    a = [_ans("s1", "a"), _ans("s2", "a")]
    assert compute_status(a) == "corroborated"
    a += [_ans("s3", "b"), _ans("s4", "b")]  # 2 vs 2 → tie → unsettled
    assert compute_status(a) == "observed"
    a += [_ans("s5", "b")]  # 3 'b' vs 2 'a' → corroborated on 'b'
    assert prevailing_answer(a) == "b"
    assert compute_status(a) == "corroborated"


def test_open_can_itself_prevail():
    a = [_ans("s1", "open"), _ans("s2", "open")]
    assert prevailing_answer(a) == "open"
    assert compute_status(a) == "corroborated"


# --- fair ordering ----------------------------------------------------------


def test_fair_order_tentative_before_observed_before_corroborated():
    """lever-2: finish questions already under way before opening new ones."""
    observed = {"status": "observed", "answers": [], "user_flag": "none"}
    tentative = {"status": "tentative", "answers": [_ans("s1", "a")], "user_flag": "none"}
    corrob = {"status": "corroborated",
              "answers": [_ans("s1", "a"), _ans("s2", "a")], "user_flag": "none"}
    ordered = sorted([corrob, observed, tentative], key=fair_order_key)
    assert [q["status"] for q in ordered] == ["tentative", "observed", "corroborated"]


def test_fair_order_closest_to_corroboration_first_within_tier():
    # Among tentatives, the one nearer the >=2-answer threshold is finished first.
    q_far = {"status": "tentative", "answers": [_ans("s1", "a")], "user_flag": "none"}
    q_near = {"status": "tentative",
              "answers": [_ans("s1", "a"), _ans("s2", "b")], "user_flag": "none"}
    ordered = sorted([q_far, q_near], key=fair_order_key)
    assert ordered[0] is q_near


def test_emphasized_pulled_forward():
    plain = {"status": "observed", "answers": [], "user_flag": "none"}
    emphasized = {"status": "corroborated",
                  "answers": [_ans("s1", "a"), _ans("s2", "a")], "user_flag": "emphasized"}
    ordered = sorted([plain, emphasized], key=fair_order_key)
    assert ordered[0]["user_flag"] == "emphasized"
