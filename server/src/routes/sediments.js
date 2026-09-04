import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin, requireRole, audit } from '../middleware/auth.js'

const router = Router()
function now() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }

async function withUpdates(s) {
  const ups = await query('SELECT by_user AS "by", reason, at FROM sediment_updates WHERE sediment_id=? ORDER BY at', [s.id])
  let materials = []
  try { materials = s.related_materials ? JSON.parse(s.related_materials) : [] } catch { materials = [] }
  return {
    id: s.id, title: s.title, type: s.type, category: s.category, resultType: s.result_type,
    tagId: s.tag_id, tagName: s.tag_name, tags: s.tags ? s.tags.split(',').filter(Boolean) : [],
    industry: s.industry, industryL1: s.industry_l1 || '', industryL2: s.industry_l2 || '',
    submitter: s.submitter, handler: s.handler, adoptedAt: s.adopted_at,
    samples: s.samples, desc: s.descr, feature: s.feature, conclusion: s.conclusion,
    fpReason: s.fp_reason, relatedMaterials: materials, handleInfo: s.handle_info, updates: ups,
    dcId: s.dc_id || '', opsAdvertiserName: s.ops_advertiser_name || '',
    elementFingerprint: s.element_fingerprint || '', aiEvaluateReviewerName: s.ai_evaluate_reviewer_name || '',
  }
}

// 列表
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM sediments WHERE is_demo=0 ORDER BY adopted_at DESC')
    res.json(await Promise.all(rows.map(withUpdates)))
  } catch (e) { next(e) }
})

// 标签下拉选项（从已有记录去重）—— 必须在 /:id 之前注册，避免被 /:id 覆盖
router.get('/tags', requireLogin, async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT tag_id, tag_name FROM sediments WHERE is_demo=0 AND tag_id>0 AND tag_name<>'' GROUP BY tag_id, tag_name ORDER BY tag_name"
    )
    res.json(rows.map(r => ({ tagId: r.tag_id, tagName: r.tag_name })))
  } catch (e) { next(e) }
})

// 搜索（MySQL LIKE 多字段模糊匹配 + 标签精确匹配）—— 必须在 /:id 之前注册，避免被 /:id 覆盖
router.get('/search', requireLogin, async (req, res, next) => {
  try {
    const { q, tagId, tagName, industry, resultType } = req.query
    let sql = 'SELECT * FROM sediments WHERE is_demo=0'
    const args = []
    if (q && q.trim()) {
      const kw = `%${q.trim()}%`
      sql += ' AND (title LIKE ? OR descr LIKE ? OR conclusion LIKE ? OR fp_reason LIKE ? OR handle_info LIKE ? OR feature LIKE ?)'
      args.push(kw, kw, kw, kw, kw, kw)
    }
    if (tagId) { sql += ' AND tag_id=?'; args.push(Number(tagId)) }
    if (tagName && tagName.trim()) { sql += ' AND tag_name LIKE ?'; args.push(`%${tagName.trim()}%`) }
    // 行业检索：优先按真实行业 industry_l1 匹配，回退兼容未填充 industry_l1 的历史数据（industry 字段）
    if (industry && industry.trim()) {
      sql += ' AND (industry_l1 LIKE ? OR (industry_l1 = ? AND industry LIKE ?))'
      args.push(`%${industry.trim()}%`, '', `%${industry.trim()}%`)
    }
    if (resultType) { sql += ' AND result_type=?'; args.push(resultType) }
    sql += ' ORDER BY adopted_at DESC LIMIT 50'
    const rows = await query(sql, args)
    res.json(await Promise.all(rows.map(withUpdates)))
  } catch (e) { next(e) }
})

// 详情
router.get('/:id', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM sediments WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '结论不存在' })
    res.json(await withUpdates(rows[0]))
  } catch (e) { next(e) }
})

