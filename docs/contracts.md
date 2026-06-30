# 接口契约（Contracts）

> 契约层 · 前后端之间、LangGraph 节点之间的精确接口。两端都依赖它，故单独成层。

## 现状

契约的**权威定义当前在** [`/架构设计.md`](../架构设计.md) §3（schema）与 §4（API / 事件）：

| 契约 | 定义位置 | 消费方 |
|---|---|---|
| `Widget`（single/multi/slider/freetext/confirm 判别联合） | 架构 §3.1 | 对齐 agent（产出）· 前端 widget registry（渲染） |
| `IntentState`（dimensions / key_dimensions / brief / tags） | 架构 §3.2 | 对齐 · 收敛判定 · 策略 |
| `Shot` / `ShotScript`（十参数 + serves + rationale + mechanism） | 架构 §3.3 | 生成 · Critic · 编辑 · 前端 |
| `RecallRecord`（方案库记录 + 向量列） | 架构 §3.4 | 检索增强（可选）· 飞轮回写 |
| `TurnResponse`（按 phase 的联合） | 架构 §4 | 前端按 phase 切 UI |
| REST + SSE 端点 | 架构 §4 | 前端 client |

受控词表来源见 [`domain/ontology-spec.md`](domain/ontology-spec.md)：`IntentState.dimensions` 的 key 与 `tags` 取自本体叶子。

## 本文件的职责（待建设阶段填充）

> 🚧 现为骨架。**进入开发阶段后**（非现在），把契约的*权威源*从架构文档迁到这里并补：

- **canonical schema 源**：Pydantic 定义集中处；前端 TS 类型由 OpenAPI 自动生成（`openapi-typescript`），保证两端不漂移。
- **版本与兼容**：契约变更记录、破坏性变更标注。
- **校验规则**：跨字段约束（如十参数三组耦合、tags 必须是合法叶子）。

在那之前，**改契约请改 [`架构设计.md`](../架构设计.md) §3-4，并在此更新上表**（DRY：不要两处都写 schema 正文）。
