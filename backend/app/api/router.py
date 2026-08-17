"""Top-level API router that aggregates all sub-routers."""

from fastapi import APIRouter

from app.api.memory import memory_router
from app.api.sessions import sessions_router
from app.study import study_router

api_router = APIRouter()

api_router.include_router(sessions_router, prefix="/sessions", tags=["sessions"])
api_router.include_router(memory_router, prefix="/users", tags=["memory"])
api_router.include_router(study_router, prefix="/study", tags=["study"])
