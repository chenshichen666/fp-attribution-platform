import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'

const router = Router()

// 用户 UI 状态（跨设备延续）：把前端各模块的筛选/时间窗口/打开的弹窗 id 等
// 操作状态存到服务端，同一账号换设备/重装后仍可恢复。

// 批量读取当前用户的全部 UI 状态 -> { [key]: value }
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const eng = req.currentUser.eng
    const rows = await query('SELECT "key", value FROM ui_state WHERE eng=?', [eng])
    const map = {}
    for (const r of rows) {
      try { map[r.key] = JSON.parse(r.value) } catch { map[r.key] = r.value }
    }
    res.json({ ok: true, state: map })
  } catch (e) { next(e) }
})

// 批量写入（upsert）：body = { state: { [key]: value } }
router.put('/', requireLogin, async (req, res, next) => {
  try {
    const eng = req.currentUser.eng
    const state = req.body?.state
    if (!state || typeof state !== 'object') return res.status(400).json({ error: '缺少 state 对象' })
    const entries = Object.entries(state).filter(([k]) => typeof k === 'string' && k.length <= 128)
    if (!entries.length) return res.json({ ok: true, updated: 0 })
    // 单条 upsert（避免 REPLACE 整表清空），每条独立执行保证幂等
    for (const [k, v] of entries) {
      const val = JSON.stringify(v)
      await query(
        `INSERT INTO ui_state (eng, "key", value, updated_at) VALUES (?, ?, ?, datetime('now','localtime'))
         ON CONFLICT(eng, "key") DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`,
        [eng, k, val]
      )
    }
    res.json({ ok: true, updated: entries.length })
  } catch (e) { next(e) }
})

// 删除单个 key
router.delete('/:key', requireLogin, async (req, res, next) => {
  try {
    const eng = req.currentUser.eng
    const k = String(req.params.key || '')
    await query('DELETE FROM ui_state WHERE eng=? AND "key"=?', [eng, k])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export default router
