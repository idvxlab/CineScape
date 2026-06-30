# 模块详规（Module Specs）

> 模块层 · 每个 agent / 节点的职责、I/O 契约、行为。最易变层。
> 与 [`/架构设计.md`](../架构设计.md) §2 的 LangGraph 节点表对应；本文件展开每个节点的细节。
> 类型标注遵守黄金法则 4：**自主 agent 仅 4 类，召回是工具，编辑是模式。**

每个模块用统一模板：**职责 / 输入→输出 / 读写状态 / 关键机制 / prompt / 开放问题**。🚧 未定处标 TBD。

---

## Orchestrator（= LangGraph 图本身）

- **类型**：自主（编排）。
- **职责**：状态机、节点路由、持有共享 `SessionState`、判定对齐收敛。
- **关键机制**：`StateGraph` + 条件边（convergence / critic 两处分支）；两处 `interrupt`（对齐、选择）；`PostgresSaver` 持久化；strategy 后 `Send()` 并行 fan-out。
- **收敛判定**：黏滞「要紧维度集」+ LLM 定性推理（不打分）+ confirm 门控。详见 [ADR-0003](decisions.md)。
- **prompt**：`backend/app/llm/prompts.py`。

## 对齐 Agent

- **类型**：自主。
- **输入 → 输出**：`(IntentState, 用户最新输入, 本体 schema)` → `(更新后 IntentState, widgets[] 或 复述)`。
- **读写状态**：读全量，写 `dimensions / pending_widgets`，收敛时写 `brief / tags`。
- **关键机制**：推理判断"哪些维度对这个意图既重大又不明确"→ 优先发问；每轮 ≤3 控件；尊重 `blocked_by` 依赖序；冲突显性化（把张力做成控件抛回）。
- **控件类型**：见 [`contracts.md`](contracts.md) `Widget`；选型依据 `ontology-spec` 的 selection 提示 + 双极轴（slider）+ 值集（追问取值）；易混淆区直接用判别 probe 发问。
- **prompt**：`backend/app/llm/prompts.py::align_intent`。
- **开放问题**：`leaning` 何时算"可接受"而交棒阶段二 A/B/C。

## 策略（Strategy，原召回+归纳，ADR-0010）

- **类型**：自主（生成 agent 的策略阶段）。
- **输入 → 输出**：收敛 `IntentState`（brief + tags）→ `directions[]`（≤3 个机制路径）。
- **关键机制**：**设计空间直推**——对意图组合枚举真正不同的机制路径（主导机制族不同才算不同方向），每方向 = `{dominant_intents, mechanism, core_technique}`。知识卡提供机制与候选手法。
- **检索增强（可选）**：尽力查询方案库（tags 过滤），命中则附加为参考；失败/为空不阻塞。`signal` 仅作记录。
- **开放问题**：方向间多样性的可度量判据。

## 生成 Agent

- **类型**：自主。
- **输入 → 输出**：`(IntentState 含 brief+tags, direction, 知识卡)` → 单方向 `ShotScript`（并行多实例）。
- **关键机制**：三层推理链（B 效果 → 机制 → A 手段 → 十参数）+ `plan→detail`（先骨架 beats，再填十参数）。每镜必填 `serves`（服务的二级 code）与机制链 `rationale`。scene 作用域意图须贯穿全部镜头。铁律：意图忠实 > 手法华丽。
- **prompt**：`backend/app/llm/prompts.py::generate_direction`。

## 审校 Critic

- **类型**：自主。
- **输入 → 输出**：候选 `ShotScript` → `(过审 | 修订意见)`。
- **关键机制**：三层——① **参数耦合**硬编码规则表（ADR-0009，`graph/coupling.py`）；② **确定性 serves 检查**（引用 code 必须在 tags+dominant_intents 内）；③ **LLM 判定**：机制链忠实（对照知识卡）、易混淆误用（脚本实际效果落在判别规则哪侧）、双极轴自洽。生成 ⇄ 审校小循环。
- **依赖**：`ontology.critic_digest()` + `knowledge_digest()`。

## 编辑协作（Edit）

- **类型**：**生成 agent 的一种模式**（非独立 agent）。
- **职责**：用户选定后介入——校验编辑、改动破坏一致性时提示、可只重生成单镜而保持其余。
- **输入 → 输出**：`(选定 ShotScript, 编辑 patch)` → `(revalidation: conflicts[])`。
- **开放问题**：单镜重生成如何在不动其余的前提下保持序列连贯。
