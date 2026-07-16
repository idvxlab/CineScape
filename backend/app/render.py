"""Keyframe rendering + shot animation — 即梦 (Dreamina) CLI 接入。

ADR-0012:以用户上传的基底图为起点,逐镜渲染关键帧;再以关键帧为首帧做图生视频。

两段式产线(均走本地 `dreamina` CLI,异步 submit + 轮询 query_result):
  1. 关键帧(image2image):基底图 + 编辑指令(5 个静态维度)→ 每镜关键帧 PNG。
     逻辑同 ADR-0012 原 qwen 图生图,仅把网关 HTTP 换成即梦 CLI 写法。
  2. 图生视频(multimodal2video「全能参考」):方案全部关键帧按 order 顺序作参考图 +
     一个带时间轴(第几秒~第几秒是哪镜)与镜头衔接说明的整合 prompt + 总时长
     → 一段连贯的多镜头视频 MP4(整方案一个,不再逐镜各一段)。

结果取值:query_result 的 result_json.images[].image_url / videos[].video_url
(TOS 带时效签名 URL),必须立即下载落盘。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import shutil
from pathlib import Path

import httpx

from app.storage import UPLOADS_DIR, UPLOADS_URL_PREFIX, ensure_uploads_dir

logger = logging.getLogger(__name__)

#: 同时渲染的镜头数上限(防限流 / 控制额度消耗节奏)
RENDER_CONCURRENCY = 2
#: 视频串行(账号并发上限低,且视频慢/贵,逐个更稳)
VIDEO_CONCURRENCY = 1
RENDER_TIMEOUT_S = 300  # 媒体下载超时

# —— 即梦 CLI 配置 ——
DREAMINA_BIN = (
    os.environ.get("DREAMINA_BIN")
    or shutil.which("dreamina")
    or str(Path.home() / ".local" / "bin" / "dreamina")
)
#: image2image 模型版本(4.0/4.1/4.5/4.6/5.0);空=用 CLI 默认
DREAMINA_IMAGE_MODEL = os.environ.get("DREAMINA_IMAGE_MODEL", "5.0")  # 显式钉最新版:编辑遵循度最强;留空会走 CLI 默认(偏旧/保守、改动不够)
#: image2video 模型版本。必须显式指定:即梦默认路径在本账号鉴权失败(ret=1015 login error)。
#: 用 seedance2.0fast_vip(旗舰快速版);可选 3.0/3.0fast/3.0pro/3.5pro/seedance2.0 家族。
DREAMINA_VIDEO_MODEL = os.environ.get("DREAMINA_VIDEO_MODEL", "seedance2.0fast_vip")
DREAMINA_VIDEO_RESOLUTION = os.environ.get("DREAMINA_VIDEO_RESOLUTION", "720p")

# —— OpenAI 兼容生图分支(可选) ——
# IMAGE_API_STYLE=openai 时,关键帧编辑改走 OpenAI images/edits(如 gpt-image-2,
# 经聚合网关);默认 dreamina 走即梦 CLI。视频路径不受影响(仍即梦)。
# 注意经 LLMSettings 读取(.env 生效);os.environ 仅作 key/base 的显式覆盖。

_CALL_TIMEOUT_S = 150     # 单次 CLI 调用上限
_POLL_INTERVAL_S = 3      # query_result 轮询间隔
_IMAGE_WAIT_S = 180       # 关键帧整体等待上限
_VIDEO_WAIT_S = 360       # 单镜图生视频整体等待上限(视频更慢)
_SCHEME_VIDEO_WAIT_S = 600  # 全能参考整方案视频等待上限(多图上传 + 长视频,更慢)
_MULTIMODAL_IMAGE_MAX = 9   # multimodal2video 参考图上限(CLI: image<=9)
_SCHEME_VIDEO_MAX_S = 15    # multimodal2video 单次总时长上限(即梦: duration 4-15s)
_SUBMIT_RETRIES = 6       # 提交阶段瞬时失败(上传/DNS/网络抖动)的重试次数;
                          # 本地图上传到字节 ImageX 约 50% flaky,每次重试=全新 DNS 解析,6 次失败率~1.5%

# 瞬时失败特征(上传/DNS/网络),命中则重试而非整镜失败
_TRANSIENT_HINTS = (
    "no such host", "dial tcp", "upload image", "upload resource", "no file upload",
    "timeout", "timed out", "connection reset", "connection refused", "EOF",
    "i/o timeout", "temporarily unavailable", "ApplyImageUpload",
    "login error", "ret=1015", "ExceedConcurrencyLimit", "ret=1310",
)


def _is_transient(reason: str) -> bool:
    low = (reason or "").lower()
    return any(h.lower() in low for h in _TRANSIENT_HINTS)


class RenderError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 即梦 CLI 封装
# ---------------------------------------------------------------------------
async def _run_dreamina(args: list[str]) -> dict:
    """跑一条 dreamina 子命令,解析 stdout JSON 返回。"""
    env = dict(os.environ)
    env["PATH"] = f"{Path.home() / '.local' / 'bin'}:{env.get('PATH', '')}"
    proc = await asyncio.create_subprocess_exec(
        DREAMINA_BIN, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=_CALL_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        raise RenderError(f"dreamina {args[0]} 调用超时({_CALL_TIMEOUT_S}s)")

    text = out.decode("utf-8", "replace").strip()
    data = _extract_json(text)
    if data is None:
        tail = text[-300:] or err.decode("utf-8", "replace")[-300:]
        raise RenderError(f"dreamina {args[0]} 输出无法解析: {tail}")
    return data


_RESULT_KEYS = ("submit_id", "gen_status", "result_json", "total_credit", "user_id")


def _extract_json(text: str) -> dict | None:
    """从夹杂日志行(可能含花括号)的输出里抓出结果 JSON。

    CLI 偶尔在干净 JSON 前打一行带 {} 的日志,故不能用「首{到末}」粗暴截取。
    扫描每个 '{' 用 raw_decode 尝试解析,取最后一个含结果键的对象。
    """
    dec = json.JSONDecoder()
    candidates: list[dict] = []
    idx = 0
    n = len(text)
    while idx < n:
        start = text.find("{", idx)
        if start == -1:
            break
        try:
            obj, end = dec.raw_decode(text, start)
            if isinstance(obj, dict):
                candidates.append(obj)
            idx = max(end, start + 1)
        except json.JSONDecodeError:
            idx = start + 1
    if not candidates:
        return None
    for obj in reversed(candidates):
        if any(k in obj for k in _RESULT_KEYS):
            return obj
    return candidates[-1]


def _fail_message(data: dict) -> str:
    reason = str(data.get("fail_reason") or "未知原因")
    if "AigcComplianceConfirmationRequired" in reason:
        return "即梦该模型首次使用需在 Dreamina 网页端完成授权确认,请完成后重试"
    return f"即梦生成失败: {reason}"


def _extract_media_url(data: dict, kind: str) -> str | None:
    """kind='images'→image_url / 'videos'→video_url;无结果返回 None(尚未完成)。"""
    items = (data.get("result_json") or {}).get(kind) or []
    key = "image_url" if kind == "images" else "video_url"
    for item in items:
        if item.get(key):
            return item[key]
    return None


async def _submit_and_wait(submit_args: list[str], kind: str, wait_s: int) -> str:
    """提交异步任务并轮询至产出媒体 URL。

    判成功:gen_status 非 fail 且 result_json 出现媒体(SKILL.md 规则)。
    """
    # 提交阶段:对瞬时上传/DNS/网络失败自动重试
    sub: dict = {}
    for attempt in range(_SUBMIT_RETRIES):
        sub = await _run_dreamina(submit_args + ["--poll=0"])
        if sub.get("gen_status") == "fail":
            reason = str(sub.get("fail_reason") or "")
            if _is_transient(reason) and attempt < _SUBMIT_RETRIES - 1:
                logger.warning("即梦提交瞬时失败,第 %d/%d 次重试: %s", attempt + 1, _SUBMIT_RETRIES, reason[:140])
                await asyncio.sleep(1.5 + attempt * 0.5)
                continue
            raise RenderError(_fail_message(sub))
        break

    submit_id = sub.get("submit_id")
    url = _extract_media_url(sub, kind)
    if url:
        return url
    if not submit_id:
        raise RenderError(f"即梦未返回 submit_id: {str(sub)[:200]}")

    loop = asyncio.get_event_loop()
    deadline = loop.time() + wait_s
    while loop.time() < deadline:
        await asyncio.sleep(_POLL_INTERVAL_S)
        res = await _run_dreamina(["query_result", f"--submit_id={submit_id}"])
        if res.get("gen_status") == "fail":
            raise RenderError(_fail_message(res))
        url = _extract_media_url(res, kind)
        if url:
            return url
    raise RenderError(f"即梦任务超时({wait_s}s) submit_id={submit_id}")


async def _download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=RENDER_TIMEOUT_S, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


# ---------------------------------------------------------------------------
# 镜头指令合成
# ---------------------------------------------------------------------------
#: 景别由近到远的粗粒度档位(用于判断相邻镜头景别跨度,决定是否链式)。
#: 含子串覆盖关系的(大特写⊃特写、中近⊃中景)必须更具体的排在前。
_SIZE_RANK_RULES: list[tuple[tuple[str, ...], int]] = [
    (("大特写", "extreme close"), 0),
    (("中近", "medium close"), 2),       # 须在 特写/medium 之前(英文子串覆盖)
    (("特写", "close-up", "closeup", "close up"), 1),
    (("中全", "medium full", "medium wide"), 4),  # 须在 中景/medium 之前
    (("大远", "extreme wide", "very wide"), 6),
    (("全景", "远景", "wide", "long shot"), 5),
    (("中景", "medium", "mid-shot", "mid shot"), 3),  # 兜底:其余 medium → 中景
]


def _size_rank(text: str) -> int:
    """从景别文本抽出粗档位(0 大特写 … 6 大远景);无法识别按中景 3。"""
    t = (text or "").lower()
    for keys, rank in _SIZE_RANK_RULES:
        if any(k in t for k in keys):
            return rank
    return 3


def _shot_instruction(shot: dict, chained: bool = False) -> str:
    """关键帧(图生图)编辑指令:优先 frame_edit_hint,否则由静态维度合成。
    chained=True(链式承接):以上一镜画面延续光线气氛/色调,但仍按本镜镜头语言重新取景。"""
    hint = (shot.get("frame_edit_hint") or "").strip()
    body = hint or (
        f"以电影摄影方式重摄此画面:景别{shot.get('shot_size', '')},"
        f"机位角度{shot.get('angle', '')},构图{shot.get('composition', '')},"
        f"光影{shot.get('lighting', '')},色彩{shot.get('color_tone', '')}。"
        "保持人物身份与场景元素一致(同一主体、同一空间),但按上述景别真实改变取景范围。"
    )
    if chained:
        # 关键:不再"严格保持连续一致"。基底图=身份/场景真源,上一镜仅延续光线气氛与色调,
        # 本镜必须按镜头语言【重新取景】,不要沿用上一镜的取景与主体大小,否则景别改不动。
        return (
            "参考图为【基底图】与【上一镜画面】。【基底图】是人物身份与场景元素的唯一真源,"
            "【上一镜画面】仅用于延续光线方向与明暗气氛——【色调/色温以本镜调色指令为准,不要沿用上一镜或原图的色彩】。"
            "本镜务必按下述镜头语言【重新取景】,真实改变景别/机位/构图与透视,"
            "不要沿用上一镜的取景范围与主体大小——" + body
        )
    return body


def _shot_dims_clause(shot: dict) -> str:
    """本镜十维度镜头语言短语(景别/构图/机位/运镜/节奏/焦距/景深/光影/色彩),逗号连接。"""
    segs: list[str] = []
    # 画面构成(承接首帧)
    for label, key in (("景别", "shot_size"), ("构图", "composition"), ("机位", "angle")):
        if shot.get(key):
            segs.append(f"{label}{shot[key]}")
    # 运动核心
    if shot.get("movement"):
        segs.append(f"运镜:{shot['movement']}")
    if shot.get("rhythm"):
        segs.append(f"节奏:{shot['rhythm']}")
    # 镜头光学
    for label, key in (("焦距", "focal_length"), ("景深", "depth_of_field")):
        if shot.get(key):
            segs.append(f"{label}{shot[key]}")
    # 影调
    for label, key in (("光影", "lighting"), ("色彩", "color_tone")):
        if shot.get(key):
            segs.append(f"{label}{shot[key]}")
    return "，".join(segs)


def _shot_video_prompt(shot: dict) -> str:
    """单镜图生视频运动指令(以关键帧为首帧;时长另由 --duration 传入)。"""
    return (
        f"以此画面为首帧生成电影镜头：{_shot_dims_clause(shot)}。"
        "严格保持主体形象与场景空间一致,仅按上述镜头语言产生运动与光影变化;"
        "画面自然流畅,无明显形变与抖动。"
    )


def _shot_duration_sec(shot: dict, default: int = 5) -> int:
    """从 duration 维度抽取秒数,夹到 4-10s(seedance 家族要求 4-15,这里上限 10 控成本)。"""
    match = re.search(r"(\d+(?:\.\d+)?)", str(shot.get("duration", "")))
    val = int(round(float(match.group(1)))) if match else default
    return max(4, min(val, 10))


def _fmt_t(x: float) -> str:
    """时间轴秒数显示:整数去小数,否则保留一位。"""
    return f"{x:.0f}" if abs(x - round(x)) < 0.05 else f"{x:.1f}"


def _transition_clause(cur: dict, nxt: dict) -> str:
    """相邻两镜的衔接说明(schema 无显式转场字段,据相邻运镜自动生成)。"""
    a = cur.get("movement") or "本镜运动"
    b = nxt.get("movement") or "下一镜运动"
    return f"由「{a}」自然过渡到「{b}」,保持主体与场景空间连续,衔接顺畅不跳变。"


def _scheme_video_plan(shots: list[dict]) -> tuple[int, list[tuple[float, float, dict]]]:
    """各镜时长求和 → 整片总时长(夹 4–_SCHEME_VIDEO_MAX_S,即梦上限),按比例铺时间轴。

    返回 (总秒数, [(t0, t1, shot), ...]);shots 须已按 order 排好。镜头多于上限时
    总时长被压缩,时间轴按各镜原时长比例分配,标注即为压缩后的真实区间。
    """
    durs = [(float(_shot_duration_sec(s)), s) for s in shots]
    raw = sum(d for d, _ in durs) or float(len(shots) * 5 or 5)
    total = max(4.0, min(raw, float(_SCHEME_VIDEO_MAX_S)))
    factor = total / raw if raw else 1.0
    segs: list[tuple[float, float, dict]] = []
    t = 0.0
    for d, s in durs:
        segs.append((t, t + d * factor, s))
        t += d * factor
    if segs:  # 末段对齐到 total,消化累积舍入
        t0, _, s = segs[-1]
        segs[-1] = (t0, total, s)
    return int(round(total)), segs


def _scheme_video_prompt(segs: list[tuple[float, float, dict]], total: int) -> str:
    """全能参考整片 prompt:整合的时间轴(第几秒~第几秒是哪镜)+ 镜头间衔接说明。"""
    n = len(segs)
    lines = [
        f"这是一组按时间顺序排列的电影关键帧(共 {n} 张,第 i 张对应第 i 个镜头)。"
        f"请据此生成一段连贯的多镜头电影短片,总时长约 {total} 秒。"
        "严格保持各镜主体形象与场景空间一致,按下方时间轴依次呈现各镜头,"
        "镜头之间按标注方式自然衔接、节奏连贯,无明显形变与抖动。",
        "",
        "时间轴:",
    ]
    for i, (t0, t1, shot) in enumerate(segs, start=1):
        lines.append(f"[{_fmt_t(t0)}–{_fmt_t(t1)}s｜镜头{i}] 参考第{i}张图:{_shot_dims_clause(shot)}。")
        if i < n:
            lines.append(f"    衔接(镜头{i}→镜头{i + 1}):{_transition_clause(shot, segs[i][2])}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 单镜生成
# ---------------------------------------------------------------------------
async def edit_image(images: list[Path], instruction: str) -> bytes:
    """一次关键帧:1~N 张参考图 + 指令 → 编辑后图像字节。

    IMAGE_API_STYLE=openai → OpenAI 兼容 images/edits(如 gpt-image-2,经聚合网关);
    默认走即梦 image2image CLI(支持多图参考)。
    """
    from app.llm.client import get_llm_settings

    if get_llm_settings().image_api_style == "openai":
        return await _edit_image_openai(images, instruction)
    refs = ",".join(str(p) for p in images)
    args = ["image2image", f"--images={refs}", f"--prompt={instruction}"]
    if DREAMINA_IMAGE_MODEL:
        args.append(f"--model_version={DREAMINA_IMAGE_MODEL}")
    url = await _submit_and_wait(args, kind="images", wait_s=_IMAGE_WAIT_S)
    return await _download(url)


async def _edit_image_openai(images: list[Path], instruction: str) -> bytes:
    """OpenAI 兼容 images/edits:参考图 + 指令 → 图像字节(b64 或 URL 两种返回都处理)。"""
    import base64

    from openai import AsyncOpenAI

    from app.llm.client import get_llm_settings

    s = get_llm_settings()
    api_key = os.environ.get("IMAGE_API_KEY") or s.llm_api_key
    base_url = os.environ.get("IMAGE_BASE_URL") or s.llm_base_url
    model = s.image_model
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    handles = [open(p, "rb") for p in images]
    try:
        result = await client.images.edit(
            model=model,
            image=handles if len(handles) > 1 else handles[0],
            prompt=instruction,
        )
    except Exception as exc:
        raise RenderError(f"images/edits 调用失败({model}): {exc}") from exc
    finally:
        for h in handles:
            h.close()
    if not result.data:
        raise RenderError(f"images/edits 空响应({model})")
    item = result.data[0]
    if getattr(item, "b64_json", None):
        return base64.b64decode(item.b64_json)
    if getattr(item, "url", None):
        return await _download(item.url)
    raise RenderError(f"images/edits 响应缺少 b64_json/url({model})")


async def animate_image(keyframe: Path, prompt: str, duration: int) -> bytes:
    """一次图生视频:关键帧 + 十维度运动指令 → 视频字节(即梦 image2video)。

    进阶控制(--duration / --video_resolution / --model_version)须成组提供
    (见 image2video -h);未配置 DREAMINA_VIDEO_MODEL 时走默认路径(默认 5s 720p)。
    """
    args = ["image2video", f"--image={keyframe}", f"--prompt={prompt}"]
    if DREAMINA_VIDEO_MODEL:
        args += [
            f"--model_version={DREAMINA_VIDEO_MODEL}",
            f"--duration={duration}",
            f"--video_resolution={DREAMINA_VIDEO_RESOLUTION}",
        ]
    url = await _submit_and_wait(args, kind="videos", wait_s=_VIDEO_WAIT_S)
    return await _download(url)


async def compose_scheme_video(images: list[Path], prompt: str, duration: int) -> bytes:
    """全能参考(multimodal2video):多张关键帧按顺序作参考 + 整合 prompt + 总时长
    → 一段连贯的多镜头视频字节。

    比例不显式指定,由 CLI 按首图推断(避免与竖/横基底图冲突)。
    """
    args = ["multimodal2video"]
    args += [f"--image={img}" for img in images]
    args.append(f"--prompt={prompt}")
    if DREAMINA_VIDEO_MODEL:
        args += [
            f"--model_version={DREAMINA_VIDEO_MODEL}",
            f"--video_resolution={DREAMINA_VIDEO_RESOLUTION}",
        ]
    args.append(f"--duration={duration}")
    url = await _submit_and_wait(args, kind="videos", wait_s=_SCHEME_VIDEO_WAIT_S)
    return await _download(url)


# ---------------------------------------------------------------------------
# 落盘 / 文件名 / 运行时合并
# ---------------------------------------------------------------------------
def frame_filename(session_id: str, scheme_id: str, order: int) -> str:
    """确定性关键帧文件名 — uploads/ 即渲染产物的事实存储。"""
    return f"{session_id}_{scheme_id}_s{order}.png"


def video_filename(session_id: str, scheme_id: str, order: int) -> str:
    """确定性单镜视频文件名(旧逐镜产物,保留兼容)。"""
    return f"{session_id}_{scheme_id}_s{order}.mp4"


def scheme_video_filename(session_id: str, scheme_id: str) -> str:
    """全能参考整片视频文件名(整方案一个,无镜号,不与单镜 _s{n} 撞)。"""
    return f"{session_id}_{scheme_id}.mp4"


def hydrate_frames(session_id: str, schemes: list[dict]) -> list[dict]:
    """按磁盘存在性回填 shot.frame_image / frame_video 与 scheme.scheme_video(不写图状态)。"""
    for scheme in schemes or []:
        scheme_id = scheme.get("scheme_id", "X")
        for shot in scheme.get("shots", []):
            order = shot.get("order", 0)
            img = frame_filename(session_id, scheme_id, order)
            if (UPLOADS_DIR / img).exists():
                shot["frame_image"] = f"{UPLOADS_URL_PREFIX}/{img}"
            vid = video_filename(session_id, scheme_id, order)
            if (UPLOADS_DIR / vid).exists():
                shot["frame_video"] = f"{UPLOADS_URL_PREFIX}/{vid}"
        sv = scheme_video_filename(session_id, scheme_id)
        if (UPLOADS_DIR / sv).exists():
            scheme["scheme_video"] = f"{UPLOADS_URL_PREFIX}/{sv}"
    return schemes


# ---------------------------------------------------------------------------
# 方案级渲染
# ---------------------------------------------------------------------------
async def render_scheme(session_id: str, scheme: dict, base_image: Path, only_order: int | None = None) -> dict:
    """链式逐镜渲染关键帧(连贯策略 B):
    frame[0] 由基底图重摄;frame[i] 以【基底图 + 上一镜帧】双参考承接生成
    —— 基底图锚定主体/场景防漂移,上一镜帧保镜头间连续。

    串行(每镜依赖上一镜);单镜失败则跳过,后续仍从最近一张成功帧续链。
    only_order 指定时只渲该镜(用其之前最近一张已存在的帧做连贯参考)。"""
    ensure_uploads_dir()
    scheme_id = scheme.get("scheme_id", "X")
    updated = copy.deepcopy(scheme)
    all_shots = sorted(updated.get("shots", []), key=lambda s: s.get("order", 0))
    prev: Path | None = None
    prev_shot: dict | None = None
    if only_order is not None:
        shots = [s for s in all_shots if s.get("order") == only_order]
        for s in reversed([x for x in all_shots if x.get("order", 0) < only_order]):
            p = UPLOADS_DIR / frame_filename(session_id, scheme_id, s.get("order", 0))
            if p.exists():
                prev = p
                prev_shot = s
                break
    else:
        shots = all_shots
    for shot in shots:
        order = shot.get("order", 0)
        # 景别跨度大(≥2 档,如 中近景→大特写)时不带上一镜帧:它会把模型锚死在旧取景上,
        # 景别改不动。此时只用基底图,让本镜从头按新景别取景。
        big_jump = (
            prev_shot is not None
            and abs(_size_rank(shot.get("shot_size", "")) - _size_rank(prev_shot.get("shot_size", ""))) >= 2
        )
        use_prev = prev is not None and not big_jump
        refs = [base_image, prev] if use_prev else [base_image]
        instruction = _shot_instruction(shot, chained=use_prev)
        try:
            image_bytes = await edit_image(refs, instruction)
        except Exception:
            logger.exception(
                "Keyframe render failed for %s scheme %s shot %s", session_id[:8], scheme_id, order
            )
            continue
        filename = frame_filename(session_id, scheme_id, order)
        path = UPLOADS_DIR / filename
        path.write_bytes(image_bytes)
        shot["frame_image"] = f"{UPLOADS_URL_PREFIX}/{filename}"
        prev = path
        prev_shot = shot
        logger.info("Rendered keyframe %s scheme %s shot %s", session_id[:8], scheme_id, order)
    return updated


async def animate_scheme(session_id: str, scheme: dict) -> dict:
    """全能参考(multimodal2video):方案全部关键帧按 order 顺序作参考图 +
    一个带时间轴(第几秒~第几秒是哪镜)和镜头衔接说明的整合 prompt
    → 一段连贯的多镜头视频(整方案一个,写入 scheme.scheme_video)。

    需先跑过 render_scheme(关键帧落盘)。无任何关键帧时原样返回;合成失败抛
    RenderError,交由调用方冒泡到接口(不再静默吞掉,便于看到真实失败原因)。
    """
    ensure_uploads_dir()
    scheme_id = scheme.get("scheme_id", "X")
    updated = copy.deepcopy(scheme)
    shots = sorted(updated.get("shots", []), key=lambda s: s.get("order", 0))

    # 有关键帧的镜头按 order 作顺序参考图
    framed = [
        s
        for s in shots
        if (UPLOADS_DIR / frame_filename(session_id, scheme_id, s.get("order", 0))).exists()
    ]
    if not framed:
        logger.warning("Skip animate %s scheme %s: no keyframes", session_id[:8], scheme_id)
        return updated
    if len(framed) > _MULTIMODAL_IMAGE_MAX:
        logger.warning(
            "Scheme %s has %d keyframes > %d; using first %d",
            scheme_id, len(framed), _MULTIMODAL_IMAGE_MAX, _MULTIMODAL_IMAGE_MAX,
        )
        framed = framed[:_MULTIMODAL_IMAGE_MAX]

    images = [
        UPLOADS_DIR / frame_filename(session_id, scheme_id, s.get("order", 0)) for s in framed
    ]
    total, segs = _scheme_video_plan(framed)
    prompt = _scheme_video_prompt(segs, total)

    video_bytes = await compose_scheme_video(images, prompt, total)
    filename = scheme_video_filename(session_id, scheme_id)
    (UPLOADS_DIR / filename).write_bytes(video_bytes)
    updated["scheme_video"] = f"{UPLOADS_URL_PREFIX}/{filename}"
    logger.info(
        "Composed scheme video %s scheme %s (%d shots, %ds)",
        session_id[:8], scheme_id, len(framed), total,
    )
    return updated
