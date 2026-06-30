"""Top-level API router that aggregates all sub-routers."""

from fastapi import APIRouter

from app.api.sessions import sessions_router

api_router = APIRouter()

api_router.include_router(sessions_router, prefix="/sessions", tags=["sessions"])
