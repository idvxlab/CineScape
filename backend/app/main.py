"""FastAPI application entry-point with lifespan management.

Initializes DB pool, runs migrations, compiles the LangGraph with
AsyncPostgresSaver checkpointer on startup; tears down pool on shutdown.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.api.router import api_router
from app.db import close_pool, get_settings, init_database, init_pool
from app.graph import build_graph
from app.storage import ensure_uploads_dir


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize DB pool, run migrations, compile graph with checkpointer."""
    pool = await init_pool()
    await init_database()

    graph_builder = build_graph()
    # Keep checkpointer connection alive for the entire app lifespan
    async with AsyncPostgresSaver.from_conn_string(
        get_settings().database_url,
    ) as checkpointer:
        await checkpointer.setup()
        app.state.graph = graph_builder.compile(checkpointer=checkpointer)
        app.state.checkpointer = checkpointer
        app.state.db_pool = pool

        yield

    await close_pool()


app = FastAPI(title="Cinedesign API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    # also allow any localhost dev port (Vite bumps 5173 → 5174/5180 when taken)
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")

# 用户上传的基底图(及将来生图 API 的镜头帧)静态服务
app.mount("/api/uploads", StaticFiles(directory=ensure_uploads_dir()), name="uploads")


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness probe for container orchestration."""
    return {"status": "ok"}
