"""Study protocol loader (ADR-0019, CineScape 载体).

评测素材来源:cinedesign 实验包的 skill-transfer-eval-v6-package 已复制到
``backend/study_assets/``(config.json / stimuli.json / assets/learning|heldout)。
场景参考图按需复制到 ``backend/uploads/study/`` 供 StaticFiles 服务。

素材维护:改 cinedesign 的 eval 包后需重新复制(cp -r 覆盖),或直接改
``backend/study_assets/`` 下的副本(与 cinedesign 不同步,以本仓库为准)。
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from app.storage import UPLOADS_DIR, UPLOADS_URL_PREFIX

logger = logging.getLogger(__name__)

#: 评测协议素材目录(本仓库内)
_ASSETS = Path(__file__).resolve().parents[2] / "study_assets"

LEARNING_SCENES = [f"learning-{i:02d}" for i in range(1, 11)]
HELDOUT_SCENES = [f"heldout-{i:02d}" for i in range(1, 21)]


def _load_json(name: str) -> dict:
    path = _ASSETS / name
    if not path.exists():
        logger.warning("Study protocol file missing: %s", path)
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Failed to parse %s", path)
        return {}


def load_protocol() -> dict:
    """Return {intents, intent_briefs, learning_scenes, heldout_scenes}."""
    config = _load_json("config.json")
    stimuli = _load_json("stimuli.json")
    return {
        "intents": config.get("intents", []),
        "intent_briefs": config.get("intent_briefs", {}),
        "learning_scenes": stimuli.get("learning_scenes", []),
        "heldout_scenes": stimuli.get("heldout_scenes", []),
    }


def intent_brief(intent_code: str, literacy: str) -> str:
    """意图 × 素养的 brief 文案;缺省回退到 intermediate / 意图 code。"""
    p = load_protocol()
    briefs = p["intent_briefs"].get(intent_code, {})
    return briefs.get(literacy) or briefs.get("intermediate") or intent_code


def scene_card(scene_id: str) -> str:
    """场景卡文本(learning/heldout 场景的 scene_card 或 title)。"""
    p = load_protocol()
    for s in p["learning_scenes"] + p["heldout_scenes"]:
        if s.get("scene_id") == scene_id:
            return s.get("scene_card") or s.get("title") or scene_id
    return scene_id


def scene_asset_path(scene_id: str) -> Path:
    """场景参考图本地路径(study_assets/assets/learning|heldout/{scene}.png)。"""
    folder = "learning" if scene_id.startswith("learning") else "heldout"
    return _ASSETS / "assets" / folder / f"{scene_id}.png"


def ensure_study_assets() -> None:
    """把评测素材图复制到 uploads/study/(幂等,跳过已存在)。

    StaticFiles 递归服务 uploads/,URL = /api/uploads/study/{scene_id}.png。
    """
    dest = UPLOADS_DIR / "study"
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for folder in ("learning", "heldout"):
        src_dir = _ASSETS / "assets" / folder
        if not src_dir.is_dir():
            logger.warning("Study assets dir missing: %s", src_dir)
            continue
        for img in sorted(src_dir.glob("*.png")):
            target = dest / img.name
            if not target.exists():
                shutil.copy2(img, target)
                copied += 1
    if copied:
        logger.info("Study assets prepared: %d images copied to uploads/study", copied)


def study_asset_url(scene_id: str) -> str:
    """场景参考图 URL(/api/uploads/study/{scene_id}.png)。"""
    return f"{UPLOADS_URL_PREFIX}/study/{scene_id}.png"
