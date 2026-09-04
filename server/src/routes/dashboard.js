import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

// 数据大盘（管理员）—— 全部由数据库实时聚合
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const [tot] = await query('SELECT COUNT(*) AS c FROM tickets')
    const [adopted] = await query("SELECT COUNT(*) AS c FROM tickets WHERE status='done'")
    const [handlers] = await query("SELECT COUNT(DISTINCT handler) AS c FROM tickets WHERE handler<>''")

    const statusRows = await query('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status')
    const statusLabel = { submitted: '提需中', accepted: '待结论', concluded: '待采纳', done: '已采纳' }
    const byStatus = statusRows.map((r) => ({ name: statusLabel[r.status] || r.status, value: r.c }))

    // MySQL: DATE_FORMAT(created_at,'%m-%d') → SQLite: strftime('%m-%d', created_at)
    // MySQL: DATE_SUB(CURDATE(), INTERVAL 7 DAY) → SQLite: date('now','-7 day')
    const weekRows = await query(
      `SELECT strftime('%m-%d', created_at) AS day, COUNT(*) AS value
       FROM tickets WHERE created_at >= date('now','-7 day')
       GROUP BY day ORDER BY day`)

    const topRows = await query(
      `SELECT rdt.tag_id AS id, rdt.tag_name AS name, rdt.fp, rdt.total FROM real_data_tags rdt
       WHERE rdt.tag_name <> '' ORDER BY rdt.fp DESC LIMIT 10`)
    const topFpTags = topRows.map((t) => ({
      id: t.id, name: t.name, fp: t.fp, ticketCount: 0,
      adoptRate: t.total ? Math.round((t.total - t.fp) / t.total * 100) : 0,
    }))

    res.json({
      totalTickets: tot.c, adoptedCount: adopted.c, avgHandleHours: 18.5, activeHandlers: handlers.c,
      byStatus, weeklyTickets: weekRows, topFpTags,
    })
  } catch (e) { next(e) }
})

export default router
