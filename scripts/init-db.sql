-- Initialize Postgres for cinedesign
-- This runs on first container start via docker-entrypoint-initdb.d

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- NOTE: 不要在这里 DROP langgraph 的 checkpoint 表!这个脚本每次启动都跑,
-- DROP 会清空所有会话,导致重启后"载入历史"全部 Session not found。
-- checkpoint 表完全交给 PostgresSaver.setup() 幂等管理(已存在即跳过)。
-- 如确需因 schema 不兼容重建,请手动单次执行,不要放进启动脚本。

-- Solution library table (for recall + writeback)
-- Initially empty — grows via flywheel
CREATE TABLE IF NOT EXISTS solution_library (
    record_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_tags    TEXT[] NOT NULL,              -- ontology leaf IDs, GIN-indexed
    intent_brief   TEXT NOT NULL,
    embedding      VECTOR(768),                  -- OpenAI text-embedding-3-small
    shot_script    JSONB NOT NULL,               -- full ShotScript
    provenance     TEXT NOT NULL DEFAULT 'user_accepted'
                       CHECK (provenance IN ('curated', 'user_accepted')),
    quality_signal REAL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GIN index for tags structured filtering
CREATE INDEX IF NOT EXISTS idx_solution_library_tags
    ON solution_library USING GIN (intent_tags);

-- HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_solution_library_embedding
    ON solution_library USING HNSW (embedding vector_cosine_ops);

-- Notify PostgreSQL is ready
DO $$ BEGIN
    RAISE NOTICE 'cinedesign database initialized successfully';
END $$;
