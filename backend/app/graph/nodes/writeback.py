"""Writeback node — persist final shot script and session metadata.

Writes the approved shot script back to the database and updates
session status to 'completed'.
"""

import logging

from app.graph.state import SessionState
from app.llm import get_llm_client
from app.recall import writeback as writeback_func

logger = logging.getLogger(__name__)


async def writeback_node(state: SessionState) -> dict:
    """Persist the final shot script and mark session as completed.

    Writeback is non-critical (flywheel) — failure should not block the user.
    """
    selected = next(
        (c for c in state.candidates if c.get("scheme_id") == state.selected_scheme_id),
        None,
    )

    if selected and state.brief and state.tags:
        try:
            embedding = await get_llm_client().get_embedding(state.brief)
        except Exception:
            # 降级:无向量也回写,tags 过滤检索仍可用(语义排序待向量服务可用后补)
            logger.warning("Embedding failed, writing back without vector")
            embedding = None

        try:
            await writeback_func(
                intent_tags=state.tags,
                intent_brief=state.brief,
                embedding=embedding,
                shot_script=selected,
            )
            logger.info("Flywheel writeback done (embedding=%s)", embedding is not None)
        except Exception:
            logger.warning("Writeback failed (non-critical flywheel)", exc_info=True)

    return {"phase": "done"}
