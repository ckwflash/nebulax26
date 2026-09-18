#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x .venv/bin/python || ! -d node_modules ]]; then
  echo 'Install dependencies first: uv sync --extra test && npm ci'
  exit 1
fi
env_args=()
if [[ -f .env ]]; then env_args=(--env-file .env); fi
.venv/bin/python -m uvicorn trackaccess.api:app --host 127.0.0.1 --port 8000 "${env_args[@]}" &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT INT TERM
npm run dev
