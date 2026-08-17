# CineScape 纵向用户评测 · 运行手册（Runbook）

> 覆盖范围：如何启动测试服务器、创建参与者、跑通一轮完整评测、数据落点与常见问题。
> 评测载体 = **CineScape 后端**（`~/CineScape/backend`）+ **CineScape 前端**（`~/CineScape-frontend`），
> 与 cinedesign 仓库中的 ADR-0019/0020、设计文档 `docs/evaluation-user-study-design.md` 对应。

---

## 1. 架构总览

| 组件 | 技术 | 端口/地址 |
|---|---|---|
| 后端 | FastAPI + LangGraph（即梦渲染、记忆三臂、`/api/study` 评测层） | `http://localhost:8000`（docs: `/docs`） |
| 前端 | React + Vite（3D 编辑器 + 评测视图） | `http://localhost:5180` |
| 数据库 | Postgres + pgvector（Docker，容器 `cinescape-pg`） | `localhost:5434`（5432/5433 常被其他项目占用） |
| 评测入口 | `?study=<participant_code>` | `http://localhost:5180/?study=P01` |

**评测流程（每位参与者）**：5 个学习会话（对齐→方案→编辑→采纳，记忆按 `user_id` 累积）→ 6 个 held-out cases（对齐一次 → 双分支 with/without 生成 → 成品视频并排盲标 X/Y → 偏好 + 6 项评分）。

---

## 2. 前置依赖

- **Python 3.13 venv**：`~/CineScape/backend/.venv`（已装 uvicorn / langgraph / psycopg / httpx 等）
- **Node 依赖**：`~/CineScape-frontend/node_modules`（已 `npm install`）
- **Docker**：用于 Postgres 容器
- **`.env`**：`~/CineScape/backend/.env`（注意：**必须是 backend/ 下**，pydantic-settings 相对 CWD 解析）
  - `DATABASE_URL=postgresql://cinedesign:cinedesign_dev@localhost:5434/cinedesign`
  - `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `IMAGE_MODEL` 等（后端启动必需）
  - `EVAL_ALLOW_FROZEN_ALIGNMENT=1`（评测双分支必需；`frozen_alignment` 只对 eval 用户开放）
- **（可选）即梦 CLI**：`dreamina` 放 `~/.local/bin/`，用于 heldout 成品视频（`multimodal2video`）；未装则视频渲染降级（关键帧/无视频），learning 阶段不受影响

---

## 3. 启动步骤

### 3.1 数据库（表自动建）

```bash
cd ~/CineScape
docker compose up -d postgres        # 容器 cinescape-pg，映射 5434
# 首次启动会自动执行 scripts/init-db.sql + scripts/init-evolution.sql
# （含 study_participants / study_runs / study_cases / study_choices 与探针调度列）
docker exec cinescape-pg psql -U cinedesign -d cinedesign -c "\dt"   # 检查表
```

### 3.2 后端

```bash
cd ~/CineScape/backend
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
# 启动成功标志：INFO: Application startup complete.
# 启动时会自动把评测素材复制到 backend/uploads/study/（30 张场景图，幂等）
```

> ⚠️ 改后端代码后必须重启（未开 `--reload`），否则新端点 404。

### 3.3 前端

```bash
cd ~/CineScape-frontend
npm run dev          # Vite dev server → http://localhost:5180
```

### 3.4 验证服务健康

```bash
curl http://localhost:8000/api/study/participants/P01     # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5180/   # 200
```

---

## 4. 创建参与者

```bash
curl -X POST http://localhost:8000/api/study/participants \
  -H 'Content-Type: application/json' \
  -d '{"code": "P01", "literacy": "novice", "intent_code": "1.5"}'
