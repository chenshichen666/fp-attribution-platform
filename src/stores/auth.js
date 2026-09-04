import { defineStore } from 'pinia'
import { authApi } from '../api'
import { clearPersistedForUser } from '../utils/usePersistedRef'

// 外网 Demo 模式说明：
// 原实现依赖企业微信 tauth（/ts:auth/tauth/info.ashx）识别身份，
// 该网关仅内网可达，外网环境下既无必要也无法使用。
// 已移除 tauth 调用，改为「一键进入 / 自定义昵称」两种免鉴权登录方式，
// 身份经 /api/auth/me 由后端建档并返回角色（后端无身份头时默认 admin）。
const DEMO_HINT = 'demo'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: JSON.parse(localStorage.getItem('fp_user') || 'null'),
  }),
  getters: {
    isLogin: (s) => !!s.user,
    roles: (s) => s.user?.roles || [],
    isAdmin: (s) => s.user?.roles?.includes('admin'),
    isSubmitter: (s) => s.user?.roles?.includes('submitter'),
    isHandler: (s) => s.user?.roles?.includes('handler'),
    hasRole: (s) => !!(s.user && s.user.roles && s.user.roles.length),
    avatar: (s) => s.user
      ? `https://auth.example.com/photo/150/${s.user.eng}.png?default_when_absent=true` : '',
  },
  actions: {
    // 写入身份头到 localStorage（供 api 层读取），再向后端同步角色
    async hydrateFromBackend(identity) {
      localStorage.setItem('fp_user', JSON.stringify({ ...identity, roles: [] }))
      const { user } = await authApi.me()
      if (!user) {
        throw new Error('无法获取用户信息，请确认昵称是否正确')
      }
      this.user = {
        eng: user.eng, name: user.name, team: user.team,
        roles: user.roles || [], status: user.status,
        initial: (user.name || user.eng || '').slice(-1),
        color: '#6366f1',
        roleTag: rolesToTag(user.roles || []),
      }
      localStorage.setItem('fp_user', JSON.stringify(this.user))
      return this.user
    },
    // 身份登录：拿昵称 → 后端建档/取角色
    // （原 ssoLogin 依赖企业微信 tauth，仅内网可达，外网 Demo 模式已移除）
    async realLogin({ eng, name, team }) {
      const e = (eng || '').trim().toLowerCase()
      if (!e) throw new Error('请填写昵称')
      return this.hydrateFromBackend({ eng: e, name: name || e, team: team || '' }, false)
    },
    // 体验账号兜底登录：当后端 /api 经预览网关不可达（被网关拦截 404 / 网络错误）时，
    // 使用与管理员一致的本地身份（admin）写入 localStorage，保证平台可进入。
    // 仅在真实 SSO / 后端 identify 都失败时触发；正式环境下 /api 可达时不会走到这里。
    localLogin() {
      const eng = 'admin'
      const u = {
        eng,
        name: eng,
        team: '研发中心',
        roles: ['submitter', 'handler', 'admin'],
        status: 'active',
        collabRole: '运营',
        initial: eng.slice(-1),
        color: '#6366f1',
        roleTag: rolesToTag(['submitter', 'handler', 'admin']),
      }
      localStorage.setItem('fp_user', JSON.stringify(u))
      this.user = u
      return u
    },
    // 手动登录（进入平台前输入名字 + 选择协作角色 + 选择状态提需人/处理人）
    // 管理员（admin）自动识别，无需选择提需人/处理人状态
    manualLogin({ eng, name, collabRole, status }) {
      const e = (eng || '').trim().toLowerCase()
      if (!e) throw new Error('请填写昵称')
      const isAdmin = e === 'admin'
      const roles = isAdmin ? ['submitter', 'handler', 'admin'] : (status === 'handler' ? ['handler'] : ['submitter'])
      const u = {
        eng: e,
        name: name || e,
        team: isAdmin ? '研发中心' : '',
        roles,
        status: isAdmin ? 'active' : 'active',
        collabRole: collabRole || '运营',
        initial: (name || e || '').slice(-1),
        color: '#6366f1',
        roleTag: rolesToTag(roles),
      }
      localStorage.setItem('fp_user', JSON.stringify(u))
      this.user = u
      return u
    },
    // 刷新当前用户（角色变更后）
    async refresh() {
      if (!this.user?.eng) return
      const { user } = await authApi.me()
      if (user) {
        this.user = { ...this.user, roles: user.roles || [], status: user.status, roleTag: rolesToTag(user.roles || []) }
        localStorage.setItem('fp_user', JSON.stringify(this.user))
      }
    },
    logout() {
      const oldUser = this.user
      const analysisKeys = [
'analysis:globalDate', 'analysis:kw', 'analysis:filterTab', 'analysis:sortDesc',
  'analysis:mainTab',
        'analysis:page', 'analysis:pageSize', 'analysis:chartKw', 'analysis:chartSortDesc',
        'analysis:uploadedReal',
      ]
      if (oldUser) {
        clearPersistedForUser(oldUser, analysisKeys)
      }
      localStorage.removeItem('fp_uploaded')
      this.user = null
      localStorage.removeItem('fp_user')
      // 标记本次会话已主动登出：登录页不再自动登录，避免切换账号被自动登回
      sessionStorage.setItem('fp_no_auto_login', '1')
    }
  },
})

function rolesToTag(roles) {
  const map = { submitter: { t: '提需人', c: 'blue' }, handler: { t: '处理人', c: 'orange' }, admin: { t: '管理员', c: 'green' } }
  if (!Array.isArray(roles)) roles = []
  // 管理员只显示"管理员"标签（但保留所有权力）
  if (roles.includes('admin')) return [map.admin]
  // 提需人和处理人不会并列出现：非管理员同时拥有两者时，仅保留首个业务角色
  if (roles.includes('submitter') && roles.includes('handler')) {
    const first = roles.find((r) => r === 'submitter' || r === 'handler')
    return [map[first]]
  }
  const tags = roles.map((r) => map[r]).filter(Boolean)
  return tags.length ? tags : [{ t: '无角色', c: 'gray' }]
}