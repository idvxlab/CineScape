#!/usr/bin/env bash
set -euo pipefail

# CineDesign 开发启动脚本
# 用法: ./scripts/dev.sh [backend|frontend|db|all]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

dev_backend() {
    echo "=== 启动后端 (uvicorn) ==="
    cd backend
    source .venv/bin/activate
    uvicorn app.main:app --reload --port 8000 --host 0.0.0.0
}

dev_frontend() {
    echo "=== 启动前端 (Vite) ==="
    cd frontend
    npm run dev
}

dev_db() {
    echo "=== 启动数据库 (Docker Compose) ==="
    docker compose up -d postgres
    echo "等待 Postgres 就绪..."
    sleep 3
    docker compose exec postgres pg_isready -U cinedesign -d cinedesign
    echo "DB 已就绪 (localhost:5432)"
}

case "${1:-all}" in
    backend)
        dev_backend
        ;;
    frontend)
        dev_frontend
        ;;
    db)
        dev_db
        ;;
    all)
        echo "启动所有服务..."
        dev_db
        dev_backend &
        BACKEND_PID=$!
        dev_frontend &
        FRONTEND_PID=$!
        echo "后端 PID: $BACKEND_PID, 前端 PID: $FRONTEND_PID"
        echo "前端: http://localhost:5173"
        echo "后端: http://localhost:8000/docs"
        wait
        ;;
    *)
        echo "用法: $0 [backend|frontend|db|all]"
        exit 1
        ;;
esac
