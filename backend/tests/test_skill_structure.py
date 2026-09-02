"""Unit tests for the two-layer skill structure (ADR-0018):
workflow reasoning-chain steps, few-shot examples from the user's own
exemplars, reference back-pointers — layered over the ADR-0017 validation core.
"""

from __future__ import annotations

from app.evolution.skills import enact, select_examples, skill_prompt_section


def _q(qid, decision, prefer_field, prefer_value, avoid_value,
       mechanism=None, answers_sessions=("s1", "s2")):
    return {
        "question_id": qid,
        "scope_type": "intent_leaf",
        "scope_id": "8.3",
        "decision": decision,
        "alt_a": {
            "label": f"{prefer_value}派",
            "detail": {prefer_field: prefer_value},
            **({"mechanism": mechanism} if mechanism else {}),
        },
        "alt_b": {"label": f"{avoid_value}派", "detail": {prefer_field: avoid_value}},
        "answers": [{"session_id": s, "answer": "a"} for s in answers_sessions],
        "status": "corroborated",
    }


def _exemplar(rec_id, shots):
    return {"record_id": rec_id, "intent_tags": ["8.3"],
            "shot_script": {"shots": shots}, "provenance": "adopted_confirmed"}


# --- workflow layer -----------------------------------------------------------


def test_workflow_contains_ordered_stages():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进",
           mechanism="威胁半隐维持信息不对称")
    skill = enact([q])
    stages = [s["stage"] for s in skill["workflow"]]
    # strategy(排序) → detail(推理链) → review(自查); 无 plan hints 则无 plan 步
    assert stages == ["strategy", "detail", "review"]


def test_detail_step_carries_mechanism_chain():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进",
           mechanism="威胁半隐维持信息不对称")
    skill = enact([q])
    step = next(s for s in skill["workflow"] if s["stage"] == "detail")
    assert "威胁可见性" in step["instruction"]          # 决策轴
    assert "固定派" in step["instruction"]              # 倾向
    assert "威胁半隐维持信息不对称" in step["instruction"]  # 机制理由
    assert "movement=固定" in step["instruction"]        # 参数落点
    assert step["fields"] == ["movement"]


def test_detail_step_without_mechanism_still_valid():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进")  # no mechanism
    skill = enact([q])
    step = next(s for s in skill["workflow"] if s["stage"] == "detail")
    assert "机制:" not in step["instruction"]


# --- examples layer -----------------------------------------------------------


def test_examples_selected_from_matching_shots_only():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进")
    recs = [_exemplar("e1", [
        {"order": 1, "movement": "固定", "shot_size": "大远景", "serves": ["8.3"]},
        {"order": 2, "movement": "手持"},  # 不匹配,不入选
    ])]
    skill = enact([q], exemplar_records=recs)
    assert len(skill["examples"]) == 1
    ex = skill["examples"][0]
    assert ex["source"] == "e1"
    assert ex["shot"]["movement"] == "固定"
    assert "movement=固定" in ex["note"]
    assert "e1" in skill["reference"]["exemplar_ids"]


def test_examples_respect_limit_and_rank_by_match_count():
    q1 = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进")
    q2 = _q("q2", "色调", "color_tone", "低饱和冷调", "高反差",
            answers_sessions=("s3", "s4"))
    recs = [_exemplar("e1", [
        {"order": 1, "movement": "固定"},                                   # 1 匹配
        {"order": 2, "movement": "固定", "color_tone": "低饱和冷调"},        # 2 匹配 → 应排第一
        {"order": 3, "movement": "固定", "shot_size": "近景"},               # 1 匹配
    ])]
    skill = enact([q1, q2], exemplar_records=recs)
    assert len(skill["examples"]) == 2  # limit
    assert skill["examples"][0]["shot"].get("color_tone") == "低饱和冷调"  # 双匹配居首


def test_select_examples_empty_inputs():
    assert select_examples([], {"movement": "固定"}) == []
    assert select_examples([_exemplar("e1", [{"movement": "固定"}])], {}) == []


def test_no_exemplars_yields_empty_examples_not_failure():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进")
    skill = enact([q])  # exemplar_records omitted
    assert skill["examples"] == []
    assert skill["reference"]["question_ids"] == ["q1"]
    assert "8.3" in skill["reference"]["intent_codes"]


# --- validation core unchanged (backward compat) -------------------------------


def test_validation_layer_keys_preserved():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进")
    skill = enact([q])
    for key in ("strategy", "plan", "detail", "review",
                "source_question_ids", "applicability"):
        assert key in skill
    assert skill["detail"]["prefer"] == [{"field": "movement", "values": ["固定"]}]


# --- prompt rendering -----------------------------------------------------------


def test_prompt_section_renders_chain_and_examples():
    q = _q("q1", "威胁可见性", "movement", "固定", "缓慢推进",
           mechanism="威胁半隐维持信息不对称")
    recs = [_exemplar("e1", [{"order": 1, "movement": "固定", "serves": ["8.3"]}])]
    section = skill_prompt_section(enact([q], exemplar_records=recs))
    assert "威胁半隐维持信息不对称" in section     # 推理链进 prompt
    assert "few-shot" in section                  # 示例段
    assert "movement=固定" in section
    assert "intent fidelity > preference inertia" in section  # iron rule

def test_prompt_section_falls_back_for_legacy_skill():
    legacy = {
        "detail": {"prefer": [{"field": "movement", "values": ["固定"]}], "avoid": []},
        "plan": {}, "review": {"checks": []},
    }
    section = skill_prompt_section(legacy)
    assert "prefer movement: 固定" in section
