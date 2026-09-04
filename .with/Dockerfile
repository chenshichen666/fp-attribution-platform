# Multi-stage build for fp-attribution-platform (Vue + Express + Python TRAG)
# 使用 bookworm（Debian 12）而非 alpine，因为 alpine 无 Python 运行时，
# 导致线上 TRAG 相似检索功能因 Python 微服务无法启动而完全不可用。
FROM node:20-bookworm AS base

# Install dependencies only when needed (frontend)
FROM base AS frontend-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Build frontend
FROM frontend-deps AS frontend-build
WORKDIR /app
COPY . .
RUN npm run build

# Install dependencies only when needed (backend)
FROM base AS backend-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --only=production

# Production stage
FROM base AS runner
WORKDIR /app

# Set timezone to Asia/Shanghai
ENV TZ=Asia/Shanghai
ENV DEBIAN_FRONTEND=noninteractive

# Install Python 3 + pip (bookworm 自带 python3，但需要安装 pip 和 venv)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 --version

# Don't run as root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# Copy frontend build output
COPY --from=frontend-build --chown=nodejs:nodejs /app/dist ./dist

# Copy prototype static demos (for /prototype/* preview routes)
COPY --from=frontend-build --chown=nodejs:nodejs /app/prototype ./prototype

# Copy backend source
COPY --from=backend-deps --chown=nodejs:nodejs /app/server/node_modules ./server/node_modules
COPY --chown=nodejs:nodejs server/src ./server/src
COPY --chown=nodejs:nodejs server/package.json ./server/package.json

# Copy TRAG Python microservice files
COPY --chown=nodejs:nodejs server/trag_service ./server/trag_service

# Install Python TRAG dependencies (trag SDK + FastAPI + uvicorn + pymysql)
# --break-system-packages: Debian 12 PEP 668 要求，非虚拟环境需加此 flag
# trag SDK 是腾讯内网包（调用 trag.example.com），公共 PyPI 上的 trag 是完全不同的开源项目，
# 必须配置内网 PyPI 源才能安装。npm 用的是 mirrors.tencent.com，pip 同理。
RUN pip3 config set global.index-url https://mirrors.tencent.com/pypi/simple/ && \
    pip3 config set global.trusted-host mirrors.tencent.com && \
    pip3 install --no-cache-dir --break-system-packages \
    -r /app/server/trag_service/requirements.txt \
    || echo "[WARN] TRAG SDK 安装失败，检索功能将降级为 503（内网 PyPI 源可能不可用）"

USER nodejs

# 端口说明（关键，避免发布就绪探针失败）：
# 平台生产 K8s Service / readinessProbe 在「首次部署」时锁定为 8000，且后续无法从 Dockerfile 更改
# （日志可见 Service apply 报 metadata.resourceVersion 错误，维持 8000）。
# 平台预览网关 devc.preview.platform.example.com 固定访问 36111。
# 因此容器必须「同时」监听 8000（满足生产就绪探针）与 36111（满足预览网关），见 server/src/index.js 的双监听。
EXPOSE 8000 36111

ENV NODE_ENV=production
ENV PORT=8000

# Database config — 写入实际值，避免部署平台未注入环境变量导致容器内拿不到 DB_HOST
ENV DB_HOST="${DB_HOST}"
ENV DB_PORT="3306"
ENV DB_NAME=${DB_NAME}
ENV DB_USER=${DB_USER}
ENV DB_PASSWORD=${DB_PASSWORD}

# TRAG service config (optional)
# 默认上游模式：直接转发正式 TRAG 检索 HTTP API（独立集群/独立模型）
# 仅在 TRAG_MODE=local 时启动本地 Python 微服务兜底
ENV TRAG_MODE="upstream"
ENV TRAG_API_BASE="http://fine.data.retrieval.api.polaris:8080"
ENV TRAG_PORT="9100"
ENV TRAG_SERVICE_URL=""

CMD ["node", "server/src/index.js"]
