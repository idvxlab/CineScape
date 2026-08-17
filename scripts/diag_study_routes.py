#!/usr/bin/env python3
"""Diagnose why /api/study routes are empty on the CineScape backend."""

import sys

sys.path.insert(0, "backend")

import app.api.router as router_mod  # noqa: E402
import app.study.api as study_api_mod  # noqa: E402

print("study_router in app.study.api:", study_api_mod.study_router)
print("study_router routes:", len(study_api_mod.study_router.routes))
for r in study_api_mod.study_router.routes:
    print("  study_api:", getattr(r, "path", r))

print()
print("api_router routes:", len(router_mod.api_router.routes))
for r in router_mod.api_router.routes:
    print("  router:", getattr(r, "path", r))
