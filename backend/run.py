"""Cross-platform development server entry point."""

from __future__ import annotations

import asyncio
import sys

import uvicorn


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        # Recent Uvicorn versions explicitly choose Proactor for a Windows
        # single-process server, overriding the policy above.  Psycopg async
        # requires Selector, so own the runner and its loop factory here.
        config = uvicorn.Config("app.main:app", host="0.0.0.0", port=8000)
        server = uvicorn.Server(config)
        with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
            runner.run(server.serve())
    else:
        uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
