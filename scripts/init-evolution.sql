-- =========================================================================
-- ADR-0017 · 偏好问题模型:行为提出、探针裁决、prevailing 收敛、会话级 skill
-- 本脚本 **不依赖 pgvector**,与 init-db.sql 分离执行:即使 Windows 环境缺
-- pgvector 而跳过 solution_library,自进化外环的三张表仍可用。幂等。
-- =========================================================================

-- ① 交互事件流(append-only,采集与消费解耦;图状态零接触)
CREATE TABLE IF NOT EXISTS interaction_trace (
    event_id   BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id    TEXT NOT NULL DEFAULT 'anonymous',
    ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'session_start', 'align_answer', 'candidate_select', 'edit_patch',
        'render_request', 'adopt', 'probe_response', 'skill_activation',
        'skill_outcome', 'memory_action', 'frontend_event')),
    payload    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_trace_session ON interaction_trace (session_id);
CREATE INDEX IF NOT EXISTS idx_trace_user    ON interaction_trace (user_id, ts);

-- ② 偏好问题账本(记忆单元 = 问题 q=(c,d,a,b);行为提出、探针裁决)
CREATE TABLE IF NOT EXISTS preference_questions (
    question_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('intent_leaf', 'mechanism', 'global')),  -- c
    scope_id   TEXT,                     -- 叶子 ID / 机制族名;global 为 NULL
    decision   TEXT NOT NULL,            -- d: 电影化决策轴(展示)
    context_tags TEXT[] NOT NULL DEFAULT '{}',  -- 发现会话的确认 tags;召回按与当前会话 tags 的重叠匹配
    alt_a      JSONB NOT NULL,           -- {label, detail:{field:value,...}, mechanism?}
    alt_b      JSONB NOT NULL,
    answers    JSONB NOT NULL DEFAULT '[]',   -- [{session_id, answer: a|b|open}]
    status     TEXT NOT NULL DEFAULT 'observed'  -- 派生自 answers(冗余存储便于查询)
                   CHECK (status IN ('observed', 'tentative', 'corroborated')),
    user_flag  TEXT NOT NULL DEFAULT 'none'
                   CHECK (user_flag IN ('none', 'emphasized', 'revoked')),
    last_probed_at TIMESTAMPTZ,          -- 公平轮询:最久未复核
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pq_user_scope
    ON preference_questions (user_id, scope_type, scope_id);
ALTER TABLE preference_questions ADD COLUMN IF NOT EXISTS context_tags TEXT[] NOT NULL DEFAULT '{}';

-- ③ 用户画像(保留表用于审计)
CREATE TABLE IF NOT EXISTS user_profile (
    user_id    TEXT PRIMARY KEY,
    expertise  TEXT NOT NULL DEFAULT 'novice'
                   CHECK (expertise IN ('novice', 'intermediate', 'expert')),
    rationale  TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
