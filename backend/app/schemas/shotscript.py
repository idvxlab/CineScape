"""Shot script schema — generated output with ten parameters per shot.

ADR-0006 confirms the ten-parameter standard:
景别, 构图, 角度, 运镜, 焦距, 景深, 光影, 色彩, 节奏, 时长.

ADR-0010 (pure reasoning): scripts are anchored to the design space itself —
each shot declares which sub-intents it serves (``serves``), and each scheme
declares its dominant intents and the mechanism chain it rides on, replacing
the former exemplar anchoring.
"""

from __future__ import annotations

from pydantic import BaseModel


class Shot(BaseModel):
    """A single shot described by ten parameters."""

    order: int
    shot_size: str
    composition: str
    angle: str
    movement: str
    focal_length: str
    depth_of_field: str
    lighting: str
    color_tone: str
    rhythm: str
    duration: str
    serves: list[str] = []  # 本镜服务的二级意图 code,critic 据此查机制链
    rationale: str
    # -- 生图/生视频渲染接入点(用户基底图 → 图像编辑逐镜呈现 → 图生视频) --
    frame_edit_hint: str = ""  # 从基底图到本镜画面的图像编辑指令(有基底图时产出)
    frame_image: str | None = None  # 关键帧 URL(即梦 image2image 渲染后填充)
    frame_video: str | None = None  # 镜头视频 URL(即梦 image2video 渲染后填充)


class ShotScript(BaseModel):
    """Complete shot script for one generation direction (A/B/C)."""

    scheme_id: str
    strategy: str
    dominant_intents: list[str] = []  # 该方向的主导二级意图 code
    mechanism: str = ""  # 该方向依赖的核心心理/知觉机制(一段)
    shots: list[Shot]
    overall_rationale: str
    # 全能参考(multimodal2video)把全方案关键帧合成的一段连贯多镜头视频 URL
    scheme_video: str | None = None
