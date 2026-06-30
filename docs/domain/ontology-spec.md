# 意图本体 schema v3（Ontology Spec）

> 领域层 · 事实源。这是系统消费的「设计空间」的权威规格。
> 本体**内容**（12 一级 × 56 二级及其定义）以仓库根 [`/labels_v3.json`](../../labels_v3.json) 为权威源
> （人工编辑入口为 `/导演意图分类_v3_中文.xlsx`）；
> 本文件定义其**结构与元结构**。落地见 [ADR-0010](../decisions.md)。

## 1. 三个数据源（运行时合并）

运行时源位于 `backend/app/ontology/`，由 `loader.py` 在启动时合并并交叉校验：

| 文件 | 内容 | 修改方式 |
|---|---|---|
| `labels_v3.json` | 分类法本身：12 一级 × 56 二级，code/name/definition/note + 7 组易混淆对 | 从仓库根同步（`cp labels_v3.json backend/app/ontology/`），勿直接编辑 |
| `meta_v3.yaml` | 元字段：A/B 类型覆盖、双极轴、值集、作用域、易混淆判别规则（结构化）、一级选择提示 | 人工精修 |
| `knowledge_v3.yaml` | 56 张电影语法知识卡：机制 + 十参数候选手法 + 经典参照 | 人工精修（LLM 初稿 + 人审） |

一致性校验：`backend/.venv/bin/python scripts/check_ontology_sync.py`。

## 2. 分类骨架（12 一级 × 56 二级）

| code | 一级意图 | 类型 | 二级数 | 结构备注 |
|---|---|---|---|---|
| 1 | 情绪唤起 | B | 7 | 点状情绪 |
| 2 | 注意引导 | A | 4 | |
| 3 | 氛围营造 | B | 11 | 面状底色，作用域 scene |
| 4 | 视点/认同 | A | 4 | |
| 5 | 人物塑造 | A | 4 | 维度+值集结构 |
| 6 | 节奏调控 | A | 4 | 6.1↔6.2 双极轴；6.3/6.4 序列层 |
| 7 | 共情建立 | B | 4 | |
| 8 | 信息管理 | A/B | 4 | 8.1=A（给信息），8.2-8.4=B（叙事兴趣） |
| 9 | 情境交代 | A | 3 | |
| 10 | 空间表征 | A | 4 | 10.2↔10.3 双极轴 |
| 11 | 构图美学 | A | 4 | 11.1↔11.2 双极轴 |
| 12 | 主题表意 | A | 3 | 12.2/12.3 序列层 |

**A/B 类型语义（ADR-0010 的推理脚手架）**：

- **A = 导演构成性意图**——画面上可直接验证的安排（注意落点、视点位置、空间关系……）。
- **B = 观众效应性意图**——要在观众心里发生的反应（情绪、氛围感受、共情、悬念……）。
- B 类是**目的**，A 类是**手段**：生成推理链 = B 效果 → 心理/知觉机制 → A 手段 → 十参数。

## 3. 元结构（meta_v3.yaml）

```yaml
meta:
  top_intents:        # 一级意图 → 对齐控件提示
    <一级名>: {selection: single|multi, hint: "..."}
  sub_types:          # A/B 类型例外（默认继承一级）；现仅 8.x
    "8.1": A
  scopes:             # 作用域；未列出默认 shot（单镜）
    scene: [3.1 … 3.11]                      # 贯穿整场的底色
    sequence: ["6.3", "6.4", "12.2", "12.3"] # 需镜头序列
    both: ["6.1", "6.2"]
  axes:               # 双极轴 → slider 控件 + critic 互斥检查
    - {id: 节奏快慢, poles: ["6.1", "6.2"], description: ...}
    - {id: 空间尺度, poles: ["10.2", "10.3"], description: ...}
    - {id: 构图稳定张力, poles: ["11.1", "11.2"], description: ...}
  value_sets:         # 维度·值结构：选中后须追问取值
    "5.1": [强势, 对等, 弱势]
    "5.2": [恐惧, 悲伤, 愤怒, 愉悦, 厌恶, 敬畏, 孤独, 焦虑]   # 与 1.x 共享
    "5.3": [亲密, 对立, 从属, 结盟, 孤立]
  open_value: ["5.4"]  # 开放取值（自由文本）
  confusable_rules:   # 7 组判别规则：对齐探针 + critic 误用检查
    - {id: A..G, between: [[前缀组], [前缀组]], rule: ..., probe: ...}
```

## 4. 知识卡（knowledge_v3.yaml）

每个二级意图一张，是**纯推理生成的知识锚点**（取代标注数据/范例库，ADR-0010）：

```yaml
knowledge:
  "<code>":
    mechanism: 该意图起作用的心理/知觉机制（为什么观众会产生这个效果）
    techniques:           # 只列强相关参数，key ∈ 十参数
      <param>: 候选手法
    references: [经典参照]  # 供 LLM 锚定具体性，不是要复制的模板
```

## 5. 系统消费方式

| 消费方 | 接口 | 用途 |
|---|---|---|
| 对齐 align / 收敛 convergence | `ontology.alignment_digest()` | 全设计空间紧凑文本 + 判别 probe |
| 策略 strategy | `knowledge_digest(tags)` + `critic_digest(tags)` | 机制路径枚举 |
| 生成 generate | `knowledge_digest(tags + dominant_intents)` | 三层链推理的手法依据 |
| 审校 critic | `critic_digest(codes)` + `knowledge_digest(codes)` | 易混淆误用、双极轴自洽、机制忠实 |
| 全链路 | `validate_tags(tags)` | tags 必须是合法二级 code |

受控词表：`IntentState.dimensions` 的 key = 一级意图名；`tags` 与 `Shot.serves` = 二级意图 code（如 `"8.3"`）。

## 6. 三条设计含义（自 v1 延续，按 v3 改写）

1. **多标签、跨维共存。** 一个意图通常同时落在多个一级维度——"孤独" ≈ 氛围 3.4 疏离 + 空间 10.2 渺小 + 共情 7.1（或刻意反向 4.2 旁观）。`tags` = 选中的二级 code 集合。
2. **B→A 有推理流向。** 用户通常先说出 B 类效果（"想让观众感到……"）；A 类手段若用户无明确偏好，留给生成阶段沿机制链推理，对齐不逼问。这取代了 v1 的 `blocked_by_default` 依赖序。
3. **创作者潜台词不在本体内。** 本体是效果/构成侧；用户那句话是创作者侧。对齐正是把它翻译、放置到设计空间上;易混淆判别规则（A-G）是放置时的显式探针。

## 7. 修改流程

1. 改分类内容 → 编辑 xlsx → 同步 `labels_v3.json` → `cp` 到 backend → 跑 sync 校验。
2. 增删二级意图 → 同步补/删 `knowledge_v3.yaml` 知识卡与 `meta_v3.yaml` 相关条目（loader 启动即校验：未知 code 报错，缺知识卡告警）。
3. 元结构变更（新轴/新规则/新字段）→ 本文件 + ADR 留痕。
