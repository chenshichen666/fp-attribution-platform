#!/bin/sh
# 容器入口脚本
# Python TRAG 微服务现在由 Node 进程内部管理（trag/manager.js），
# 不再需要在此脚本中手动启动，彻底消除了两个独立进程之间 ECONNREFUSED 的问题

echo "[entrypoint] 启动 Node 主服务（TRAG Python 子进程将由 Node 自动管理）..."
exec node server/src/index.js
