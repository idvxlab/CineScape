"""CLI for the memory evaluation (paper, Section "Evaluation").

Runs personas across memory conditions against a live backend and writes a
JSON report with taste win rates, guardrail scores, ledger precision, and the
pre-registered failure check.

    # backend must be running; judge should be a different model family
    export EVAL_JUDGE_MODEL=gpt-5.2
    python run_eval.py --image ../demo/input.jpeg --learn 3 --eval 2 --out report.json

Conditions: off (no memory) | naive (unverified recall) | full (ours).
A run with only `off,full` answers the primary question; adding `naive`
separates "verification helps" from "any memory helps".
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path

from app.db import close_pool, init_pool
from app.eval.harness import Harness
from app.eval.personas import PERSONAS, persona_by_id


async def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluate the evolutionary memory")
    ap.add_argument("--image", required=True, help="reference image every session starts from")
    ap.add_argument("--base-url", default="http://localhost:8000/api")
    ap.add_argument("--conditions", default="off,full",
                    help="comma-separated: off,naive,full")
    ap.add_argument("--personas", default="", help="comma-separated persona ids (default: all)")
    ap.add_argument("--learn", type=int, default=3, help="learning sessions per condition")
    ap.add_argument("--eval", type=int, default=2, help="held-out judged sessions")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="eval-report.json")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    personas = PERSONAS
    if args.personas:
        wanted = [persona_by_id(p.strip()) for p in args.personas.split(",")]
        personas = [p for p in wanted if p]
        if not personas:
            raise SystemExit("no matching personas")

    conditions = tuple(c.strip() for c in args.conditions.split(",") if c.strip())
    if not Path(args.image).exists():
        raise SystemExit(f"image not found: {args.image}")

    # the harness reads traces directly, so it needs the same pool the app uses
    await init_pool()
    try:
        harness = Harness(base_url=args.base_url, image=args.image)
        report = await harness.run(personas, conditions=conditions,
                                   n_learn=args.learn, n_eval=args.eval, seed=args.seed)
    finally:
        await close_pool()

    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(_summary(report), indent=2, ensure_ascii=False))
    print(f"\nfull report → {args.out}")


def _summary(report: dict) -> dict:
    """The three numbers that decide the claim."""
    out = {}
    for pid, entry in (report.get("personas") or {}).items():
        pair = entry.get("pairwise", {})
        guard = entry.get("guardrails", {})
        out[pid] = {
            "taste_win_rate": {k: round(v.get("win_rate", float("nan")), 3)
                               for k, v in pair.items()},
            "intent_fidelity": {c: round(g["intent_fidelity"].get("mean", float("nan")), 2)
                                for c, g in guard.items()},
            "failure_check": {k: v.get("degraded")
                              for k, v in (entry.get("failure_check") or {}).items()},
            "ledger": report.get("ledger", {}).get(pid, {}),
        }
    return out


if __name__ == "__main__":
    asyncio.run(main())
