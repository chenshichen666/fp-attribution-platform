import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'

const router = Router()

// 通用分享快照存储：复制分享链接，让对方打开即还原「当前页面的样子」，
// 且可在其基础上继续分析（另存为我的副本）。支持两种粒度：
//   1) 模块级（module）：如 analysis/classify/tickets/sediment，存当前 UI 状态（筛选/时间窗口/打开的弹窗），
//      对方打开后还原到同一模块同一操作位置。
//   2) 素材特征分类专属（classify 兼容旧结构）：存完整自包含快照（素材+分类+标注+视图），脱离 tagId 也能打开。
// 所有分享仅要求对方有平台登录态（无需原数据协作权限）。

// 保存分享快照 -> 返回 shareId
router.post('/', requireLogin, async (req, res, next) => {
  try {
    const me = req.currentUser.name || req.currentUser.eng
    const {
      module, route, uiState, snapshot, title,
      tagId, tagName, dataSource, date, cats, samples, view,
    } = req.body || {}

    // 兼容旧的 classify 分享：payload 直接包含 samples（自包含素材）
    const hasClassifyPayload = Array.isArray(samples) && samples.length
    const hasModulePayload = !!module && !!route
    if (!hasClassifyPayload && !hasModulePayload) {
      return res.status(400).json({ error: '分享内容为空，请先加载数据或进入目标页面后再分享' })
    }

    const shareId = randomBytes(8).toString('hex') // 16 字符，避免自增被遍历
    // 统一 payload 结构：module/route/uiState/snapshot 为主，classify 旧字段并入 snapshot
    const payload = JSON.stringify({
      module: module || 'classify',
      route: route || (module === 'classify' ? '/classify' : '/'),
      uiState: uiState || {},
      snapshot: snapshot || {
        tagId: tagId ?? null,
        tagName: tagName || '',
        dataSource: dataSource || 'platform',
        date: date || {},
        cats: Array.isArray(cats) ? cats : [],
        samples: Array.isArray(samples) ? samples : [],
        view: view || {},
      },
      title: title || '',
    })

    let expireDays = Number(req.body?.expireDays ?? 30)
    if (![0, 7, 30, 90].includes(expireDays)) expireDays = 30

    await query(
      `INSERT INTO classify_shares (share_id, owner, tag_id, tag_name, payload, expire_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [shareId, me, tagId ?? null, tagName || '', payload, expireDays]
    )
    res.json({ ok: true, shareId, expireDays })
  } catch (e) { next(e) }
})

// 拉取分享快照（按 shareId）
router.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ error: '缺少分享ID' })
    const rows = await query('SELECT * FROM classify_shares WHERE share_id=?', [id])
    if (!rows.length) return res.status(404).json({ error: '分享链接不存在或已失效' })
    const row = rows[0]
    // 过期判断：expire_days=0 表示永不过期
    if (row.expire_days && row.expire_days > 0) {
      const created = new Date(row.created_at).getTime()
      const expireAt = created + row.expire_days * 24 * 3600 * 1000
      if (Date.now() > expireAt) {
        return res.status(410).json({ error: '分享链接已过期' })
      }
    }
    let payload
    try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } catch { payload = {} }
    // 兼容极旧结构（payload 直接是 classify 自包含字段）
    const isLegacy = !payload.module && (Array.isArray(payload.samples) || payload.cats)
    const module = payload.module || (isLegacy ? 'classify' : 'classify')
    const route = payload.route || (module === 'classify' ? '/classify' : '/')
    const uiState = payload.uiState || {}
    const snapshot = payload.snapshot || (isLegacy ? payload : {})
    res.json({
      ok: true,
      shareId: row.share_id,
      owner: row.owner,
      createdAt: row.created_at,
      expireDays: row.expire_days,
      tagId: row.tag_id,
      tagName: row.tag_name,
      module,
      route,
      uiState,
      snapshot,
      title: payload.title || '',
    })
  } catch (e) { next(e) }
})

export default router
