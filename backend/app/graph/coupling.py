"""Hardcoded parameter coupling rule checker.

Implements ADR-0009: spatial/temporal/tonal coupling rules as deterministic code.

Spatial group: shot_size, focal_length, depth_of_field, composition, angle
Temporal group: movement, rhythm, duration
Tonal group: lighting, color_tone
"""

from __future__ import annotations

from pydantic import BaseModel


class CouplingIssue(BaseModel):
    shot_order: int
    field: str
    message: str


def check_spatial_coupling(shot_order: int, shot: dict) -> list[CouplingIssue]:
    """Check spatial parameter group compatibility.

    Rules:
    - 长焦(telephoto) + 广角景别(wide/全景) = conflict
      (long lens compresses space, wide shot needs depth)
    - 浅景深(shallow DOF) + 全景景别(wide shot) = unlikely
      (shallow DOF at wide is hard)
    - 深景深(deep DOF) + 特写(close-up) = unusual but possible
    """
    issues: list[CouplingIssue] = []
    shot_size = shot.get("shot_size", "")
    focal_length = shot.get("focal_length", "")
    depth_of_field = shot.get("depth_of_field", "")

    # Long focal length + wide shot size
    if ("长焦" in focal_length or "tele" in focal_length.lower()) and (
        "广角" in shot_size or "wide" in shot_size.lower() or "全景" in shot_size
    ):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="shot_size/focal_length",
                message="长焦镜头与广角/全景景别不兼容：长焦压缩空间，广角强调纵深",
            )
        )

    # Shallow DOF + wide shot
    if ("浅" in depth_of_field or "shallow" in depth_of_field.lower()) and (
        "全景" in shot_size or "广角" in shot_size or "wide" in shot_size.lower()
    ):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="depth_of_field/shot_size",
                message="浅景深在全景/广角景别上难以实现（需要极大光圈或特殊设备）",
            )
        )

    # Deep DOF + extreme close-up
    if ("深" in depth_of_field or "deep" in depth_of_field.lower()) and (
        "特写" in shot_size or "大特写" in shot_size or "close" in shot_size.lower()
    ):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="depth_of_field/shot_size",
                message="深景深在特写景别上不自然：背景细节被过度强调，分散主体注意力",
            )
        )

    return issues


def check_temporal_coupling(shot_order: int, shot: dict) -> list[CouplingIssue]:
    """Check temporal parameter group compatibility.

    Rules:
    - 静止运镜(static/fixed) + 急促节奏(rhythm=rapid) = conflict
    - 快速运镜(rapid movement) + 舒缓节奏(rhythm=calm) = conflict
    """
    issues: list[CouplingIssue] = []
    movement = shot.get("movement", "")
    rhythm = shot.get("rhythm", "")

    # Static camera + rapid rhythm
    if (
        "固定" in movement
        or "静止" in movement
        or "static" in movement.lower()
        or "fixed" in movement.lower()
    ) and ("急促" in rhythm or "快速" in rhythm or "rapid" in rhythm.lower()):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="movement/rhythm",
                message="固定/静止运镜与急促节奏不协调：固定镜头缺乏内部运动支撑快节奏",
            )
        )

    # Rapid movement + slow rhythm
    if (
        "摇" in movement
        or "移" in movement
        or "手持" in movement
        or "pan" in movement.lower()
        or "rapid" in movement.lower()
    ) and (
        "舒缓" in rhythm
        or "缓慢" in rhythm
        or "慢" in rhythm
        or "slow" in rhythm.lower()
        or "calm" in rhythm.lower()
    ):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="movement/rhythm",
                message="快速/运动运镜与舒缓节奏不匹配：镜头运动本身蕴含节奏张力",
            )
        )

    return issues


def check_tonal_coupling(shot_order: int, shot: dict) -> list[CouplingIssue]:
    """Check tonal parameter group compatibility.

    Rules:
    - 高对比(high-contrast lighting) + 柔和色彩(soft/pastel color) = clash
    - 暖调(warm lighting) + 冷色(cool color tone) = conflict (warning-level)
    - 硬光(hard lighting) + 柔和色彩(soft pastel) = unlikely
    """
    issues: list[CouplingIssue] = []
    lighting = shot.get("lighting", "")
    color_tone = shot.get("color_tone", "")

    # High contrast / hard lighting + soft/pastel color
    if (
        "高对比" in lighting
        or "硬" in lighting
        or "hard" in lighting.lower()
        or "high contrast" in lighting.lower()
    ) and ("柔和" in color_tone or "pastel" in color_tone.lower() or "soft" in color_tone.lower()):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="lighting/color_tone",
                message="高对比/硬光与柔和色彩在视觉情绪上矛盾：硬光产生强烈阴影与固态感，柔和色彩则削弱对比",
            )
        )

    # Warm lighting + cool color (warning-level, not auto-fail)
    if ("暖" in lighting or "warm" in lighting.lower()) and (
        "冷" in color_tone or "cool" in color_tone.lower() or "冷调" in color_tone
    ):
        issues.append(
            CouplingIssue(
                shot_order=shot_order,
                field="lighting/color_tone",
                message="暖调光影与冷色偏存在色调冲突——除非意图是混合/矛盾色调",
            )
        )

    return issues


def check_all_couplings(shots: list[dict]) -> list[CouplingIssue]:
    """Run all coupling checks on a list of shots.

    Returns list of all issues found.

    Used by critic_node before calling LLM for intent fidelity check.
    """
    all_issues: list[CouplingIssue] = []
    for shot in shots:
        order = shot.get("order", 0)
        all_issues.extend(check_spatial_coupling(order, shot))
        all_issues.extend(check_temporal_coupling(order, shot))
        all_issues.extend(check_tonal_coupling(order, shot))
    return all_issues
