#!/usr/bin/env bash
# 停止服务
cd "$(dirname "$0")"
PORT="${PORT:-8787}"

if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
    echo "已停止服务（端口 $PORT）"
  else
    echo "服务未在运行"
  fi
elif [ -f server.pid ]; then
  kill -9 "$(cat server.pid)" 2>/dev/null || true
  rm -f server.pid
  echo "已停止服务"
else
  echo "服务未在运行"
fi
