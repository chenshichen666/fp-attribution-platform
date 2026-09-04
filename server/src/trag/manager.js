/**
 * TRAG 服务生命周期管理（方案 A）
 *
 * 主链路：Node 直接转发到正式 TRAG 检索 HTTP API（见 ./upstream.js），
 * 本地 Python 微服务不再默认启动，仅在 TRAG_MODE=local 时作为兜底保留。
 *
 * 保留 getStatus / setAvailable / isAvailable 等接口，供路由层与 /api/health 上报使用。
 */

import { isLocalMode, health as upstreamHealth, baseUrl } from './upstream.js'

// ===== 配置 =====
const TRAG_ENABLED = (process.env.TRAG_AVAILABLE || 'true').toLowerCase() !== 'false'
const LOCAL_MODE = isLocalMode()

// ===== 状态 =====
let startedAt = null
let localUnavailableHint = null
// 上游模式真实健康探测结果缓存（避免每次 /api/health 都打 IDC 集群）
let _upstreamHealthy = null
let _upstreamHealthyAt = 0
const HEALTHY_TTL_MS = 15000

/**
 * 获取 TRAG 服务当前状态（供路由层 / /api/health 使用）
 *
 * 关键修复：上游模式下不能恒报 healthy:true（否则误导运维与用户）。
 * 必须真正探测 IDC 集群（/api/health），连不上（403 ACL / 网络不可达）
 * 就如实报 healthy:false，并带出原因 hint，前端据此提示"需 IDC 网络/igate 权限"。
 */
export async function getStatus() {
  let healthy = TRAG_ENABLED
  let hint = localUnavailableHint
  if (TRAG_ENABLED && !LOCAL_MODE) {
    const now = Date.now()
    if (_upstreamHealthy === null || now - _upstreamHealthyAt > HEALTHY_TTL_MS) {
      try {
        _upstreamHealthy = await upstreamHealth()
      } catch {
        _upstreamHealthy = false
      }
      _upstreamHealthyAt = now
    }
    healthy = _upstreamHealthy
    if (!healthy) {
      hint = hint || `上游 TRAG 检索集群不可达（${baseUrl()}）：DevCloud 访问 IDC 需 igate 源 IP 白名单，否则返回 403 ACL 拦截`
    }
  }
  return {
    enabled: TRAG_ENABLED,
    mode: LOCAL_MODE ? 'local' : 'upstream',
    available: TRAG_ENABLED && healthy,
    starting: false,
    healthy,
    serviceUrl: LOCAL_MODE ? getLocalServiceUrl() : null,
    baseUrl: LOCAL_MODE ? null : baseUrl(),
    startedAt,
    localUnavailableHint: hint,
  }
}

function getLocalServiceUrl() {
  const port = parseInt(process.env.TRAG_PORT || '9100', 10)
  return process.env.TRAG_SERVICE_URL || `http://127.0.0.1:${port}`
}

/**
 * 兼容旧路由层：上游模式下始终返回可用（请求时若不可达由 upstream 抛 503）。
 */
export function getServiceUrl() {
  if (!TRAG_ENABLED) return null
  if (LOCAL_MODE) return getLocalServiceUrl()
  return 'upstream'
}

/**
 * 兼容旧调用：标记不可用（上游模式下仅记录提示，不重启进程）。
 */
export function markUnhealthy(reason) {
  if (reason) localUnavailableHint = reason
  console.warn(`[TRAG] 服务暂不可用: ${reason || 'unknown'}`)
}

/**
 * 启动 TRAG 服务。
 * - 上游模式（默认）：不做任何进程管理，直接返回 true（请求时按需转发）。
 * - 本地模式（TRAG_MODE=local）：由本地 Python 微服务管理模块负责 spawn。
 */
export async function start() {
  startedAt = new Date()
  if (!TRAG_ENABLED) {
    console.log('[TRAG] TRAG_AVAILABLE=false，跳过启动')
    return false
  }
  if (LOCAL_MODE) {
    // 延迟 require，避免上游模式加载 Python 管理逻辑
    const local = await import('./managerLocal.js')
    return local.startLocal()
  }
  console.log(`[TRAG] 上游模式：直接转发到正式 TRAG 检索 API（${process.env.TRAG_API_BASE || 'http://fine.data.retrieval.api.polaris:8080'}）`)
  return true
}

export function stop() {
  if (LOCAL_MODE) {
    import('./managerLocal.js').then((m) => m.stopLocal?.()).catch(() => {})
  }
}
