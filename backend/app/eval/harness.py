"""Runs the comparison: personas × conditions, over the real HTTP API.

Sessions are driven through the same endpoints the UI uses, so the experiment
exercises the deployed system rather than a reimplementation of it. Each
persona runs learning sessions (which populate, or in C0 do not populate, the
memory) and then held-out evaluation sessions whose adopted scripts are judged.

Matching is strict: the same persona, scene image, theme, and seed are used in
every condition, so a judged pair differs only in what the system remembered.
"""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from app.eval.judge import judge_diversity, judge_guardrails, judge_pairwise
from app.eval.metrics import (
    aggregate_pairwise,
    guardrail_verdict,
    interaction_cost,
    ledger_precision_recall,
    mean_rubric,
)
from app.eval.personas import Persona, ground_truth_pairs
from app.eval.simulate import answer_widgets, edit_toward_profile

logger = logging.getLogger(__name__)

CONDITIONS = ("off", "naive", "full")
MAX_ALIGN_ROUNDS = 6


@dataclass
class SessionResult:
    session_id: str
    condition: str
    theme: str
    brief: str = ""
    tags: list[str] = field(default_factory=list)
    directions: list[dict] = field(default_factory=list)
    draft: dict = field(default_factory=dict)
    adopted: dict = field(default_factory=dict)
    active_skill: dict | None = None
    cost: dict = field(default_factory=dict)
    error: str | None = None


