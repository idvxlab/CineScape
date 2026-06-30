# AGENTS.md

本文件规范所有在本仓库工作的 AI agent（及人类协作者）的行为。
**动手前先读本文件，再读 [`docs/README.md`](docs/README.md)（文档地图）。**

---

## 项目一句话

一个人在环（human-in-the-loop）的两阶段创意系统：把用户模糊的创作意图**对齐**到结构化「设计空间」（12 一级 × 56 二级意图），再在设计空间上**直接推理生成**可编辑的镜头脚本（纯推理为基线，检索为可选增强，见 ADR-0010）。完整背景见 [`final_proposal.md`](final_proposal.md)。

## ⚠️ 当前阶段：开发期

本仓库已进入开发阶段，开始实现代码。

## 黄金法则（设计不变量，不得违背）

从 proposal 沉淀的"宪法"。任何设计与改动不得违反；确需违反，先在 [`docs/decisions.md`](docs/decisions.md) 开 ADR 讨论并获批。

1. **对齐用推理，不打分。** 维度状态用定性标签（`open / leaning / resolved / conflicting / blocked_by`），不给数值置信度、不算"影响力 × 模糊度"。
2. **设计空间是唯一审美与知识来源。** 不写死导演人格 / 风格卡；阶段二的 A/B/C 方向从设计空间的机制路径**枚举**而来，电影语法锚在 56 张知识卡上（ADR-0010）。
3. **意图忠实 > 手法华丽。** 知识卡手法 / 库内参考与意图冲突时，服从意图（brief）。
4. **不过度设计。** 自主 agent 只有 4 类：Orchestrator、对齐、生成、审校。**检索是可选增强工具，编辑是生成的模式。** 不要新增第 5 类自主 agent。
5. **人在环不可绕过。** 对齐多轮、A/B/C 选择两处必须能暂停等用户（LangGraph `interrupt`）。
6. **plan→detail。** 先定镜头序列骨架（结构层分叉最大），再填十参数。
7. **收敛靠机制，不靠感觉。** 黏滞「要紧维度集」+ 定性状态上的确定性收敛谓词，别退化成"让 LLM 凭感觉判收敛"。

每条来由见 [`docs/decisions.md`](docs/decisions.md) 与 [`final_proposal.md`](final_proposal.md)。

## 技术栈（已定，见 ADR-0004/0005）

- **后端**：Python · FastAPI · LangGraph · Postgres + pgvector
- **开发 LLM**：DeepSeek V4 Flash
- **生产 LLM（后续替换）**：Claude Opus · Qwen 3.6 Plus
- **前端**：React + Vite
- **编排**：LangGraph `StateGraph`（= orchestrator）+ `interrupt`（人在环）+ `PostgresSaver`（会话持久化）

细节见 [`架构设计.md`](架构设计.md)。替换栈需 ADR。

## 工作约定

- **文档即事实源。** 本体、契约、决策一律以 `docs/` 为准；不靠记忆或对话里的口头结论。
- **设计先行。** 先改设计文档、达成一致，（将来）才动代码。
- **决策留痕。** 任何架构级选择 → 在 [`docs/decisions.md`](docs/decisions.md) 记一条 ADR。**不要重新争论已 Accepted 的 ADR。**
- **改动同步地图。** 新增 / 移动 / 废弃文档 → 回去更新 [`docs/README.md`](docs/README.md) 的文档地图表。
- **DRY 契约。** 同一个 schema / 契约只在一处定义（契约层或架构层），别处用链接引用，不复制粘贴。
- **受控词表。** `tags` 与 `Shot.serves` 只能取二级意图 code，意图维度 key 取一级意图名，规格见 [`docs/domain/ontology-spec.md`](docs/domain/ontology-spec.md)，不自造词。
- **不臆造数据。** [`labels_v3.json`](labels_v3.json) 是本体内容权威源（编辑入口 `导演意图分类_v3_中文.xlsx`，改后需同步 backend 副本并跑 `scripts/check_ontology_sync.py`）；"方案库自然增长（飞轮）、知识卡为唯一先验"是已知现状，别假装有范例数据。
- **语言。** 文档用中文；将来代码标识符、schema 字段名用英文。
- **M0 里程碑定位**：地基 + 对齐闭环 = 核心 HITL 交互优先打通。生成/编辑/飞轮后续里程碑。

## 提问 vs 默认

- 真正的设计分叉（影响多个文档、不可逆、涉及用户口味）→ 交用户决定，别擅自拍板。
- 局部小决策 → 走合理默认，并在回复末尾说明所做假设。

## 完成定义（M0 开发任务）

1. 代码能跑通：后端 import + 启动，前端 build；
2. Docker Compose 可建立 Postgres + pgvector；
3. 核心 Pydantic schema 定义完整；
4. LangGraph 状态图骨架可运行；
5. 新的架构级决策已落 ADR；
6. `docs/` 文档与代码状态同步。
