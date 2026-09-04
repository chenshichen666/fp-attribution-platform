import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin, audit } from '../middleware/auth.js'

// 使用 Node 20 内置原生 fetch（全局），不再依赖 node-fetch
const fetch = globalThis.fetch

const router = Router()

// 企业微信 tauth 鉴权网关地址（开发/预览环境通常不可达，前端会自动降级到体验模式）
const TAUTH_TARGET = process.env.TAUTH_TARGET || 'https://auth.example.com'

// 当前登录用户信息（前端拿 tauth 身份后调用，返回平台角色/状态）
router.get('/me', (req, res) => {
  if (!req.currentUser) return res.json({ user: null })
  res.json({ user: req.currentUser })
})

// 我的历史权限申请（含审批进度与结果），仅返回当前登录用户记录
router.get('/my-requests', requireLogin, async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT * FROM permission_requests WHERE eng=? ORDER BY created_at DESC',
      [req.currentUser.eng]
    )
    res.json(rows.map((r) => ({
      id: r.id, eng: r.eng, name: r.name, team: r.team,
      applyRoles: r.apply_roles ? r.apply_roles.split(',').filter(Boolean) : [],
      reason: r.reason, status: r.status, operator: r.operator,
      operatedAt: r.operated_at, createdAt: r.created_at,
    })))
  } catch (e) { next(e) }
})

// 保存当前用户的 Knot token（首次填一次）
router.post('/me/token', requireLogin, async (req, res, next) => {
  try {
    const { token } = req.body
    if (!token || !token.trim()) return res.status(400).json({ error: 'token 不能为空' })
    await query('UPDATE users SET knot_token=? WHERE eng=?', [token.trim(), req.currentUser.eng])
    await audit(req, '更新 Knot Token')
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/tauth-info', async (req, res) => {
  try {
    const target = `${TAUTH_TARGET.replace(/\/$/, '')}/ts:auth/tauth/info.ashx`
    // 转发 cookie，tauth 依赖企业微信登录态 cookie 识别用户
    const cookieHeader = req.headers.cookie || ''
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    let r
    try {
      r = await fetch(target, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Cookie': cookieHeader,
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        },
        redirect: 'manual',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
    // tauth 不可达或返回非 200：统一返回 200 + 空 JSON，让前端静默降级到体验模式
    if (!r.ok) return res.json({ error: 'tauth_unavailable' })
    const ct = (r.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('json')) return res.json({ error: 'tauth_unavailable' })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    // 超时或网络错误：同样返回 200 + 空 JSON，前端 fetchTauth 会返回 null 触发降级
    res.json({ error: 'tauth_unavailable' })
  }
})

export default router