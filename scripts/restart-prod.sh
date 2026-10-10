#!/usr/bin/env bash
# Пересобирает приложение и перезапускает локальный production-сервер на порту 3100.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3100}"
pids="$(lsof -ti tcp:"$PORT" || true)"
if [ -n "$pids" ]; then kill $pids || true; sleep 1; fi
npm run build 2>&1 | tail -n 8
mkdir -p .data
nohup npx next start -p "$PORT" > .data/next-start.log 2>&1 &
sleep 4
echo "server on :$PORT"
