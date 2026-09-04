import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin, requireRole, audit } from '../middleware/auth.js'

const router = Router()
function now() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }

// 提交反馈（登录用户）
router.post('/', requireLogin, async (req, res, next) => {
  try {
    const { type, content, shots } = req.body
    if (!content?.trim()) return res.status(400).json({ error: '请填写反馈内容' })
    const seq = await query('SELECT COUNT(*) AS c FROM feedback')
    const id = `FB-${1043 + Number(seq[0].c)}`
    await query(
      `INSERT INTO feedback (id,user,eng,team,type,content,shots,status,created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
      [id, req.currentUser.name, req.currentUser.eng, req.currentUser.team, type || '功能建议', content, shots || 0, now()]
    )
    await audit(req, '提交意见反馈', id)
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

// 反馈列表（管理员查看）
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM feedback ORDER BY created_at DESC')
    res.json(rows.map((f) => ({
      id: f.id, user: f.user, eng: f.eng, team: f.team, type: f.type,
      content: f.content, shots: f.shots, status: f.status, reply: f.reply, createdAt: f.created_at,
    })))
  } catch (e) { next(e) }
})

// 回复/更新反馈状态（管理员）
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { status, reply } = req.body
    await query('UPDATE feedback SET status=COALESCE(?,status), reply=COALESCE(?,reply) WHERE id=?',
      [status || null, reply ?? null, req.params.id])
    await audit(req, '处理意见反馈', req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export default router
