import { defineStore } from 'pinia'
import { uiStateApi } from '../api'
import { useAuthStore } from './auth'

// 会话态：维护「当前登录用户最后一次停留的视图」与「待恢复 UI 状态」。
// 视图持续性（同一账号换设备/重装仍回到上次模块与操作）由此 store 协调：
//   - 进入某模块时记录 lastView（含 route + 当前 UI 状态快照）
//   - 登录完成后拉取服务端镜像的 UI 状态，作为各模块 useRemotePersistedRef 的初始值
//   - 各模块的状态变化经 useRemotePersistedRef 节流回写到服务端
let _restoreApplied = false
let _stateCache = null

export const useSessionStore = defineStore('session', {
  state: () => ({
    // 登录后从服务端拉取的全量 UI 状态（模块级 key → 值），供各模块初始化使用
    remote: {},
    // 当前停留视图：{ name, path, query }，用于登录后恢复
    lastView: null,
    // 是否已从服务端加载过状态（避免重复请求）
    loaded: false,
    // 是否已完成登录后恢复（只恢复一次）
    restored: false,
  }),
  actions: {
    // 记录当前视图（用于登录后恢复 / 跨设备延续）
    recordView(view) {
      this.lastView = view
    },
    // 从服务端拉取当前用户的全量 UI 状态，缓存到 store；幂等
    async loadRemote() {
      const auth = useAuthStore()
      if (!auth.isLogin) return
      try {
        const res = await uiStateApi.getAll()
        this.remote = res?.state || {}
        this.loaded = true
      } catch {
        this.remote = {}
        this.loaded = true
      }
    },
    // 读取某 key 的服务端初始值（模块初始化时调用）
    getRemote(key, fallback) {
      if (this.remote && Object.prototype.hasOwnProperty.call(this.remote, key)) {
        return this.remote[key]
      }
      return fallback
    },
    // 把一个 key 的当前值写回服务端（节流由调用方控制）
    async saveRemote(entries) {
      const auth = useAuthStore()
      if (!auth.isLogin) return
      try {
        await uiStateApi.putAll(entries)
      } catch { /* 网络失败静默：本地仍持久，下次再同步 */ }
    },
    // 标记「登录后恢复」已完成（只做一次）
    markRestored() { this.restored = true },
    resetRestored() { this.restored = false },
    // 重置（登出时）
    clear() {
      this.remote = {}
      this.lastView = null
      this.loaded = false
      this.restored = false
      _restoreApplied = false
      _stateCache = null
    },
  },
})

export function hasRestored() { return _restoreApplied }
export function setRestored(v) { _restoreApplied = v }
