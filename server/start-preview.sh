#!/bin/sh
# 以后台常驻方式启动后端（脱离终端会话，避免随 shell 退出被回收）
# 数据库配置通过环境变量注入，不写死在代码中
export DB_HOST=${DB_HOST}
export DB_PORT=3306
export DB_USER=${DB_USER}
export DB_PASSWORD=${DB_PASSWORD}
export DB_NAME=${DB_NAME}
cd /data/workspace/${DB_NAME}/workspace/server
setsid nohup node src/index.js > /tmp/server.log 2>&1 < /dev/null &
echo "started pid=$!"