// 更新结论（追加更新记录）
router.post('/:id/update', requireLogin, async (req, res, next) => {
  try {
    const { reason, conclusion, resultType } = req.body
    if (conclusion !== undefined) await query('UPDATE sediments SET conclusion=? WHERE id=?', [conclusion, req.params.id])
    if (resultType) await query('UPDATE sediments SET result_type=? WHERE id=?', [resultType, req.params.id])
    await query('INSERT INTO sediment_updates (sediment_id,by_user,reason,at) VALUES (?,?,?,?)',
      [req.params.id, req.currentUser.name, reason || '', now()])
    await audit(req, '更新结论', `sed#${req.params.id}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 新增结论沉淀记录（管理员/提需人）
router.post('/', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {}
    const title = (b.title || '').trim()
    if (!title) return res.status(400).json({ error: '标题不能为空' })
    const relatedMaterials = Array.isArray(b.relatedMaterials) ? b.relatedMaterials : []
    const tags = Array.isArray(b.tags) ? b.tags.join(',') : (b.tags || '')
    const nowStr = now()
    const result = await query(
      `INSERT INTO sediments (ticket_id,title,type,category,result_type,tag_id,tag_name,tags,industry,industry_l1,industry_l2,submitter,handler,adopted_at,samples,descr,feature,conclusion,fp_reason,related_materials,handle_info,dc_id,ops_advertiser_name,element_fingerprint,ai_evaluate_reviewer_name,is_demo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [b.ticketId || '', title, b.type || '', b.category || 'OTHER', b.resultType || 'real_fp',
       b.tagId || 0, b.tagName || '', tags, b.industry || '', b.industryL1 || '', b.industryL2 || '',
       b.submitter || req.currentUser.name,
       b.handler || '', b.adoptedAt || nowStr, b.samples || 0, b.desc || '', b.feature || '',
       b.conclusion || '', b.fpReason || '', JSON.stringify(relatedMaterials), b.handleInfo || '',
       b.dcId || '', b.opsAdvertiserName || '', b.elementFingerprint || '', b.aiEvaluateReviewerName || '']
    )
    await audit(req, '新增结论', `sed#${result.insertId} - ${title}`)
    const rows = await query('SELECT * FROM sediments WHERE id=?', [result.insertId])
    res.json(await withUpdates(rows[0]))
  } catch (e) { next(e) }
})

// 全量编辑结论沉淀记录（追加更新记录到时间线）
router.put('/:id', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {}
    const rows = await query('SELECT * FROM sediments WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '结论不存在' })
    const old = rows[0]
    const relatedMaterials = Array.isArray(b.relatedMaterials) ? b.relatedMaterials : old.related_materials
    const tags = Array.isArray(b.tags) ? b.tags.join(',') : (b.tags || old.tags)
    await query(
      `UPDATE sediments SET title=?,type=?,category=?,result_type=?,tag_id=?,tag_name=?,tags=?,industry=?,industry_l1=?,industry_l2=?,submitter=?,handler=?,samples=?,descr=?,feature=?,conclusion=?,fp_reason=?,related_materials=?,handle_info=?,dc_id=?,ops_advertiser_name=?,element_fingerprint=?,ai_evaluate_reviewer_name=? WHERE id=?`,
      [b.title || old.title, b.type || old.type, b.category || old.category, b.resultType || old.result_type,
       b.tagId ?? old.tag_id, b.tagName || old.tag_name, tags, b.industry || old.industry,
       b.industryL1 ?? old.industry_l1, b.industryL2 ?? old.industry_l2,
       b.submitter || old.submitter, b.handler || old.handler, b.samples ?? old.samples,
       b.desc ?? old.descr, b.feature ?? old.feature, b.conclusion ?? old.conclusion,
       b.fpReason ?? old.fp_reason, JSON.stringify(relatedMaterials), b.handleInfo ?? old.handle_info,
       b.dcId ?? old.dc_id, b.opsAdvertiserName ?? old.ops_advertiser_name,
       b.elementFingerprint ?? old.element_fingerprint, b.aiEvaluateReviewerName ?? old.ai_evaluate_reviewer_name,
       req.params.id]
    )
    // 追加更新记录
    await query('INSERT INTO sediment_updates (sediment_id,by_user,reason,at) VALUES (?,?,?,?)',
      [req.params.id, req.currentUser.name, b.updateReason || '编辑更新结论', now()])
    await audit(req, '编辑结论', `sed#${req.params.id}`)
    const updated = await query('SELECT * FROM sediments WHERE id=?', [req.params.id])
    res.json(await withUpdates(updated[0]))
  } catch (e) { next(e) }
})

