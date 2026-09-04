/**
 * TRAG 本地 Python 微服务管理器（仅 TRAG_MODE=local 时启用）
 *
 * 保留历史实现：Node 启动时自动 spawn Python uvicorn 子进程，持续健康检查，
 * 崩溃自动重启。该链路依赖脆弱的 trag SDK + ElementHub，仅作为兜底。
 */

import { spawn, execSync } from 'node:child_process'
import createRequire from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const TRAG_PORT = parseInt(process.env.TRAG_PORT || '9100', 10)
const TRAG_SERVICE_URL = process.env.TRAG_SERVICE_URL || `http://127.0.0.1:${TRAG_PORT}`
const HEALTH_CHECK_INTERVAL_MS = 10_000
const HEALTH_CHECK_TIMEOUT_MS = 3_000
const MAX_RESTART_COUNT = 5
const RESTART_BACKOFF_BASE_MS = 2_000
const STARTUP_WAIT_MAX_MS = 30_000
const STARTUP_POLL_INTERVAL_MS = 500

let childProcess = null
let isHealthy = false
let isStarting = false
let restartCount = 0
let lastHealthCheckTime = null
let healthCheckTimer = null
let startedAt = null

export function getStatus() {
  return {
    available: isHealthy,
    starting: isStarting,
    healthy: isHealthy,
    restartCount,
    serviceUrl: TRAG_SERVICE_URL,
    startedAt,
    lastHealthCheckTime,
    pid: childProcess?.pid || null,
  }
}

export function getServiceUrl() {
  return isHealthy ? TRAG_SERVICE_URL : null
}

export function markUnhealthy(reason) {
  if (!isHealthy && !isStarting) return
  console.warn(`[TRAG:local] ⚠️ 路由层报告服务不可用: ${reason || 'unknown'}`)
  isHealthy = false
  setTimeout(() => _runHealthCheckNow(), 0)
}

export async function startLocal() {
  try {
    execSync('which python3', { stdio: 'ignore' })
  } catch {
    console.warn('[TRAG:local] python3 不可用，跳过 TRAG 服务启动')
    return false
  }

  console.log('[TRAG:local] 启动 Python TRAG 微服务...')
  isStarting = true
  await _spawnProcess()
  const ready = await _waitForReady(STARTUP_WAIT_MAX_MS)
  isStarting = false

  if (ready) {
    _startHealthCheck()
    return true
  } else {
    console.warn('[TRAG:local] ⚠️ Python TRAG 微服务启动超时，将在后台持续重试...')
    _startHealthCheck()
    return false
  }
}

export function stopLocal() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  if (childProcess) {
    childProcess.kill('SIGTERM')
    setTimeout(() => {
      if (childProcess) {
        childProcess.kill('SIGKILL')
        childProcess = null
      }
    }, 5000)
  }
}

// ===== 内部实现 =====

function _findPidOnPort(port) {
  try {
    const { execSync } = require('node:child_process')
    let out = ''
    try {
      out = execSync(`ss -ltnp "sport = :${port}" 2>/dev/null || true`).toString()
    } catch { /* ss 不存在 */ }
    if (!out.trim()) {
      try {
        out = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`).toString()
        if (out.trim()) {
          return out.split('\n').map((s) => parseInt(s, 10)).filter(Boolean)
        }
        return []
      } catch { return [] }
    }
    const pids = new Set()
    const re = /pid=(\d+)/g
    let m
    while ((m = re.exec(out)) !== null) pids.add(parseInt(m[1], 10))
    return [...pids]
  } catch {
    return []
  }
}

async function _clearPortIfOccupied() {
  const pids = _findPidOnPort(TRAG_PORT)
  let killed = false
  for (const pid of pids) {
    if (childProcess && pid === childProcess.pid) continue
    try {
      console.warn(`[TRAG:local] 端口 ${TRAG_PORT} 被孤儿进程 ${pid} 占用，主动清理...`)
      process.kill(pid, 'SIGKILL')
      killed = true
    } catch { /* ignore */ }
  }
  if (killed) await new Promise((r) => setTimeout(r, 800))
}

async function _spawnProcess() {
  await _clearPortIfOccupied()
  const tragDir = path.resolve(__dirname, '../../trag_service')
  childProcess = spawn('python3', ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', String(TRAG_PORT), '--log-level', 'info'], {
    cwd: tragDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  childProcess.stdout?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) console.log(`[TRAG:py:out] ${line}`)
  })
  childProcess.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) console.error(`[TRAG:py:err] ${line}`)
  })
  childProcess.on('exit', (code, signal) => {
    console.warn(`[TRAG:local] Python 子进程退出 (code=${code}, signal=${signal})`)
    childProcess = null
    isHealthy = false
    startedAt = null
    if (code !== 0 && code !== null) {
      console.log('[TRAG:local] 异常退出，健康检查将在下个周期触发重启')
    }
  })
  childProcess.on('error', (err) => {
    console.error('[TRAG:local] Python 子进程启动失败:', err.message)
    childProcess = null
    isHealthy = false
  })
  startedAt = new Date()
}

async function _waitForReady(timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await _healthProbe()) {
        isHealthy = true
        return true
      }
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS))
  }
  return false
}

async function _healthProbe() {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)
    const r = await fetch(`${TRAG_SERVICE_URL}/health`, { signal: controller.signal })
    clearTimeout(timeoutId)
    return r.ok
  } catch {
    return false
  }
}

function _startHealthCheck() {
  if (healthCheckTimer) return
  healthCheckTimer = setInterval(async () => {
    await _runHealthCheckNow()
  }, HEALTH_CHECK_INTERVAL_MS)
}

async function _runHealthCheckNow() {
  lastHealthCheckTime = new Date()
  const ok = await _healthProbe()
  if (ok) {
    if (!isHealthy) {
      console.log('[TRAG:local] ✅ 服务恢复健康')
      isHealthy = true
      restartCount = 0
    }
  } else {
    if (isHealthy) console.warn('[TRAG:local] ⚠️ 健康检查失败，标记为不可用')
    isHealthy = false
    if (restartCount < MAX_RESTART_COUNT) {
      const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, restartCount)
      console.log(`[TRAG:local] 将在 ${delay}ms 后重启 (第${restartCount + 1}次)...`)
      setTimeout(async () => {
        if (!childProcess) {
          restartCount++
          isStarting = true
          await _spawnProcess()
          setTimeout(() => { isStarting = false }, 3000)
        }
      }, delay)
    } else {
      console.error(`[TRAG:local] 已达最大重启次数(${MAX_RESTART_COUNT})，不再自动重启`)
    }
  }
}

process.on('exit', () => stopLocal())
process.on('SIGTERM', () => { stopLocal(); process.exit(0) })
process.on('SIGINT', () => { stopLocal(); process.exit(0) })