class Harness:
    def __init__(self, base_url: str = "http://localhost:8000/api",
                 image: str | None = None, timeout: float = 1800.0):
        self.base = base_url.rstrip("/")
        self.image = image
        self.timeout = timeout

    # -- one session end to end ------------------------------------------------

    async def run_session(
        self, client: httpx.AsyncClient, persona: Persona, condition: str,
        theme: str, user_id: str, seed: int,
    ) -> SessionResult:
        rng = random.Random(seed)
        res = SessionResult(session_id="", condition=condition, theme=theme)
        try:
            files = {"image": ("scene.jpg", Path(self.image).read_bytes(), "image/jpeg")}
            data = {"raw_intent": theme, "user_id": user_id, "memory_mode": condition}
            turn = (await client.post(f"{self.base}/sessions", data=data, files=files)).json()
            res.session_id = turn["session_id"]

            # alignment loop
            rounds = 0
            while turn.get("phase") == "align" and rounds < MAX_ALIGN_ROUNDS:
                widgets = turn.get("widgets") or []
                if not widgets:
                    break
                answers, free_text = await answer_widgets(persona, widgets, rng)
                turn = (await client.post(
                    f"{self.base}/sessions/{res.session_id}/respond",
                    json={"dim_widget_responses": answers, "free_text": free_text},
                )).json()
                rounds += 1

            if turn.get("phase") != "confirm":
                res.error = f"did not converge (phase={turn.get('phase')})"
                return res
            res.brief, res.tags = turn.get("brief", ""), turn.get("tags", [])

            # a probe may be attached to the confirm gate
            probe_response = None
            probe = turn.get("probe")
            if probe:
                from app.eval.simulate import answer_probe, resolve_pref_probe

                if probe["kind"] == "skill_activation":
                    ans = answer_probe(persona, probe, rng)
                    probe_response = {"skill_activation": ans}
                else:
                    # Verification probes carry abstract design-language labels;
                    # resolve_pref_probe adds the semantic LLM fallback the sync
                    # token matcher can't (otherwise every answer ties to 'open'
                    # and the ledger never corroborates).
                    ans = await resolve_pref_probe(persona, probe, rng)
                    probe_response = {"question_id": probe["question_id"], "answer": ans}

            turn = (await client.post(
                f"{self.base}/sessions/{res.session_id}/confirm",
                json={"confirmed": True, "probe_response": probe_response},
            )).json()

            schemes = turn.get("schemes") or []
            if not schemes:
                res.error = "no schemes generated"
                return res
            res.active_skill = turn.get("active_skill")
            res.directions = [
                {"strategy": s.get("strategy"), "mechanism": s.get("mechanism")}
                for s in schemes
            ]

            # the persona picks the direction closest to its taste, then edits
            chosen = self._pick_scheme(persona, schemes, rng)
            res.draft = json.loads(json.dumps(chosen))
            ops = edit_toward_profile(persona, chosen, res.tags)
            if ops:
                await client.post(f"{self.base}/sessions/{res.session_id}/select",
                                  json={"scheme_id": chosen["scheme_id"], "action": "edit"})
                edited = (await client.post(
                    f"{self.base}/sessions/{res.session_id}/edit",
                    json={"patch": ops, "free_text": None},
                )).json()
                for s in edited.get("schemes") or []:
                    if s.get("scheme_id") == chosen["scheme_id"]:
                        chosen = s
            await client.post(f"{self.base}/sessions/{res.session_id}/select",
                              json={"scheme_id": chosen["scheme_id"], "action": "writeback"})
            res.adopted = chosen

            trace = await self._trace(client, res.session_id)
            res.cost = interaction_cost(trace, res.draft, res.adopted)
        except Exception as exc:  # a failed session is data, not a crash
            res.error = f"{type(exc).__name__}: {exc}"[:300]
            logger.warning("Session failed (%s/%s): %s", persona.persona_id, condition, exc)
        return res

    def _pick_scheme(self, persona: Persona, schemes: list[dict], rng: random.Random) -> dict:
        """Persona picks by taste — this is the comparative evidence channel."""
        from app.eval.simulate import _tokens

        best, best_score = schemes[0], -10**6
        for s in schemes:
            blob = json.dumps(s, ensure_ascii=False).lower()
            score = 0
            for e in persona.profile:
                score += sum(tok in blob for tok in _tokens(e.prefer))
                score -= sum(tok in blob for tok in _tokens(e.avoid))
            score += rng.random() * 0.5  # break ties without a fixed bias
            if score > best_score:
                best, best_score = s, score
        return best

    async def _trace(self, client: httpx.AsyncClient, session_id: str) -> list[dict]:
        """Session events, read straight from the store.

        The session endpoint intentionally does not expose the trace (it is
        telemetry, not UI state), so the harness reads it directly — the
        evaluation runs in-process alongside the backend.
        """
        try:
            from app.evolution import load_session_trace

            return await load_session_trace(session_id)
        except Exception:
            logger.debug("Trace unavailable for %s", session_id, exc_info=True)
            return []

    async def _ledger(self, client: httpx.AsyncClient, user_id: str) -> list[dict]:
        """Corroborated questions with their prevailing detail, for precision."""
        try:
            r = await client.get(f"{self.base}/users/{user_id}/memory")
            out = []
            for q in r.json().get("questions", []):
                if q.get("status") != "corroborated":
                    continue
                out.append({"scope_id": q.get("scope_id"),
                            "decision": q.get("decision"),
                            "prevailing_detail": q.get("prevailing_detail") or {}})
            return out
        except Exception:
            return []

    # -- full experiment -------------------------------------------------------

    async def run(self, personas: list[Persona], conditions: tuple[str, ...] = CONDITIONS,
                  n_learn: int = 3, n_eval: int = 2, seed: int = 7) -> dict[str, Any]:
        results: dict[str, dict[str, list[SessionResult]]] = {}
        ledgers: dict[str, dict] = {}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for persona in personas:
                results[persona.persona_id] = {}
                for cond in conditions:
                    # a fresh user per (persona, condition): no cross-arm leakage
                    user_id = f"eval-{persona.persona_id}-{cond}-{seed}"
                    themes = persona.learn_themes or ["A tense scene"]
                    for i in range(n_learn):
                        await self.run_session(client, persona, cond,
                                               themes[i % len(themes)], user_id, seed + i)
                    evals = []
                    held_out = persona.eval_themes or themes
                    for j in range(n_eval):
                        evals.append(await self.run_session(
                            client, persona, cond, held_out[j % len(held_out)],
                            user_id, seed + 100 + j))
                    results[persona.persona_id][cond] = evals
                    if cond == "full":
                        ledgers[persona.persona_id] = ledger_precision_recall(
                            await self._ledger(client, user_id), ground_truth_pairs(persona))
        return await self._judge_all(personas, results, ledgers, seed)

    async def _judge_all(self, personas: list[Persona], results: dict, ledgers: dict,
                         seed: int) -> dict[str, Any]:
        report: dict[str, Any] = {"personas": {}, "ledger": ledgers}
        for persona in personas:
            by_cond = results[persona.persona_id]
            entry: dict[str, Any] = {"pairwise": {}, "guardrails": {}, "cost": {}}

            for baseline in ("off", "naive"):
                if baseline not in by_cond or "full" not in by_cond:
                    continue
                verdicts = []
                for k, (treat, ctrl) in enumerate(zip(by_cond["full"], by_cond[baseline])):
                    if treat.error or ctrl.error or not treat.adopted or not ctrl.adopted:
                        continue
                    v = await judge_pairwise(persona.profile_text(), treat.brief,
                                             treat.adopted, ctrl.adopted, seed=seed + k * 7)
                    verdicts.append(v["verdict"])
                entry["pairwise"][f"full_vs_{baseline}"] = aggregate_pairwise(verdicts)

            for cond, sessions in by_cond.items():
                fid, craft, div = [], [], []
                for s in sessions:
                    if s.error or not s.adopted:
                        continue
                    g = await judge_guardrails(s.brief, s.tags, s.adopted)
                    if g.get("intent_fidelity"):
                        fid.append(g["intent_fidelity"])
                    if g.get("craft_coherence"):
                        craft.append(g["craft_coherence"])
                    if s.directions:
                        d = await judge_diversity(s.directions)
                        if d.get("diversity"):
                            div.append(d["diversity"])
                entry["guardrails"][cond] = {
                    "intent_fidelity": mean_rubric(fid),
                    "craft_coherence": mean_rubric(craft),
                    "diversity": mean_rubric(div),
                    "n_directions": [len(s.directions) for s in sessions if not s.error],
                    "_raw": {"intent_fidelity": fid, "craft_coherence": craft,
                             "diversity": div},
                }
                costs = [s.cost for s in sessions if s.cost]
                entry["cost"][cond] = {
                    "clarification_turns": mean_rubric(
                        [c["clarification_turns"] for c in costs]),
                    "edit_distance": mean_rubric([c["edit_distance"] for c in costs]),
                }

            if "off" in entry["guardrails"] and "full" in entry["guardrails"]:
                # pre-registered failure check: a taste gain bought with intent
                # fidelity (or diversity) is not a gain this paper claims
                entry["failure_check"] = {
                    axis: guardrail_verdict(
                        entry["guardrails"]["full"]["_raw"][axis],
                        entry["guardrails"]["off"]["_raw"][axis],
                    )
                    for axis in ("intent_fidelity", "diversity")
                }
            report["personas"][persona.persona_id] = entry
        return report