// 转工单（从沉淀记录直接创建一条正式工单，进入公共池）
router.post('/:id/to-ticket', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM sediments WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '结论不存在' })
    const s = rows[0]
    let materials = []
    try { materials = s.related_materials ? JSON.parse(s.related_materials) : [] } catch { materials = [] }
    // 构建 samplesData（工单样本格式）
    const samplesData = materials.map((m, i) => ({
      id: m.id || `sed-${s.id}-${i}`,
      mediaUrl: m.mediaUrl || '',
      type: m.type || (m.mediaUrl && /video/i.test(m.mediaUrl) ? 'video' : 'image'),
      ocr: m.ocr || '', asr: m.asr || '',
      dcId: s.dc_id || '', opsAdvertiserName: s.ops_advertiser_name || '',
      elementFingerprint: s.element_fingerprint || '', aiEvaluateReviewerName: s.ai_evaluate_reviewer_name || '',
    }))
    const ticketId = `TKT-${Date.now().toString().slice(-6)}`
    await query(
      `INSERT INTO tickets (id, title, tag, tag_id, element_type, industry_l1, industry_l2, urgency, status, submitter, handler, sample_count, descr, samples_data, is_demo, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'submitted', ?, '', ?, ?, ?, 0, datetime('now','localtime'))`,
      [ticketId, s.title || `沉淀转工单-${s.id}`, s.tag_name || '', s.tag_id || 0, '',
       s.industry_l1 || s.industry || '', s.industry_l2 || '', 2, req.currentUser.name,
       s.descr || '', s.descr || '', JSON.stringify(samplesData), samplesData.length]
    )
    await query("INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, ?, ?, datetime('now','localtime'))",
      [ticketId, '提交工单（沉淀转单）', req.currentUser.name])
    await audit(req, '沉淀转工单', `sed#${s.id} -> ${ticketId}`)
    res.json({ ok: true, ticketId, message: '已创建工单并进入公共池' })
  } catch (e) { next(e) }
})

// 删除结论（管理员专属）——联动删除更新记录
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT id, title FROM sediments WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '结论不存在' })
    await query('DELETE FROM sediment_updates WHERE sediment_id=?', [req.params.id])
    await query('DELETE FROM sediments WHERE id=?', [req.params.id])
    await audit(req, '删除结论', `sed#${req.params.id} - ${rows[0].title}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// KPI
router.get('/stat/kpi', requireLogin, async (req, res, next) => {
  try {
    const [tot] = await query('SELECT COUNT(*) AS c FROM sediments WHERE is_demo=0')
    const [rf] = await query("SELECT COUNT(*) AS c FROM sediments WHERE is_demo=0 AND result_type='real_fp'")
    const [mr] = await query("SELECT COUNT(*) AS c FROM sediments WHERE is_demo=0 AND result_type='machine_right'")
    const [up] = await query('SELECT COUNT(DISTINCT sediment_id) AS c FROM sediment_updates')
    res.json({ total: tot.c, realFp: rf.c, machineRight: mr.c, updated: up.c })
  } catch (e) { next(e) }
})

// 分布：按行业 / 按问题分类（真实聚合自 sediments 表）
router.get('/stat/distribution', requireLogin, async (req, res, next) => {
  try {
    // 仅以真实行业 industry_l1 聚合；行业缺失的记录不计入行业分布，
    // 避免被污染的 industry 字段（误写入的素材类型/文本内容）污染行业分布图
    const industry = await query(
      "SELECT industry_l1 AS name, COUNT(*) AS value FROM sediments WHERE is_demo=0 AND industry_l1<>'' GROUP BY name ORDER BY value DESC"
    )
    const category = await query(
      "SELECT category AS code, COUNT(*) AS value FROM sediments WHERE is_demo=0 AND category<>'' GROUP BY category ORDER BY value DESC"
    )
    res.json({
      industry: industry.map(r => ({ name: r.name, value: Number(r.value) })),
      category: category.map(r => ({ code: r.code, value: Number(r.value) })),
    })
  } catch (e) { next(e) }
})

export default router