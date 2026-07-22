# Agent-as-Judge 评估：Pilot 诊断与修复记录

> 记录用 qwen3.7-plus 跑小规模评估 pilot 的过程、暴露的问题、已做的修复，以及**最后一个待决瓶颈**（确证预算 vs 问题增殖）。供决定是否放大到正式实验。
> 生成器 qwen3.7-plus，判官 doubao-seed-2-1-turbo（同 endpoint 不同模型），均经同一个 OpenAI 兼容网关。评估**不生图不生视频**。

## 1. 结论先行

- **harness 与实验骨架验证通过**：三臂开关（off/naive/full）、persona 代理、盲评判官、指标聚合、报告结构全部跑通并产出完整 JSON。
- **本轮为"探针触发率"做的机制修复，实测生效**：探针从 pilot 早期的 **0–1 次** 提升到 **6 次/4 会话**，问题从"卡在 observed"推进到 **6 道 tentative**。
- **但仍未拿到 corroborated**，因此 skill 从未激活、full≈off、taste 全平局——**这不是 bug，是一个已量化的规模/预算问题**（见 §4）。
- 过程中还修掉两个会毁掉正式实验的**基础设施缺陷**（reload 崩溃、LLM 无超时）。

## 2. Pilot 时间线（5 轮，每轮 25–40 分钟）

| 轮次 | 结果 | 暴露的问题 |
|---|---|---|
| pilot1 | 全 NaN | **后端 `uvicorn --reload` 长负载崩溃** → full 臂全灭 |
| pilot2 | 判官阶段卡死 | 生成跑完，判官某调用挂起；**LLM 无显式超时**，SDK 默认 600s×重试 → 单次卡十几分钟 |
| pilot3(初) | 判官超时 = 假平局 | 判官 prompt 大、150s 太紧；且账本 **0 corroborated、5 会话仅 1 探针** |
| pilot4 | full≈off 空结果 | 根因：**探针几乎不触发**（scope 单叶子精确匹配太脆） |
| probe-check3 | **探针 6 次、6 tentative** ✓ | context_tags 修复生效;新瓶颈:**确证预算被增殖的问题摊薄** |

## 3. 已做的修复（均单测通过，67 passed）

### 3.1 基础设施
- **无 reload 常驻后端**：`uvicorn --no-access-log`（不用 `run.py` 的 reload），长批量下稳跑 60+ 分钟不崩。
- **LLM 显式超时**：`client._ensure_client` 加 `timeout=180s(可 LLM_TIMEOUT_S 调), max_retries=1`；挂起调用快速失败（harness 本就把判官失败记平局）。
- **结构化节点关 thinking**：align/convergence/strategy/critic/edit/reflect 传 `enable_thinking=False`（generate 保留）；对齐一轮 **1–2 分钟 → 24s**。这些节点只出 JSON 判断，无需思维链。

### 3.2 机制（探针触发率——本轮核心）
根因链：**探针在 CineScape 的 pre-ADR-0013 拓扑下几乎不触发** →
1. **召回时机太脆**：原挂在 align 用"临时维度候选码"，早期为空、又常单轮收敛就没机会召回。
   **修复**：召回+选题上移到 **convergence 节点**，用**已确认的 tags**——收敛必经、tags 已定、对快速收敛会话也有效。align 侧移除。
2. **单叶子 scope 精确匹配太脆**：同主题会话产出**重叠但不相同**的 tag 集（会话1 有 `11.2`、会话2 是 `[8.3,1.2,4.2,3.4,10.2,6.2]` 没 11.2），问题 scope 归到单个叶子 → 后续会话召不回。
   **修复**：新增 `preference_questions.context_tags TEXT[]`（发现会话的确认 tags），**召回按数组重叠** `context_tags && session_tags`，applicability 同步放宽。这正是论文 "recurring **context**" 的本意——上下文是一组意图、按重叠匹配，不是单叶子精确相等。
3. **发现阶段 scope 归错**：LLM 曾把偏好归到无关叶子。
   **修复**：discover prompt 强制 scope 取自会话确认 tags 或 global（跨场景风格）。已验证生效（scope 从 6.2 变成会话内的 11.2）。

**验证数据**（probe-check3，full-only 4 会话）：探针 6 次、6 道 tentative、每道带 5–8 个 context_tags。**机制 engage 了**。

## 4. 待决瓶颈：确证预算 vs 问题增殖（有数据）

probe-check3 最终账本：**8 道问题、每题最多 1 个答案（均值 0.75）、0 corroborated**。

原因链：
- 反思**每会话都发现新问题**（4 会话 → 8 道），问题集快速膨胀；
- 公平轮询**每会话仅 1 条探针**，且"未验证优先"会**把探针摊到不同问题上**（雨露均沾）；
- 结果每道问题只攒到 ≤1 个答案，而 corroborated 需要 **≥2 个不同会话一致** → 永远到不了。

这是设计"慢于声称"的如实体现，但对实验有硬性含义：**当前配置下，学习会话数远不够让任何问题确证**。可选杠杆（需你定，涉及是否动 ADR-0017）：

| 杠杆 | 效果 | 代价 |
|---|---|---|
| **限制每会话发现问题数**（如 ≤1） | 问题集不膨胀，探针集中，几会话即可确证 | 学得窄;需改 reflect |
| **公平轮询偏向复核 tentative** | 已答过的优先再问 → 快速确证 | 削弱"未验证优先"的探索,需权衡 |
| **加学习会话**（如 ≥8–10） | 不改设计,靠会话数堆确证 | 慢:每会话 ~6 分钟,10 会话/臂 ×2 臂 ×判官 ≈ 2.5 小时 |
| **降 persona 噪声**(0.1→0) | 答案更一致,确证更快 | 偏离"答案有噪声"的稳健性验证 |

**推荐**：前两个杠杆二选一（限制发现数最干净），改完后 4–6 学习会话即可看到确证→skill 激活→full≠off 的完整链路。

## 5. 其余待办
- **判官超时放宽到 300–400s**（150–200s 对大 prompt 偏紧，造成过 pilot3 假平局）。
- **guardrail 判官偶发返回空**（fidelity/craft n=0）：doubao 偶尔不给可解析 rubric 或超时;放宽超时后观察，必要时加重试或 few-shot。
- probe-check3 出现 **8 会话**（预期 4）的小异常，待核 harness 的 run() 循环是否重复。
- 一处仓库间漂移：这些机制修复只在 CineScape;本地 cinedesign 的 evolution 副本未同步（两仓已分头,以 CineScape 为准）。

## 6. 代码改动清单（本轮，未提交）
- `app/llm/client.py`：超时。
- `app/graph/nodes/{align,convergence,critic,strategy,edit}.py` + `app/evolution/reflect.py`：thinking off。
- `app/graph/nodes/convergence.py`：召回+选题上移。
- `app/graph/nodes/align.py`：移除脆弱的 align 侧召回。
- `scripts/init-evolution.sql` + `app/evolution/questions.py` + `reflect.py` + `app/api/sessions.py`：`context_tags` 列 + 重叠召回 + applicability 放宽。
- `app/llm/prompts.py`：discover scope 约束。
- `app/graph/state.py` + `app/api/sessions.py` + `generate.py` + `build.py` + `app/evolution/skills.py`：`memory_mode` 三臂开关（off/naive/full）+ naive 风格便签。
- `app/eval/`（personas/metrics/judge/simulate/harness）+ `run_eval.py` + `tests/test_eval_metrics.py`：评估 harness，20 单测。
- `app/api/memory.py`：暴露 `prevailing_detail`（账本 precision 用）。
