#!/usr/bin/env python3
"""CineDesign 端到端冒烟:带图会话(必传)走完
align → confirm → candidates → render(关键帧)→ edit → adopt 全流程。

用法: python3 scripts/e2e_smoke.py <参考图路径> [意图文本]
"""

import json
import mimetypes
import sys
import urllib.request
import uuid
from pathlib import Path

BASE = "http://localhost:8000/api"


def post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        return json.load(resp)


def post_multipart(path, fields, file_field, file_path):
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(file_path)[0] or "image/jpeg"
    parts = []
    for name, value in fields.items():
        parts.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
                f"\r\n\r\n{value}\r\n"
            ).encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
            f'filename="{Path(file_path).name}"\r\nContent-Type: {mime}\r\n\r\n'
        ).encode()
        + Path(file_path).read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        return json.load(resp)


def get_status(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=60) as resp:
        return resp.status


def show(step, turn):
    print(f"\n===== {step} → phase={turn.get('phase')} =====")
    if turn.get("phase") == "align":
        print("reflection:", (turn.get("reflection") or "")[:150])
        for w in turn.get("widgets", []):
            print(f"  [{w.get('kind')}] dim={w.get('dim')} prompt={w.get('prompt', '')[:60]}")
            for o in w.get("options", [])[:5]:
                print(f"     - {o.get('value')}: {o.get('label', '')[:50]}")
    elif turn.get("phase") == "confirm":
        print("brief:", (turn.get("brief") or "")[:200])
        print("tags:", turn.get("tags"))
    elif turn.get("phase") == "candidates":
        for s in turn.get("schemes", []):
            print(
                f"  方案{s.get('scheme_id')}: {s.get('strategy', '')[:40]} "
                f"| {len(s.get('shots', []))} 镜 | intents={s.get('dominant_intents')}"
            )
        if turn.get("conflicts"):
            print("  conflicts:", turn["conflicts"])
    elif turn.get("phase") == "edit":
        sc = turn.get("scheme", {})
        print(f"  编辑方案 {sc.get('scheme_id')},{len(sc.get('shots', []))} 镜")
    elif turn.get("phase") == "done":
        sc = turn.get("scheme") or {}
        print("  采纳:", sc.get("scheme_id"), "|", (sc.get("strategy") or "")[:50])
    sys.stdout.flush()


def pick_answers(turn):
    """对每个控件选第一个选项(slider 选左端;freetext 给一句话)。"""
    answers = {}
    for w in turn.get("widgets", []):
        dim = w.get("dim") or w.get("kind")
        kind = w.get("kind")
        if kind == "single":
            opts = w.get("options", [])
            if opts:
                answers[dim] = opts[0]["value"]
        elif kind == "multi":
            opts = w.get("options", [])
            if opts:
                answers[dim] = [o["value"] for o in opts[:2]]
        elif kind == "slider":
            ticks = w.get("ticks") or list(w.get("ends", []))
            if ticks:
                answers[dim] = ticks[0]
        elif kind == "freetext":
            answers[dim] = "风格大胆转换没问题,保持画面里的人物和环境即可"
    return answers


def main():
    if len(sys.argv) < 2:
        print("用法: e2e_smoke.py <参考图路径> [意图文本]")
        sys.exit(2)
    image_path = sys.argv[1]
    intent = sys.argv[2] if len(sys.argv) > 2 else "把这个画面改成阳光明媚的温馨喜剧氛围"

    turn = post_multipart("/sessions", {"raw_intent": intent}, "image", image_path)
    sid = turn["session_id"]
    print("session:", sid)
    print("reference_image:", turn.get("reference_image"))
    show("CREATE", turn)

    # 对齐循环:最多 4 轮,每轮自动作答
    rounds = 0
    while turn["phase"] == "align" and rounds < 4:
        answers = pick_answers(turn)
        print("\n>>> 提交回答:", json.dumps(answers, ensure_ascii=False)[:200])
        turn = post(f"/sessions/{sid}/respond", {"dim_widget_responses": answers})
        show(f"RESPOND #{rounds + 1}", turn)
        rounds += 1

    if turn["phase"] != "confirm":
        print("!! 未在 4 轮内收敛,phase:", turn["phase"])
        sys.exit(1)

    print("\n>>> 确认 brief,开始生成…")
    turn = post(f"/sessions/{sid}/confirm", {"confirmed": True})
    show("CONFIRM", turn)
    if turn["phase"] != "candidates":
        sys.exit(1)

    target = turn["schemes"][0]["scheme_id"]

    # 渲染关键帧(逐镜图像编辑)
    print(f"\n>>> 渲染方案 {target} 关键帧(逐镜图像编辑,较慢)…")
    res = post(f"/sessions/{sid}/render", {"scheme_id": target})
    print(f"rendered {res['rendered']}/{res['total']}")
    for shot in res["scheme"]["shots"]:
        url = shot.get("frame_image")
        status = get_status(url.removeprefix("/api")) if url else "-"
        print(f"  镜头{shot['order']} frame={url} http={status}")
        print(f"    hint: {shot.get('frame_edit_hint', '')[:90]}")
    if res["rendered"] == 0:
        print("!! 没有任何镜头渲染成功")
        sys.exit(1)

    # 编辑一轮 + 采纳
    turn = post(f"/sessions/{sid}/select", {"scheme_id": target, "action": "edit"})
    show("SELECT(edit)", turn)
    first_order = turn["scheme"]["shots"][0]["order"]
    turn = post(
        f"/sessions/{sid}/edit",
        {"patch": [{"shot_order": first_order, "field": "duration", "value": "8s"}]},
    )
    show("EDIT", turn)

    turn = post(f"/sessions/{sid}/select", {"scheme_id": target, "action": "writeback"})
    show("ADOPT", turn)
    if turn["phase"] == "done":
        print("\n✅ 端到端(含关键帧渲染)全流程通过")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
