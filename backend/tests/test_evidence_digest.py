"""Unit tests for deterministic trace preprocessing (ADR-0015).

``build_evidence_digest`` turns a raw event trace into structured evidence with
no LLM. The key behaviours: comparative evidence is always extracted, and the
"explore then revert" episode becomes negative (reverted) perceptual evidence
rather than being discarded.
"""

from __future__ import annotations

from app.evolution.reflect import build_evidence_digest


def _ev(session, event_type, payload):
    return {"session_id": session, "event_type": event_type, "payload": payload}


def test_comparison_extracted_from_candidate_select():
    trace = [
        _ev("s1", "candidate_select", {
            "selected": "A",
            "rejected": ["B", "C"],
            "directions": [
                {"id": "A", "name": "空间吞没", "mechanism": "渺小感"},
                {"id": "B", "name": "主观共情", "mechanism": "代入"},
                {"id": "C", "name": "疏离氛围", "mechanism": "凝滞"},
            ],
            "tags": ["6.2"],
            "brief": "孤独",
        }),
    ]
    d = build_evidence_digest(trace)
    assert d["tags"] == ["6.2"]
    assert len(d["comparisons"]) == 1
    comp = d["comparisons"][0]
    assert comp["selected"]["name"] == "空间吞没"
    assert {r["id"] for r in comp["rejected"]} == {"B", "C"}


def test_net_edit_collapses_multiple_edits():
    trace = [
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "shot_size",
                                          "from": "medium", "to": "wide"}]}),
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "shot_size",
                                          "from": "wide", "to": "extreme_wide"}]}),
    ]
    d = build_evidence_digest(trace)
    assert len(d["net_edits"]) == 1
    net = d["net_edits"][0]
    assert net["from"] == "medium" and net["to"] == "extreme_wide"


def test_perceptual_kept_when_no_edit_after_render():
    trace = [
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "shot_size",
                                          "from": "medium", "to": "wide"}]}),
        _ev("s1", "render_request", {"scheme_id": "A"}),
        _ev("s1", "adopt", {"scheme_id": "A"}),
    ]
    d = build_evidence_digest(trace)
    assert d["perceptual_verdicts"] == [
        {"shot_order": 1, "field": "shot_size", "verdict": "kept", "to": "wide"}
    ]


def test_perceptual_reverted_when_edited_after_render():
    # explore (wide) → render → change again (back to medium): reverted = negative evidence
    trace = [
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "shot_size",
                                          "from": "medium", "to": "wide"}]}),
        _ev("s1", "render_request", {"scheme_id": "A"}),
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "shot_size",
                                          "from": "wide", "to": "medium"}]}),
        _ev("s1", "adopt", {"scheme_id": "A"}),
    ]
    d = build_evidence_digest(trace)
    verdicts = d["perceptual_verdicts"]
    assert len(verdicts) == 1
    assert verdicts[0]["verdict"] == "reverted"


def test_no_perceptual_signal_without_render():
    trace = [
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 2, "field": "color_tone",
                                          "from": "warm", "to": "cool"}]}),
    ]
    d = build_evidence_digest(trace)
    assert d["perceptual_verdicts"] == []
    assert d["has_edits"] is True
    assert d["has_renders"] is False


def test_ui_flow_yields_all_three_channels_with_dedup():
    """采纳按钮打通后的真实 UI 事件流:比较/参数/知觉三通道齐全,
    且采纳流程两次经过 /select 的比较证据只算一次。"""
    dirs = [
        {"id": "A", "name": "Omniscient", "mechanism": "info asymmetry"},
        {"id": "B", "name": "Subjective", "mechanism": "immersion"},
    ]
    trace = [
        _ev("s1", "session_start", {}),
        # 用户编辑(渲染路径,已被白名单+no-op 过滤为真实改动)
        _ev("s1", "edit_patch", {"ops": [{"shot_order": 1, "field": "movement",
                                          "from": "缓慢推进", "to": "固定"}]}),
        _ev("s1", "render_request", {"scheme_id": "A"}),
        # 采纳:select(edit) → select(writeback),两条 candidate_select 同一选择
        _ev("s1", "candidate_select", {"selected": "A", "rejected": ["B"],
                                       "directions": dirs, "action": "edit",
                                       "tags": ["8.3"], "brief": "b"}),
        _ev("s1", "candidate_select", {"selected": "A", "rejected": ["B"],
                                       "directions": dirs, "action": "writeback",
                                       "tags": ["8.3"], "brief": "b"}),
        _ev("s1", "adopt", {"scheme_id": "A"}),
    ]
    d = build_evidence_digest(trace)
    # ① 比较证据:去重后一条
    assert len(d["comparisons"]) == 1
    assert d["comparisons"][0]["selected"]["id"] == "A"
    # ② 参数证据
    assert d["net_edits"] == [{"shot_order": 1, "field": "movement",
                               "from": "缓慢推进", "to": "固定"}]
    # ③ 知觉证据:改后渲染、之后未再改 → kept
    assert d["perceptual_verdicts"] == [
        {"shot_order": 1, "field": "movement", "verdict": "kept", "to": "固定"}
    ]
