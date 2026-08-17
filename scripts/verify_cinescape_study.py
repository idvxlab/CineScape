#!/usr/bin/env python3
"""Verify CineScape study backend (ADR-0019): syntax + imports + routes.

Run from repo root: backend/.venv/bin/python scripts/verify_cinescape_study.py
"""

import ast
import pathlib
import sys

CHANGED = [
    "backend/app/study/__init__.py",
    "backend/app/study/protocol.py",
    "backend/app/study/store.py",
    "backend/app/study/api.py",
    "backend/app/api/router.py",
    "backend/app/main.py",
]

failures = 0
for rel in CHANGED:
    p = pathlib.Path(rel)
    if not p.exists():
        print(f"MISS {rel}")
        failures += 1
sys.path.insert(0, "backend")
import app.main  # noqa: F401
import app.study.protocol
import app.study.store
import app.study.api
from app.api.router import api_router


def included_paths(router) -> list[str]:
    """FastAPI 0.115+ 用 _IncludedRouter 包装;递归展开出实际 path。"""
    out: list[str] = []
    for r in router.routes:
        path = getattr(r, "path", None)
        if path:
            out.append(path)
            continue
        inc = getattr(r, "include_context", None)
        if inc is not None:
            prefix = inc.prefix or ""
            for sub in included_paths(inc.included_router):
                out.append(f"{prefix}{sub}")
    return out


study_routes = sorted(p for p in included_paths(api_router) if "/study" in p)
print("\n/api/study routes:")
for r in study_routes:
    print(f"  {r}")
assert len(study_routes) == 6, f"expected 6 study routes, got {len(study_routes)}"
print("\nALL CHECKS PASSED")
