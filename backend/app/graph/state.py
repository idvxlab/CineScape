"""Session state definition for the LangGraph state graph.

SessionState is the single mutable object that flows through every node
in the alignment → generation pipeline.  It is persisted via
PostgresSaver checkpoints so that human-in-the-loop interrupts can
resume seamlessly.

Fields use Annotated reducers where incremental merging is needed
(messages, candidates, dimensions).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from langgraph.graph import add_messages
from pydantic import BaseModel, Field

from app.schemas.recall import RecallRecord
from app.schemas.session import Conflict


def reduce_candidates(current: list | None, update: list | None) -> list:
    """Upsert candidates by scheme_id — used by parallel Send() fan-out.

    Regenerated schemes replace their previous version instead of
    accumulating duplicates.
    """
    if current is None:
        current = []
    if not update:
        return current
    merged: dict[str, dict] = {c.get("scheme_id", str(i)): c for i, c in enumerate(current)}
    for cand in update:
        merged[cand.get("scheme_id", str(len(merged)))] = cand
    return list(merged.values())


def merge_dimensions(current: dict | None, update: dict | None) -> dict:
    """Shallow-merge dimension updates (dim_id → state dict)."""
    if current is None:
        current = {}
    if update is None:
        return current
    return {**current, **update}


class SessionState(BaseModel):
    """Mutable state carried across all graph nodes.

    Annotated fields use reducers so that parallel fan-out and
    incremental dimension updates merge correctly.
    """

    # -- user input --
    raw_intent: str = ""
    user_id: str = "anonymous"  # ADR-0017: 个人偏好层的归属;匿名会话不做个性化
    # 实验开关(Evaluation §Design):外环的三个条件臂。
    #   "full"  = 完整机制(探针裁决 + 已确证问题 enact 成 skill)
    #   "naive" = 无验证记忆(过往采纳稿蒸馏成风格便签直接注入,不探针不确证不可撤销)
    #   "off"   = 无记忆(每会话冷启动)
    memory_mode: str = "full"
    reference_image: str | None = None  # 用户上传的基底图 URL(/api/uploads/..)
    image_brief: str | None = None  # 基底图的视觉描述(VLM 产出,可为空)

    # -- evolutionary memory (ADR-0017: 偏好问题探针/会话级 skill,匿名或库空时零影响) --
    recalled_questions: list[dict[str, Any]] = Field(default_factory=list)  # 召回的适用问题
    probed: bool = False  # 本会话是否已抛过探针(每会话至多一条,防打扰)
    active_skill: dict[str, Any] | None = None  # 用户激活的会话级 workflow skill(视图)

    # -- alignment phase --
    dimensions: Annotated[dict[str, Any], merge_dimensions] = Field(default_factory=dict)
    key_dimensions: list[str] = Field(default_factory=list)
    brief: str | None = None
    tags: list[str] = Field(default_factory=list)
    reflection: str | None = None
    reasoning_trace: str | None = None  # 模型思考过程(reasoning_content),展示用,已截断
    pending_widgets: list[dict[str, Any]] = Field(default_factory=list)
    converged: bool = False

    # -- optional retrieval enrichment (ADR-0010: 纯推理为基线,检索为增强) --
    exemplars: list[RecallRecord] = Field(default_factory=list)
    recall_signal: Literal["rich", "thin", "empty"] = "empty"

    # -- generation phase --
    directions: list[dict[str, Any]] = Field(default_factory=list)
    current_direction: dict[str, Any] | None = None  # set by Send() per branch
    candidates: Annotated[list[dict[str, Any]], reduce_candidates] = Field(default_factory=list)
    critic_feedback: dict[str, str] = Field(default_factory=dict)  # scheme_id → 修订意见
    regen_count: int = 0  # critic 重生成轮数(上限防死循环)

    # -- edit phase --
    selected_scheme_id: str | None = None
    conflicts: list[Conflict] = Field(default_factory=list)

    # -- conversation history (LangGraph message reducer) --
    messages: Annotated[list, add_messages] = Field(default_factory=list)

    # -- progress tracking --
    phase: Literal[
        "align", "confirm", "strategy", "generate", "candidates", "edit", "writeback", "done"
    ] = "align"

    model_config = {"arbitrary_types_allowed": True}
