"""Local file storage for user-uploaded reference images.

Files live in ``backend/uploads/`` (gitignored) and are served at
``/api/uploads/{filename}`` via StaticFiles (mounted in main.py).
后续生图 API 产出的镜头帧也落在这里。
"""

from __future__ import annotations

from pathlib import Path

UPLOADS_DIR = Path(__file__).resolve().parents[1] / "uploads"
UPLOADS_URL_PREFIX = "/api/uploads"

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB


def ensure_uploads_dir() -> Path:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    return UPLOADS_DIR


def save_reference_image(session_id: str, content: bytes, content_type: str) -> tuple[str, Path]:
    """Persist an uploaded image; returns (public_url, local_path).

    Raises ValueError for unsupported type or oversized payload.
    """
    ext = ALLOWED_IMAGE_TYPES.get(content_type)
    if ext is None:
        raise ValueError(f"Unsupported image type: {content_type} (JPEG/PNG/WebP only)")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError("Image exceeds the 10MB limit")
    if not content:
        raise ValueError("Image content is empty")

    ensure_uploads_dir()
    filename = f"{session_id}{ext}"
    path = UPLOADS_DIR / filename
    path.write_bytes(content)
    return f"{UPLOADS_URL_PREFIX}/{filename}", path
