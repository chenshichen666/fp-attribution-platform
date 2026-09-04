// 轻量级 UI 状态持久化工具
// 用法：const sortDesc = usePersistedRef('fp:analysis:sortDesc', true)
// 与普通 ref 完全一致，值变化会自动写入 localStorage，刷新/跳转返回后自动恢复。
// 适用于排序方式、筛选 tab、搜索词、分页、时间窗口等纯 UI 偏好的跨页面记忆。
import { ref, watch, isRef } from 'vue'
import { useSessionStore } from '../stores/session'

const PREFIX = 'fp:ui:'

function scopeOf(user) {
  if (!user?.eng) return 'guest'
  return `real:${user.eng}`
}

function currentUser() {
  try { return JSON.parse(localStorage.getItem('fp_user') || 'null') } catch { return null }
}

function storageKey(key, user = currentUser()) {
  return `${PREFIX}${scopeOf(user)}:${key}`
}

function readRaw(key, fallback) {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw === null) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeRaw(key, value) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value))
  } catch {
    /* 存储不可用时静默降级为普通内存状态 */
  }
}

/**
 * 创建一个会自动持久化到 localStorage 的响应式 ref
 * @param {string} key      存储键（自动加全局前缀，避免冲突）
 * @param {*}      defaultValue 默认值（首次或解析失败时使用）
 * @returns {import('vue').Ref}
 */
export function usePersistedRef(key, defaultValue) {
  const init = readRaw(key, defaultValue)
  const state = ref(init)
  watch(
    state,
    (val) => writeRaw(key, isRef(val) ? val.value : val),
    { deep: true }
  )
  return state
}

// 手动清除某个持久化状态
export function clearPersisted(key) {
  try { localStorage.removeItem(storageKey(key)) } catch { /* ignore */ }
}

export function clearPersistedForUser(user, keys = null) {
  try {
    const prefix = `${PREFIX}${scopeOf(user)}:`
    if (Array.isArray(keys) && keys.length) {
      for (const key of keys) localStorage.removeItem(prefix + key)
      return
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) localStorage.removeItem(k)
    }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 跨设备延续版：localStorage（本机） + 服务端镜像（换设备/重装也恢复）
// 初始化顺序：服务端值 > 本机 localStorage > 默认值
// 任何变化都以节流方式写回服务端（同一账号的多标签页共享同一服务端基线，
// 写入前先与最近一次服务端快照做增量合并，避免互相覆盖）。
// ─────────────────────────────────────────────────────────────────────────────
const _serverBaseline = {}   // key -> 最近一次服务端已知值（用于增量合并）
const _flushTimers = {}      // key -> 定时器
const _pending = {}          // key -> 待写入值
let _baselineReady = false

// 登录完成后调用：用服务端全量状态初始化基线
export function primeRemoteBaseline(remoteMap = {}) {
  for (const [k, v] of Object.entries(remoteMap || {})) {
    _serverBaseline[k] = v
  }
  _baselineReady = true
}

// 把待写入的若干 key 节流合并后提交服务端
function scheduleFlush() {
  if (_flushTimers.__global) return
  _flushTimers.__global = setTimeout(async () => {
    _flushTimers.__global = null
    const session = useSessionStore()
    const entries = { ..._pending }
    Object.keys(_pending).forEach((k) => delete _pending[k])
    if (!Object.keys(entries).length) return
    await session.saveRemote(entries)
  }, 800)
}

/**
 * 跨设备延续版持久化 ref：localStorage + 服务端镜像。
 * 初始化：服务端 > 本机 > 默认；变化：本机即时写 + 服务端节流写。
 * @param {string} key 存储键（模块级，如 'tickets:tab'；自动加全局前缀）
 * @param {*} defaultValue 默认值
 */
export function useRemotePersistedRef(key, defaultValue) {
  const session = useSessionStore()
  // 初始化值优先级：服务端 > 本机 > 默认
  let init = defaultValue
  const localVal = readRaw(key, undefined)
  if (localVal !== undefined) init = localVal
  if (session.loaded || _baselineReady) {
    const remoteVal = session.getRemote(key, undefined)
    if (remoteVal !== undefined) {
      init = remoteVal
      _serverBaseline[key] = remoteVal
    }
  }
  const state = ref(init)
  // 本机持久
  watch(state, (val) => {
    writeRaw(key, isRef(val) ? val.value : val)
    // 服务端镜像（节流）
    _pending[key] = val
    scheduleFlush()
  }, { deep: true })
  return state
}

// 手动同步一次基线（用于登录后、基线就绪前已创建的 ref 补偿）
export function syncRemoteBaselineFromSession() {
  const session = useSessionStore()
  primeRemoteBaseline(session.remote)
}