# literacy: novice | intermediate | expert
# intent_code: 1.5 | 3.4 | 8.2
# 幂等：同 code 重复创建返回已有参与者
```

创建后自动生成：5 个 learning runs（learning-01..05）+ 6 个 heldout cases（场景轮转、`condition_order` 交替平衡），`user_id = eval-<code>`。

---

## 5. 一轮完整评测（参与者视角）

1. 打开 `http://localhost:5180/?study=P01`
2. **学习会话 k/5**：参考图自动预置（场景素材），依次完成
   - 意图助手（对齐）→ A/B/C 方案比较 → 选择 → 编辑 → 采纳
   - 点「完成本学习会话」→ 按钮变 **「正在整理你的偏好记忆…（约 30–60 秒）」**
     —— 后端同步跑 reflection 落账（会话边界屏障），整理完成才进入下一步
3. **评测 case n/6**：先走一次对齐确认 brief/tags → 系统自动 `generate-pair`
   - with 分支：`memory_mode=full` + 自动 enact 技能
   - without 分支：`memory_mode=off`（无记忆）
   - 两分支成品视频异步渲染（即梦/ffmpeg），前端轮询等待
4. 双视频并排（盲标 **X/Y**，不显示条件）→ 选择偏好（X / Y / 都差不多）→ 6 项 Likert 评分 → 提交
5. 全部完成 → 通知实验员进行 trace-grounded 访谈

---

## 6. 数据落点与导出

| 数据 | 位置 |
|---|---|
| 参与者/计划/选择/评分 | DB：`study_*` 表 |
| 偏好记忆账本 | DB：`preference_questions` + `user_profile`（探针调度状态） |
| 交互轨迹（对齐/选择/编辑/采纳/skill 事件） | DB：`interaction_trace` |
| 素材/关键帧/视频 | `backend/uploads/`（study 素材、渲染产物） |
| 按参与者导出 | `GET /api/study/participants/{id}/export`（JSON：学习轨迹 + 选择 + 评分） |

**论文表格脚本**：`cinedesign/scripts/analyze_eval_v6.py`（仿真数据统计）；真人评测数据按相同指标（相似度、捕捉、偏好、6 项评分）单独汇总。

---

## 7. 关键 API 速查（/api/study）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/participants` | 创建参与者 + 计划 |
| GET | `/participants/{code}` | 查参与者 |
| GET | `/participants/{id}/plan` | 任务清单（learning + heldout + 盲标 X/Y） |
| POST | `/runs/{run_id}/finish` | **学习会话完成屏障**：同步整理记忆 + 置 done |
| POST | `/cases/{case_id}/generate-pair` | 双分支生成（守卫：学习未全部完成 → 409） |
| POST | `/cases/{case_id}/choice` | 提交偏好 + 6 项评分 |
| GET | `/participants/{id}/export` | 汇总导出 |

---

## 8. 常见问题排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 点「完成」报 `API 404: Not Found` | 后端进程未加载新端点（无 `--reload`） | 重启后端 |
| 报 `该学习会话尚无 session` | 会话没真正创建/采纳 | 先走完当前会话交互再点完成 |
| `generate-pair` 返回 409 | 学习会话未全部 finish | 完成 5 个学习会话（记忆已整理） |
| 视频一直"渲染中…" | 即梦 CLI 未装 / 渲染失败 | 装 `dreamina` CLI；或接受降级（仅关键帧） |
| 页面白屏（控制台 Hook 顺序错误） | 前端 hooks 早退 | 检查 study 组件 hooks 在条件 return 之前 |
| 数据写错库 | `backend/.env` 的 DATABASE_URL 端口不对 | 确认指向 5434（cinescape-pg） |
| 5432/5433 端口冲突 | 其他项目占用 | 本评测固定用 5434（compose 已映射） |

---

## 9. 验证命令（改代码后跑）

```bash
# 后端单测（探针调度/账本状态/技能结构等）
cd ~/CineScape/backend && .venv/bin/python -m pytest tests/ -q

# 后端 import + study 路由检查
cd ~/CineScape && .venv/bin/python scripts/verify_cinescape_study.py

# study API 冒烟（需后端已启动）
cd ~/CineScape && .venv/bin/python scripts/smoke_study_api.py

# 前端构建
cd ~/CineScape-frontend && npm run build
```
