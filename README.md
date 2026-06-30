# CineDesign · 可交互的创作意图对齐系统

> 一个**人在环（human-in-the-loop）**两阶段创意系统：把用户模糊的创作意图**对齐**到结构化「设计空间」（12 一级 × 56 二级意图），再在设计空间上**直接推理生成**可编辑的镜头脚本（纯推理为基线，检索为可选增强）。

[![Status](https://img.shields.io/badge/status-development-blue)]()
[![Python](https://img.shields.io/badge/python-3.11%2B-blue)]()
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-green)]()
[![React](https://img.shields.io/badge/React-19-61DAFB)]()
[![LangGraph](https://img.shields.io/badge/LangGraph-0.2%2B-orange)]()

---

## 问题

电影和视频创作者（导演、摄影师、剪辑师）有一个模糊的创意意图——"我想让观众感到孤独"，但把这种感觉翻译成具体的镜头参数（景别、运镜、构图、焦距、光影、色彩……）是一个高度专业化的技能。

现有工具要么提供空白画布（Premiere、DaVinci），要么提供模板化的框架（Storyboarder、ShotPro）。**没有工具理解"意图"本身，更不用说帮创作者探索"同一个意图可以用哪些不同的电影化手法表达"**。

## 方案

两阶段架构：

```
用户：参考画面（必传）+ 模糊意图（"我想让观众感到孤独"）
          │  会话 = 为这张画面设计重拍摄方案（ADR-0012）：
          │  画面锚定主体与空间；拍摄风格完全服从意图（允许剧变）
          ▼
   ┌──────────────────────────────────────┐
   │ 阶段一 · 意图对齐                        │◄──► 设计空间·导演意图 v3（12 一级·56 二级）
   │   意图对齐 Agent（推理式解释 + 控件）     │      A/B 类型·双极轴·值集·易混淆判别探针
   │   ↺ 多轮：单选/多选/滑块 ⇄ 用户选择       │
   └──────────────────────────────────────┘
          │ 对齐产物：brief（一段）+ tags（二级意图 code）
          ▼
   ┌──────────────────────────────────────┐
   │ 阶段二 · 镜头脚本生成（纯推理, ADR-0010）  │◄──► 56 张电影语法知识卡（机制+手法+参照）
   │  ① 策略直推：对意图组合枚举 ≤3 个真正     │
   │     不同的机制路径（主导机制族不同）       │      （方案库命中时附加为增强参考,
   │  ② 每个方向并行 plan→detail,三层推理链:  │        失败/为空不阻塞——飞轮长期生效）
   │     B效果意图→机制→A构成手段→十参数       │
   │  ③ Critic:耦合规则 + serves 校验 +       │
   │     机制链忠实/易混淆误用/双极轴自洽       │
   └──────────────────────────────────────┘
          │ A / B / C 方案
          ▼
         用户选择 + 编辑 → 采纳结果 + 对齐意图 回写
                                       │
                                       └──► 方案库自增长（飞轮 → 未来检索增强）
```

## 设计哲学（黄金法则）

1. **对齐用推理，不打分**——维度状态只有定性标签，不给数值置信度
2. **设计空间是唯一审美与知识来源**——不写死导演风格；方向从设计空间的机制路径枚举，电影语法锚在 56 张知识卡上
3. **意图忠实 > 手法华丽**——知识卡手法/库内参考与意图冲突时，服从意图
4. **不过度设计**——自主 agent 只有 4 类（Orchestrator、对齐、生成、审校）
5. **人在环不可绕过**——对齐多轮、A/B/C 选择两处必须能暂停等用户
6. **plan→detail**——先定骨架，再填十参数
7. **收敛靠机制，不靠感觉**——黏滞要紧集 + 定性判定 + confirm 门控

详见 [`docs/decisions.md`](docs/decisions.md)（ADR-0001~0010）。

---

## 项目结构

```
cinedesign/
├── backend/                          # Python FastAPI + LangGraph
│   ├── pyproject.toml
│   └── app/
│       ├── main.py                   # FastAPI 入口 + lifespan
│       ├── api/                      # sessions / respond / select / edit / stream
│       ├── graph/                    # LangGraph 编排
│       │   ├── state.py             # SessionState
│       │   ├── build.py             # StateGraph 装配（8 节点 + 4 条件边）
│       │   └── nodes/               # align, convergence, strategy,
│       │                              generate, critic, edit, writeback
│       ├── schemas/                  # Pydantic 核心契约
│       │   ├── widget.py            # Widget 协议（5 种控件）
│       │   ├── intent.py            # IntentState + DimensionState
│       │   ├── shotscript.py        # ShotScript（十参数 + serves + mechanism）
│       │   ├── recall.py            # RecallRecord + RecallResult
│       │   └── session.py           # TurnResponse + API 类型
│       ├── ontology/                 # 本体 v3（三源合并）
│       │   ├── labels_v3.json       # 分类内容（自仓库根同步）
│       │   ├── meta_v3.yaml         # A/B 类型·双极轴·值集·作用域·易混淆规则
│       │   ├── knowledge_v3.yaml    # 56 张电影语法知识卡
│       │   └── loader.py            # 合并校验 + digest 接口
│       ├── recall/                   # pgvector 检索基础设施（可选增强 + 飞轮）
│       ├── llm/                      # LLM 客户端 + 6 个 prompt 模板
│       └── db/                       # Postgres 连接池 + 迁移
├── frontend/                         # React 19 + Vite 6 + TypeScript
│   ├── package.json
│   └── src/
│       ├── types/api.ts              # API 类型定义（openapi 接入点）
│       ├── api/                      # 类型化 fetch client + SSE
│       ├── widgets/                  # registry + 5 种对齐控件
│       ├── components/               # AlignmentPanel, ScriptCompare, ShotEditor
│       └── store/session.ts          # Zustand 会话状态
├── scripts/
│   ├── init-db.sql                   # Postgres + pgvector 建表
│   └── check_ontology_sync.py        # 本体三源一致性校验
├── docker-compose.yml                # Postgres 16 + pgvector + pgadmin
├── labels_v3.json                    # 本体内容权威源（12 一级 × 56 二级）
├── 导演意图分类_v3_中文.xlsx          # 人工编辑入口（改后导出 labels_v3.json）
├── final_proposal.md                 # 终版 proposal（愿景与哲学）
├── 架构设计.md                        # 架构设计文档
└── docs/                             # 分层文档体系
    ├── README.md                     # 文档地图
    ├── decisions.md                  # ADR 日志（0001~0009）
    ├── domain/ontology-spec.md       # 本体 schema 规格
    ├── contracts.md                  # 接口契约
    ├── modules.md                    # 模块详规
    └── glossary.md                   # 术语表
```

## 技术栈

| 层 | 选型 | 用途 |
|---|---|---|
| Agent 编排 | **LangGraph** `StateGraph` | 共享状态状态机 + `interrupt` 人在环 + `Send()` 并行fan-out |
| 后端 API | **FastAPI** | async + SSE 流式；Pydantic 即 schema 源 |
| 存储（三合一） | **Postgres 16 + pgvector** | LangGraph checkpoint + 向量召回 + tags GIN 过滤 |
| 前端 | **React 19 + Vite 6 + TypeScript** | Widget registry 渲染服务端驱动 UI |
| 开发 LLM | **DeepSeek V4 Flash** | 对齐 / 生成 / 审校 |
| 生产 LLM | Claude Opus / Qwen 3.6 Plus | 后续替换 |
| 类型同步 | Pydantic → OpenAPI → `openapi-typescript` | 前后端契约不漂移 |

---

## 快速开始

### 前置条件

- Python 3.11+
- Node.js 20+
- Docker Desktop（Postgres + pgvector）
- LLM API Key（DeepSeek 等）

### 1. 启动数据库

```bash
# 启动 Postgres + pgvector
docker compose up -d

# 验证
docker compose exec postgres pg_isready -U cinedesign -d cinedesign
```

### 2. 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# 复制 .env.example 并填入 LLM_API_KEY
# cp .env.example .env  # 然后编辑 .env 填入密钥

# 启动开发服务器
uvicorn app.main:app --reload --port 8000

# API 文档 → http://localhost:8000/docs
# 健康检查 → http://localhost:8000/health
```

### 3. 前端

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

## 里程碑

| Milestone | 内容 | 当前状态 |
|---|---|---|
| **M0 地基** | 仓库骨架 + 核心 schema + Postgres + 本体加载 + LangGraph 图 | ✅ **已完成** |
| **M1 对齐闭环** | align + convergence + interrupt + widget 协议 + React 渲染器 | ✅ 首轮 HITL 已打通 |
| **M2 本体 v3 + 纯推理生成** | v3 三源合并 + 56 张知识卡 + strategy 直推 + 三层推理链 + critic 三层（ADR-0010） | ✅ **已完成** |
| **M3 选择/编辑** | present + edit_collab + revalidate | ⏳ |
| **M4 飞轮 + 检索增强** | writeback 成熟化；库有量后 strategy 检索增强自然生效 | ⏳ |

## 核心概念

| 概念 | 说明 |
|---|---|
| **设计空间 v3** | 12 一级 × 56 二级的导演意图本体；A=构成性意图（画面安排），B=效应性意图（观众反应） |
| **知识卡** | 每个二级意图一张电影语法卡（机制 + 候选手法 + 经典参照），纯推理生成的知识锚点 |
| **意图对齐** | 多轮 HITL 对话，LLM 推理式提问 + 易混淆判别探针 + 用户选择，收敛到 tags + brief |
| **Widget 协议** | 服务端驱动的 UI 协议（单选/多选/滑块/自由文本/确认），后端控制前端渲染 |
| **策略直推** | 对意图组合在设计空间内枚举 ≤3 个机制路径（主导机制族不同才算不同方向） |
| **三层推理链** | B 效果意图 → 心理/知觉机制 → A 构成手段 → 十参数;每镜 serves+rationale 可回溯 |
| **Critic** | 耦合硬规则 + serves 确定性校验 + LLM 判定（机制链忠实/易混淆误用/双极轴自洽） |
| **飞轮 (Flywheel)** | 用户采纳的脚本 + 意图 → 回写方案库 → 未来 strategy 检索增强自然生效 |
| **参考基底图(必传)** | 会话 = 为画面设计重拍摄方案;画面锚定主体与空间,风格服从用户意图、允许剧变(喜剧→恐怖);视觉描述注入全链路(ADR-0011/0012) |
| **关键帧渲染** | 候选页按方案触发:基底图 + 每镜重摄指令(`frame_edit_hint`)经 qwen-image 图像编辑逐镜出帧,落 uploads/ 回填 `frame_image`(ADR-0012) |

## 设计决策（ADR）

重要的架构决策记录在 [`docs/decisions.md`](docs/decisions.md)。核心决策一览：

- **ADR-0001**: 对齐用推理，不用数值打分
- **ADR-0002**: 设计空间为唯一审美与知识来源
- **ADR-0003**: 收敛 = 黏滞要紧集 + LLM 定性推理
- **ADR-0004**: 编排用 LangGraph
- **ADR-0005**: 技术栈 Python+FastAPI+Postgres/pgvector+React
- **ADR-0006**: 十参数为镜头实例标准（技法列同步 7→10）
- **ADR-0007**: 本体元字段落定（已被 ADR-0010 取代）
- **ADR-0008**: 方案库不灌种子，全由飞轮自增长（已被 ADR-0010 取代）
- **ADR-0009**: Critic 耦合规则：硬编码规则表 + LLM 判定
- **ADR-0010**: 本体 v3 + 纯推理为生成基线，检索降级为可选增强
- **ADR-0011**: 参考基底图贯穿会话 + 镜头帧渲染接入点
- **ADR-0012**: 关键帧渲染接入 + 重拍摄语义（输入必须带图）

## 阅读顺序

新人/新 agent 从这里开始：

1. [`AGENTS.md`](AGENTS.md) — 行为规范与黄金法则
2. [`docs/README.md`](docs/README.md) — 文档地图
3. [`final_proposal.md`](final_proposal.md) — 愿景与哲学
4. [`docs/domain/ontology-spec.md`](docs/domain/ontology-spec.md) — 本体规格
5. [`架构设计.md`](架构设计.md) — 系统架构
6. [`docs/contracts.md`](docs/contracts.md) — 接口契约
7. [`docs/modules.md`](docs/modules.md) — 模块详规

---

*CineDesign — 把模糊的创意变成精确的镜头语言。*
