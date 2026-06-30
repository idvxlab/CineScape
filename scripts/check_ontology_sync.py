#!/usr/bin/env python3
"""校验本体 v3 数据源一致性。

1. 仓库根 labels_v3.json 与 backend/app/ontology/labels_v3.json 内容一致
   (根文件是编辑入口,backend 副本是运行时源;改完根文件需手动同步)。
2. meta_v3.yaml / knowledge_v3.yaml 引用的 code 全部存在,且 56 个二级意图
   每个都有知识卡。

用法: backend/.venv/bin/python scripts/check_ontology_sync.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROOT_LABELS = ROOT / "labels_v3.json"
BACKEND_DIR = ROOT / "backend" / "app" / "ontology"

sys.path.insert(0, str(ROOT / "backend"))


def main() -> int:
    errors: list[str] = []

    with open(ROOT_LABELS, encoding="utf-8") as f:
        root_labels = json.load(f)
    with open(BACKEND_DIR / "labels_v3.json", encoding="utf-8") as f:
        backend_labels = json.load(f)
    if root_labels != backend_labels:
        errors.append(
            "labels_v3.json 不同步:请执行 "
            "cp labels_v3.json backend/app/ontology/labels_v3.json"
        )

    from app.ontology import load_ontology  # noqa: E402 — loader 自带交叉校验

    try:
        ontology = load_ontology()
    except Exception as exc:
        errors.append(f"load_ontology() 失败:{exc}")
        ontology = None

    if ontology is not None:
        codes = ontology.all_codes()
        missing = [c for c in codes if ontology.get_sub(c).knowledge is None]
        if missing:
            errors.append(f"缺知识卡的二级意图:{missing}")
        n_top = len(ontology.top_intents)
        print(f"OK: {n_top} 个一级意图,{len(codes)} 个二级意图,知识卡全覆盖")
        print(f"双极轴 {len(ontology.axes)} 条,易混淆规则 {len(ontology.confusable_rules)} 条")

    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
