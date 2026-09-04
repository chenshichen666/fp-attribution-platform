import { query } from '../db/pool.js'
import { config } from '../db/pool.js'

// 身份识别：
// 1. 优先从 x-user-eng 头读取（兼容原有逻辑）
// 2. 若无头信息，默认使用 demo 用户（外网模式下无企业微信 / SSO 鉴权）
//    与 db/pool.js 的 config.superAdmin 及前端「一键进入」保持同一账号
const DEFAULT_DEMO_USER = 'admin' // 默认使用管理员身份

export async function identify(req, res, next) {
  try {
    let eng = (req.headers['x-user-eng'] || '').toString().trim().toLowerCase()
    const name = (req.headers['x-user-name'] ? decodeURIComponent(req.headers['x-user-name']) : '').toString()
    const team = (req.headers['x-user-team'] ? decodeURIComponent(req.headers['x-user-team']) : '').toString()

    // 外网 Demo 模式：若无用户头，使用默认 demo 用户
    if (!eng) {
      eng = DEFAULT_DEMO_USER
    }

    let rows = await query('SELECT * FROM users WHERE eng=?', [eng])
    if (!rows.length) {
      // 首次出现的用户：自动建档
      if (eng === config.superAdmin) {
        await query(
          `INSERT INTO users (eng,name,team,roles,status) VALUES (?,?,?,?,?)`,
          [eng, name || '超级管理员', team || '治理策略组', 'submitter,handler,admin', 'active']
        )
      } else {
        await query(
          `INSERT INTO users (eng,name,team,roles,status) VALUES (?,?,?,?,?)`,
          [eng, name || eng, team || '', 'submitter', 'active']
        )
      }
      rows = await query('SELECT * FROM users WHERE eng=?', [eng])
    } else if (name || team) {
      // 同步最新姓名/部门
      await query('UPDATE users SET name=COALESCE(NULLIF(?,\'\'),name), team=COALESCE(NULLIF(?,\'\'),team) WHERE eng=?', [name, team, eng])
    }

    const u = rows[0]
    req.currentUser = {
      id: u.id, eng: u.eng, name: u.name, team: u.team,
      roles: u.roles ? u.roles.split(',').filter(Boolean) : [],
      status: u.status, hasToken: !!u.knot_token,
    }
    next()
  } catch (e) { next(e) }
}

export function requireLogin(req, res, next) {
  if (!req.currentUser) return res.status(401).json({ error: '未登录或无法识别身份' })
  next()
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser) return res.status(401).json({ error: '未登录' })
    if (!roles.some((r) => req.currentUser.roles.includes(r))) {
      return res.status(403).json({ error: '无权限' })
    }
    next()
  }
}

export async function audit(req, action, target = '') {
  try {
    const user = req.currentUser?.name || req.currentUser?.eng || '未知'
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0]
    await query('INSERT INTO audit_logs (user,action,target,ip) VALUES (?,?,?,?)', [user, action, target, ip])
  } catch { /* 审计失败不阻断主流程 */ }
}
