import { Router } from 'express'
import { query, config } from '../db/pool.js'
import { requireLogin, requireRole, audit } from '../middleware/auth.js'

const router = Router()

const ROLE_MAP = { '提需人': 'submitter', '处理人': 'handler', '管理员': 'admin' }
const isSuperAdmin = (eng) => eng && eng.toLowerCase() === config.superAdmin

// 提需人/处理人互斥：不会并列出现。合并角色时若同时含 submitter 与 handler，
// 优先保留原有业务角色；原无业务角色则保留新增中的第一个。
function mergeRoles(cur, next) {
  const set = new Set([...(cur || []), ...(next || [])])
  const hasS = set.has('submitter')
  const hasH = set.has('handler')
  if (hasS && hasH) {
    const keep = (cur || []).includes('submitter') || (cur || []).includes('handler')
      ? ((cur || []).includes('submitter') ? 'submitter' : 'handler')
      : ((next || []).includes('submitter') ? 'submitter' : 'handler')
    set.delete('submitter'); set.delete('handler'); set.add(keep)
  }
  return [...set]
}

// 用户列表（管理员）
router.get('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT id,eng,name,team,roles,status FROM users ORDER BY id')
    res.json(rows.map((u) => ({ ...u, roles: u.roles ? u.roles.split(',').filter(Boolean) : [] })))
  } catch (e) { next(e) }
})

// 更新用户角色/状态（管理员）
router.put('/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { roles, status } = req.body
    await query('UPDATE users SET roles=?, status=? WHERE id=?',
      [(roles || []).join(','), status || 'active', req.params.id])
    await audit(req, '更新用户权限', `user#${req.params.id}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 提交权限申请（登录用户自己选角色）
// 提需人/处理人：自动通过，无需审批
// 管理员：进入审批队列，仅超级管理员可审批
router.post('/requests', requireLogin, async (req, res, next) => {
  try {
    const { applyRoles, reason } = req.body
    if (!applyRoles?.length) return res.status(400).json({ error: '请选择申请角色' })

    const hasAdmin = applyRoles.some((r) => (ROLE_MAP[r.trim()] || r.trim()) === 'admin')
    const status = hasAdmin ? 'pending' : 'approved'
  const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')

    await query(
      `INSERT INTO permission_requests (eng,name,team,apply_roles,reason,status,operator,operated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [req.currentUser.eng, req.currentUser.name, req.currentUser.team, applyRoles.join(','), reason || '', status,
       hasAdmin ? null : '系统自动通过', hasAdmin ? null : now]
    )
    await audit(req, '提交权限申请', `${applyRoles.join('/')} → ${status}`)

    // 非管理员角色自动通过：直接把角色写入用户表并激活（提需人/处理人互斥）
    if (!hasAdmin) {
      const engRoles = applyRoles
        .map((x) => ROLE_MAP[x.trim()] || x.trim()).filter(Boolean)
      const exist = await query('SELECT * FROM users WHERE eng=?', [req.currentUser.eng])
      if (exist.length) {
        const cur = (exist[0].roles ? exist[0].roles.split(',') : []).filter(Boolean)
        await query('UPDATE users SET roles=?, status=?, name=?, team=? WHERE eng=?',
          [mergeRoles(cur, engRoles).join(','), 'active', req.currentUser.name, req.currentUser.team, req.currentUser.eng])
      } else {
        await query('INSERT INTO users (eng,name,team,roles,status) VALUES (?,?,?,?, "active")',
          [req.currentUser.eng, req.currentUser.name, req.currentUser.team, mergeRoles([], engRoles).join(',')])
      }
    }
    res.json({ ok: true, autoApproved: !hasAdmin })
  } catch (e) { next(e) }
})

// 审批列表（管理员可见；但管理员角色申请仅超级管理员可见）
router.get('/requests', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM permission_requests ORDER BY created_at DESC')
    // 非超级管理员：过滤掉管理员角色申请（仅超管可见）
    const visible = isSuperAdmin(req.currentUser.eng)
      ? rows
      : rows.filter((r) => {
          const roles = (r.apply_roles || '').split(',').map((x) => (ROLE_MAP[x.trim()] || x.trim()))
          return !roles.includes('admin')
        })
    res.json(visible.map((r) => ({
      id: r.id, eng: r.eng, name: r.name, team: r.team,
      applyRoles: r.apply_roles ? r.apply_roles.split(',').filter(Boolean) : [],
      reason: r.reason, status: r.status, operator: r.operator,
      operatedAt: r.operated_at, createdAt: r.created_at,
    })))
  } catch (e) { next(e) }
})

// 审批（通过/拒绝）— 管理员角色申请仅超级管理员可审批
router.put('/requests/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { decision } = req.body // 'approved' | 'rejected'
    const rows = await query('SELECT * FROM permission_requests WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '申请不存在' })
    const r = rows[0]

    // 如果申请中包含管理员角色，仅超级管理员可审批
    const applyRoleKeys = (r.apply_roles ? r.apply_roles.split(',') : [])
      .map((x) => ROLE_MAP[x.trim()] || x.trim()).filter(Boolean)
    if (applyRoleKeys.includes('admin') && !isSuperAdmin(req.currentUser.eng)) {
      return res.status(403).json({ error: '管理员角色申请仅超级管理员可审批' })
    }

  const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
    await query('UPDATE permission_requests SET status=?, operator=?, operated_at=? WHERE id=?',
      [decision, req.currentUser.name, now, req.params.id])

    // 通过：把申请角色写入用户表并激活（提需人/处理人互斥）
    if (decision === 'approved') {
      const engRoles = applyRoleKeys
      const exist = await query('SELECT * FROM users WHERE eng=?', [r.eng])
      if (exist.length) {
        const cur = (exist[0].roles ? exist[0].roles.split(',') : []).filter(Boolean)
        await query('UPDATE users SET roles=?, status=?, name=?, team=? WHERE eng=?',
          [mergeRoles(cur, engRoles).join(','), 'active', r.name, r.team, r.eng])
      } else {
        await query('INSERT INTO users (eng,name,team,roles,status) VALUES (?,?,?,?, "active")',
          [r.eng, r.name, r.team, mergeRoles([], engRoles).join(',')])
      }
    }
    await audit(req, decision === 'approved' ? '通过权限申请' : '拒绝权限申请', r.eng)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export default router
