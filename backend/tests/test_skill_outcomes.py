"""Unit tests for per-stage skill-outcome helpers and critic soft checks
(ADR-0017 gap fixes)."""

from __future__ import annotations

from app.evolution.skills import evaluate_skill_adoption, preferred_values
from app.llm.prompts import PromptBuilder


def _skill():
    return {
        "detail": {
            "prefer": [
                {"field": "movement", "values": ["固定"]},
                {"field": "color_tone", "values": ["低饱和冷调"]},
            ],
            "avoid": [{"field": "movement", "values": ["缓慢推进"]}],
        },
        "review": {"checks": ["是否体现:威胁半隐"]},
        "source_question_ids": ["q1", "q2"],
    }


# --- preferred_values --------------------------------------------------------


def test_preferred_values_flattens_prefer_rules():
    assert preferred_values(_skill()) == {"movement": "固定", "color_tone": "低饱和冷调"}


def test_preferred_values_none_skill_is_empty():
    assert preferred_values(None) == {}
    assert preferred_values({}) == {}


# --- evaluate_skill_adoption --------------------------------------------------


def test_adoption_consumed_when_any_shot_carries_preferred_value():
    shots = [
        {"order": 1, "movement": "固定", "color_tone": "暖橙"},
        {"order": 2, "movement": "手持", "color_tone": "低饱和冷调"},
    ]
    out = evaluate_skill_adoption(_skill(), shots)
    assert sorted(out["consumed"]) == ["color_tone", "movement"]
    assert out["ignored"] == []


def test_adoption_ignored_when_no_shot_carries_it():
    shots = [{"order": 1, "movement": "手持", "color_tone": "暖橙"}]
    out = evaluate_skill_adoption(_skill(), shots)
    assert sorted(out["ignored"]) == ["color_tone", "movement"]
    assert out["consumed"] == []


def test_adoption_empty_inputs():
    assert evaluate_skill_adoption(None, []) == {"consumed": [], "ignored": []}
    assert evaluate_skill_adoption(_skill(), []) == {
        "consumed": [],
        "ignored": ["movement", "color_tone"],
    }


# --- critic soft checks --------------------------------------------------------


def test_critic_prompt_includes_soft_checks_when_given():
    _, user = PromptBuilder.critic({}, {}, "", "", skill_checks=["是否体现:威胁半隐"])
    assert "偏好软检查" in user
    assert "是否体现:威胁半隐" in user


def test_critic_prompt_omits_section_without_checks():
    _, user = PromptBuilder.critic({}, {}, "", "", skill_checks=None)
    assert "偏好软检查" not in user
    _, user = PromptBuilder.critic({}, {}, "", "", skill_checks=[])
    assert "偏好软检查" not in user


def test_critic_system_marks_soft_checks_non_failing():
    system, _ = PromptBuilder.critic({}, {}, "", "", skill_checks=["x"])
    assert "不能作为 passed=false 的依据" in system
