import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

// 审计日志（管理员）
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT id,user,action,target,ip,t FROM audit_logs ORDER BY t DESC LIMIT 500')
    res.json(rows)
  } catch (e) { next(e) }
})

export default router
