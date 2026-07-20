"""The persona agent: plays a creator whose taste is fixed and undisclosed.

It answers alignment widgets and preference probes, then edits the produced
script toward its profile before adopting. Two properties matter for validity:

- the profile is never emitted as free text, so the system can only learn from
  choices — the same channel a real user provides;
- answers carry noise (``persona.noise``), so a run cannot succeed by assuming
  a perfectly consistent oracle.

Probe answers are resolved *deterministically* against the profile wherever the
alternatives name a parameter the profile speaks to; only genuinely ambiguous
widgets fall through to the LLM.
"""

from __future__ import annotations

import logging
import random
from typing import Any

from app.eval.personas import Persona
from app.graph.utils import parse_llm_json
from app.llm import get_llm_client

logger = logging.getLogger(__name__)


def _alt_text(alt: dict[str, Any]) -> str:
    detail = " ".join(f"{k}={v}" for k, v in (alt.get("detail") or {}).items())
    return f"{alt.get('label', '')} {detail} {alt.get('mechanism', '')}".lower()


def answer_probe(persona: Persona, widget: dict[str, Any], rng: random.Random,
                 scope_hint: str = "") -> str:
    """Answer a preference probe from the profile (deterministic when possible).

    Scores each alternative by how many profile 'prefer' phrases it echoes minus
    'avoid' phrases; a clear winner is chosen, a tie yields 'open'. Noise flips
    the answer with probability ``persona.noise`` so the ledger must survive
    inconsistency.
    """
    if widget.get("kind") == "skill_activation":
        # the persona wants its own taste applied, except under answer noise
        return "leave" if rng.random() < persona.noise else "apply"

    a_txt, b_txt = _alt_text(widget.get("alt_a") or {}), _alt_text(widget.get("alt_b") or {})
    if not a_txt.strip() and not b_txt.strip():
        opts = [o.get("value") for o in widget.get("options") or []]
        a_txt = str(opts[0] if opts else "")
        b_txt = str(opts[1] if len(opts) > 1 else "")

    score_a = score_b = 0
    for e in persona.profile:
        if scope_hint and e.scope not in ("global", scope_hint):
            continue
        for token in _tokens(e.prefer):
            score_a += token in a_txt
            score_b += token in b_txt
        for token in _tokens(e.avoid):
            score_a -= token in a_txt
            score_b -= token in b_txt

    if score_a == score_b:
        return "open"
    answer = "a" if score_a > score_b else "b"
    if rng.random() < persona.noise:
        answer = "b" if answer == "a" else "a"
    return answer


def _tokens(phrase: str) -> list[str]:
    return [w for w in phrase.lower().replace(",", " ").split() if len(w) > 3]


async def answer_widgets(
    persona: Persona, widgets: list[dict[str, Any]], rng: random.Random,
) -> tuple[dict[str, Any], str | None]:
    """Answer a round of alignment widgets in character.

    Probes are resolved from the profile; intent widgets go to an LLM playing
    the persona, which is told its taste but instructed never to state it
    outright — it must express itself through choices, like a real user.
    """
    responses: dict[str, Any] = {}
    intent_widgets = []
    for w in widgets:
        kind = w.get("kind")
        if kind == "preference_probe":
            responses[w["question_id"]] = answer_probe(persona, w, rng)
        elif kind == "skill_activation":
            responses["skill_activation"] = answer_probe(persona, w, rng)
        else:
            intent_widgets.append(w)

    if not intent_widgets:
        return responses, None

    system = (
        "You are role-playing a film creator answering a shot-planning assistant. "
        "Your cinematic taste is given below. Answer the questions AS THIS PERSON: "
        "pick the options your taste implies.\n\n"
        "Never quote or paraphrase your taste profile verbatim in free text — a real "
        "person expresses taste through choices, not by reciting preferences. Keep any "
        "free text to one short natural sentence about the scene.\n\n"
        'Output JSON: {"answers": {"<dim or widget key>": "<option value or text>"}, '
        '"free_text": "one short sentence or null"}'
    )
    user = (
        f"## Your taste (do not recite)\n{persona.profile_text()}\n\n"
        f"## Questions\n{intent_widgets}\n\n"
        "For single/multi widgets answer with the option 'value' (a code like 8.3); "
        "for slider/freetext answer with a short phrase. Key each answer by the "
        "widget's 'dim' when present."
    )
    try:
        raw = await get_llm_client().chat(system, user, temperature=0.3)
        data = parse_llm_json(raw, fallback={}, log_name="persona")
    except Exception:
        logger.warning("Persona answering failed; falling back to free text", exc_info=True)
        return responses, "Follow the mood of the scene; you decide the details."

    for k, v in (data.get("answers") or {}).items():
        responses[k] = v
    return responses, data.get("free_text")


def edit_toward_profile(
    persona: Persona, scheme: dict[str, Any], tags: list[str], limit: int = 2,
) -> list[dict[str, Any]]:
    """Edits a persona would make before adopting: push parameters to its taste.

    Returns patch ops for shots whose parameter contradicts the profile. This is
    the parametric-evidence channel a real user produces by editing, and it is
    capped so the persona does not rewrite the whole script.
    """
    ops: list[dict[str, Any]] = []
    scope = next((t for t in tags if any(e.scope == t for e in persona.profile)), "global")
    for shot in scheme.get("shots") or []:
        for e in persona.profile:
            if e.scope not in ("global", scope):
                continue
            current = str(shot.get(e.field) or "")
            if not current:
                continue
            avoids = any(tok in current.lower() for tok in _tokens(e.avoid))
            prefers = any(tok in current.lower() for tok in _tokens(e.prefer))
            if avoids and not prefers:
                ops.append({"shot_order": shot.get("order"), "field": e.field,
                            "value": e.prefer})
                break
        if len(ops) >= limit:
            break
    return ops
