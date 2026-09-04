#!/usr/bin/env bash
# 误杀归因平台 —— 一键启动脚本
# 用法：bash start.sh            （默认端口 8787）
#       PORT=8080 bash start.sh  （指定端口）
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
export PORT

echo "== 1/4 检查 Node =="
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node，请先安装 Node 20+（步骤见 部署说明.md）"
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node 版本过低：$(node -v)，需要 20 或更高"
  exit 1
fi
echo "   Node $(node -v)  ✓"

echo "== 2/4 安装依赖（首次运行约 1-3 分钟）=="
if [ ! -d server/node_modules ]; then
  # 国内服务器默认走淘宝镜像，避免 npm 官方源超时
  npm config set registry https://registry.npmmirror.com 2>/dev/null || true
  (cd server && npm install --omit=dev --no-audit --no-fund)
  echo "   依赖安装完成 ✓"
else
  echo "   已存在 node_modules，跳过 ✓"
fi

echo "== 3/4 停止旧进程（如有）=="
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then kill -9 $PIDS 2>/dev/null || true; echo "   已清理端口 $PORT"; fi
elif command -v fuser >/dev/null 2>&1; then
  fuser -k $PORT/tcp 2>/dev/null || true
fi
echo "   ✓"

echo "== 4/4 启动服务（端口 $PORT）=="
cd server
nohup node src/index.js > ../server.log 2>&1 &
echo $! > ../server.pid
cd ..
sleep 5

echo ""
echo "== 健康检查 =="
HEALTH=$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$PORT/api/health" || echo "")
if [ -n "$HEALTH" ]; then
  echo "   服务正常：$HEALTH" | head -c 200
  echo ""
  echo ""
  echo "✔ 启动完成！"
  echo "  本机访问： http://127.0.0.1:$PORT"
  echo "  外网访问： http://<你的服务器公网IP>:$PORT"
  echo "  日志文件： $(pwd)/server.log"
  echo ""
  echo "  注意：需在云厂商「安全组/防火墙」放行 TCP $PORT 端口，否则外网打不开。"
else
  echo "  暂未响应，请查看日志： tail -50 $(pwd)/server.log"
fi
