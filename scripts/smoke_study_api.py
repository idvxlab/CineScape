#!/usr/bin/env python3
"""Smoke-test CineScape study API end-to-end (participant create → plan).

Requires the CineScape backend running on :8000 with EVAL_ALLOW_FROZEN_ALIGNMENT=1.
"""

import json
import urllib.request

BASE = "http://localhost:8000/api/study"


def call(method: str, path: str, body: dict | None = None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


# 1. create participant P01 (idempotent)
status, p = call(
    "POST", "/participants", {"code": "P01", "literacy": "novice", "intent_code": "1.5"}
)
print(f"POST /participants → {status}")
print(
    f"  code={p.get('participant_code')} literacy={p.get('literacy')} intent={p.get('intent_code')} user_id={p.get('user_id')}"
)
assert status in (200, 201), p

pid = p["id"]

# 2. get plan
status, plan = call("GET", f"/participants/{pid}/plan")
print(f"\nGET /participants/{pid}/plan → {status}")
assert status == 200, plan
print(f"  learning runs: {len(plan['learning'])}")
for r in plan["learning"]:
    print(
        f"    run {r['run_index']}: {r['scene_id']} status={r['status']} img={r['reference_image']}"
    )
print(f"  heldout cases: {len(plan['heldout'])}")
for c in plan["heldout"]:
    print(
        f"    case {c['case_index']}: {c['scene_id']} order={c['condition_order']} status={c['status']} left={c['left']['label']} right={c['right']['label']}"
    )

print("\nALL STUDY API CHECKS PASSED")
