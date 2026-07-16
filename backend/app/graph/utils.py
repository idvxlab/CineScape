"""Shared utility functions for graph nodes.

Consolidates common patterns to reduce duplication across 6+ node files:
- JSON parsing with fallback
- Message extraction from conversation history
"""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)


def parse_llm_json(
    result: str,
    fallback: dict | None = None,
    log_name: str = "node",
) -> dict:
    """Parse LLM response as JSON with safe fallback.

    The LLM client is configured with response_format={'type': 'json_object'},
    but malformed output can still occur.  Returns fallback (or empty dict)
    on failure.
    """
    try:
        data = json.loads(result)
        return data if isinstance(data, dict) else (fallback or {})
    except json.JSONDecodeError:
        pass

    # 容错:部分模型/网关(如 claude 经聚合网关)忽略 response_format,
    # 把 JSON 包在 ```json 围栏里或夹带前后缀文本——剥围栏、取最外层对象再试。
    text = result.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.rstrip().endswith("```"):
            text = text.rstrip()[: -3]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    logger.warning("%s received non-JSON response from LLM", log_name)
    logger.debug("Raw response (first 500 chars): %s", result[:500])
    return fallback or {}


def extract_last_user_input(messages: list) -> str:
    """Pull the most recent user message content from the message history.

    Works with LangChain BaseMessage objects (``.type == "human"``,
    add_messages 会把 dict 转成 HumanMessage)or raw dicts (``role == "user"``).
    Returns empty string if no user message found.
    """
    for msg in reversed(messages):
        if isinstance(msg, dict):
            role = msg.get("role") or msg.get("type")
            content = msg.get("content", "")
        else:
            role = getattr(msg, "type", None) or getattr(msg, "role", None)
            content = getattr(msg, "content", "")
        if role in ("user", "human"):
            return content if isinstance(content, str) else str(content)
    return ""


_KIND_ALIASES = {
    "single": "single",
    "radio": "single",
    "single_choice": "single",
    "select": "single",
    "multi": "multi",
    "checkbox": "multi",
    "multi_select": "multi",
    "multiselect": "multi",
    "slider": "slider",
    "scale": "slider",
    "range": "slider",
    "freetext": "freetext",
    "free_text": "freetext",
    "text": "freetext",
    "input": "freetext",
    "confirm": "confirm",
}


def normalize_widgets(raw_widgets: list) -> list[dict]:
    """Coerce LLM-produced widgets into the Widget protocol; drop invalid ones.

    LLM 偶尔会用近义字段(type/question/label),这里做归一化兜底,
    最终经 pydantic Widget 校验,失败的控件丢弃并告警。
    """
    from pydantic import TypeAdapter

    from app.schemas.widget import Widget

    adapter = TypeAdapter(Widget)
    normalized: list[dict] = []

    for raw in raw_widgets or []:
        if not isinstance(raw, dict):
            continue
        kind = _KIND_ALIASES.get(str(raw.get("kind") or raw.get("type") or "").lower())
        if kind is None:
            kind = "single" if raw.get("options") else "freetext"

        w: dict = {"kind": kind}
        prompt = raw.get("prompt") or raw.get("question") or raw.get("label") or ""

        if kind in ("single", "multi"):
            options = []
            for opt in raw.get("options") or []:
                if isinstance(opt, dict):
                    value = str(opt.get("value", opt.get("label", "")))
                    label = str(opt.get("label", value))
                    options.append({"value": value, "label": label, "hint": opt.get("hint")})
                else:
                    options.append({"value": str(opt), "label": str(opt)})
            w.update({"dim": str(raw.get("dim", "")), "prompt": prompt, "options": options})
        elif kind == "slider":
            ends = raw.get("ends") or raw.get("labels") or []
            ticks = raw.get("ticks")
            if len(ends) < 2 and ticks and len(ticks) >= 2:
                ends = [str(ticks[0]), str(ticks[-1])]
            if len(ends) < 2:
                logger.warning("Dropping slider widget without ends: %s", raw)
                continue
            w.update(
                {
                    "dim": str(raw.get("dim", "")),
                    "prompt": prompt,
                    "ends": (str(ends[0]), str(ends[1])),
                    "ticks": [str(t) for t in ticks] if ticks else None,
                }
            )
        elif kind == "freetext":
            w.update(
                {
                    "dim": raw.get("dim"),
                    "prompt": prompt,
                    "suggestions": [str(s) for s in raw.get("suggestions") or []],
                }
            )
        else:  # confirm
            w.update({"reflection": raw.get("reflection") or prompt})

        try:
            normalized.append(adapter.validate_python(w).model_dump())
        except Exception:
            logger.warning("Dropping invalid widget after normalization: %s", raw)

    return normalized


def format_widget_responses(
    dim_widget_responses: dict | None,
    free_text: str | None = None,
) -> str:
    """Serialize a widgets_response resume payload into one user message.

    The align LLM consumes plain text; values may be str or list[str].
    """
    parts: list[str] = []
    for dim, value in (dim_widget_responses or {}).items():
        rendered = "、".join(value) if isinstance(value, list) else str(value)
        parts.append(f"{dim}: {rendered}")
    text = "[控件回应] " + ";".join(parts) if parts else ""
    if free_text:
        text = f"{text}\n[自由补充] {free_text}" if text else f"[自由补充] {free_text}"
    return text or "(用户未作答)"
