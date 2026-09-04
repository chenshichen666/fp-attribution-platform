import { Router } from 'express'
import { query, rawQuery } from '../db/pool.js'
import { requireLogin, requireRole, audit } from '../middleware/auth.js'
import wecomNotify from '../services/wecomNotify.js'
import { search as upstreamSearch, isLocalMode } from '../trag/upstream.js'
import { enrichResultsWithTags } from './trag.js'

const router = Router()

function now() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }

function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

function parseNotifyUsers(s) {
  if (!s) return []
  // 优先尝试 JSON 数组
  try {
    const v = JSON.parse(s)
    if (Array.isArray(v)) return v.filter(Boolean)
  } catch { /* not JSON */ }
  // 兜底：逗号分隔
  return String(s).split(',').map((x) => x.trim()).filter(Boolean)
}

let ticketColumnsReady = false
async function ensureTicketColumns() {
  if (ticketColumnsReady) return
  const defs = [
    ['conclusion_images', 'conclusion_images TEXT'],
    ['is_qualified', 'is_qualified INTEGER'],
    ['handle_remark', 'handle_remark TEXT'],
    ['result_type', "result_type TEXT NOT NULL DEFAULT ''"],
    ['samples_data', 'samples_data TEXT'],
    ['notify_users', "notify_users TEXT NOT NULL DEFAULT ''"],
    ['dc_id', "dc_id TEXT NOT NULL DEFAULT ''"],
    ['ops_advertiser_name', "ops_advertiser_name TEXT NOT NULL DEFAULT ''"],
    ['element_fingerprint', "element_fingerprint TEXT NOT NULL DEFAULT ''"],
    ['ai_evaluate_reviewer_name', "ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''"],
    ['cc_users', "cc_users TEXT NOT NULL DEFAULT ''"],
    ['parent_ticket_id', "parent_ticket_id TEXT NOT NULL DEFAULT ''"],
    ['clusters_data', 'clusters_data TEXT'],
  ]
  for (const [col, ddl] of defs) {
    const rows = await rawQuery('PRAGMA table_info(tickets)')
    const exists = rows.some(r => r.name === col)
    if (!exists) await query(`ALTER TABLE tickets ADD COLUMN ${ddl}`)
  }
  ticketColumnsReady = true
}

async function withTimeline(ticket) {
  const tl = await query('SELECT action, op, t FROM ticket_timeline WHERE ticket_id=? ORDER BY t, id', [ticket.id])
  // 从 samples_data 中逐条尝试从 ai_evaluate_detail 补全四个字段
  let enrichedSamples = parseJsonArray(ticket.samples_data)
  if (enrichedSamples.length) {
    try {
      // 收集所有需要补全的 fingerprint / media_url
      const fps = new Set()
      const mus = new Set()
      for (const s of enrichedSamples) {
        if (s.elementFingerprint || s.element_fingerprint) fps.add(s.elementFingerprint || s.element_fingerprint)
        if (s.mediaUrl || s.media_url) mus.add(s.mediaUrl || s.media_url)
      }
      if (fps.size || mus.size) {
        const dMap = new Map() // fingerprint -> row
        const muMap = new Map() // media_url -> fingerprint
        // 基础查询字段（22标准字段）
        const BASE_FIELDS = [
          'dc_id', 'ops_advertiser_name', 'element_fingerprint', 'ai_evaluate_reviewer_name',
          'element_value', 'agency_uid', 'agency_name', 'model_version', 'arrive_time', 'ds',
          'class_num', 'class_id', 'ocr_text', 'ocr_content', 'asr_text', 'asr_content',
          'uid', 'uid_name', 'element_type', 'element_type_name',
          'first_level_industry_name', 'second_level_industry_name'
        ].join(',')
        // 按 fingerprint 查
        if (fps.size) {
          const fpArr = [...fps]
          const ph = fpArr.map(() => '?').join(',')
          const dRows = await query(`SELECT ${BASE_FIELDS} FROM ai_evaluate_detail WHERE element_fingerprint IN (${ph})`, fpArr)
          for (const r of dRows) {
            if (r.element_fingerprint) dMap.set(r.element_fingerprint, r)
          }
        }
        // 按 media_url(即 element_value)查，关联 fingerprint
        if (mus.size) {
          const muArr = [...mus]
          const ph = muArr.map(() => '?').join(',')
          const dRows = await query(`SELECT ${BASE_FIELDS} FROM ai_evaluate_detail WHERE element_value IN (${ph})`, muArr)
          for (const r of dRows) {
            if (r.element_value) muMap.set(r.element_value, r)
          }
        }
        // 补全所有字段
        for (const s of enrichedSamples) {
          const fp = s.elementFingerprint || s.element_fingerprint || ''
          const mu = s.mediaUrl || s.media_url || ''
          let d = fp ? dMap.get(fp) : null
          if (!d && mu) d = muMap.get(mu) || null
          if (d) {
            if (!s.dcId && !s.dc_id) s.dcId = d.dc_id || ''
            if (!s.opsAdvertiserName && !s.ops_advertiser_name) s.opsAdvertiserName = d.ops_advertiser_name || ''
            if (!s.elementFingerprint && !s.element_fingerprint) s.elementFingerprint = d.element_fingerprint || ''
            if (!s.aiEvaluateReviewerName && !s.ai_evaluate_reviewer_name) s.aiEvaluateReviewerName = d.ai_evaluate_reviewer_name || ''
            // Phase 4 新增字段
            if (!s.agencyUid && !s.agency_uid) s.agencyUid = d.agency_uid || ''
            if (!s.agencyName && !s.agency_name) s.agencyName = d.agency_name || ''
            if (!s.modelVersion && !s.model_version) s.modelVersion = d.model_version || ''
            if (!s.arriveTime && !s.arrive_time) s.arriveTime = d.arrive_time || ''
            if (!s.ds) s.ds = d.ds || ''
            if (!s.classNum && !s.class_num) s.classNum = d.class_num || ''
            if (!s.classId && !s.class_id) s.classId = d.class_id || ''
            if (!s.ocr && !s.ocr_text) s.ocr = d.ocr_text || d.ocr_content || ''
            if (!s.asr && !s.asr_text) s.asr = d.asr_text || d.asr_content || ''
            if (!s.advertiserId && !s.uid) s.advertiserId = d.uid || ''
            if (!s.uidName && !s.uid_name) s.uidName = d.uid_name || ''
            if (!s.elementType && !s.element_type) s.elementType = d.element_type || ''
            if (!s.elementTypeName && !s.element_type_name) s.elementTypeName = d.element_type_name || ''
            if (!s.industryL1 && !s.first_level_industry_name) s.industryL1 = d.first_level_industry_name || ''
            if (!s.industryL2 && !s.second_level_industry_name) s.industryL2 = d.second_level_industry_name || ''
          }
        }
      }
    } catch (e) { console.error('[withTimeline] 补全 samples_data 四字段失败:', e.message) }
  }
  // 从补全后的样本数据中提取四个字段（优先取第一条样本的字段）
  let _dcId = ticket.dc_id || ''
  let _opsAdvertiserName = ticket.ops_advertiser_name || ''
  let _elementFingerprint = ticket.element_fingerprint || ''
  let _aiEvaluateReviewerName = ticket.ai_evaluate_reviewer_name || ''
  let _mediaUrl = ''
  if (!_dcId || !_opsAdvertiserName || !_elementFingerprint || !_aiEvaluateReviewerName) {
    for (const s of enrichedSamples) {
      if (!_dcId) _dcId = s.dcId || s.dc_id || ''
      if (!_opsAdvertiserName) _opsAdvertiserName = s.opsAdvertiserName || s.ops_advertiser_name || ''
      if (!_elementFingerprint) _elementFingerprint = s.elementFingerprint || s.element_fingerprint || ''
      if (!_aiEvaluateReviewerName) _aiEvaluateReviewerName = s.aiEvaluateReviewerName || s.ai_evaluate_reviewer_name || ''
      if (_dcId && _opsAdvertiserName && _elementFingerprint && _aiEvaluateReviewerName) break
    }
  }
  // 从第一条样本提取 mediaUrl（原文链接）
  if (enrichedSamples.length) {
    _mediaUrl = enrichedSamples[0].mediaUrl || enrichedSamples[0].media_url || ''
  }
  return {
    id: ticket.id, title: ticket.title, tag: ticket.tag, tagId: ticket.tag_id,
    elementType: ticket.element_type, industryL1: ticket.industry_l1, industryL2: ticket.industry_l2,
    urgency: ticket.urgency, status: ticket.status, submitter: ticket.submitter, handler: ticket.handler,
    sampleCount: ticket.sample_count, desc: ticket.descr, conclusion: ticket.conclusion,
    conclusionImages: parseJsonArray(ticket.conclusion_images),
    handleReason: ticket.handle_reason, needTag: !!ticket.need_tag,
    isQualified: ticket.is_qualified === null || ticket.is_qualified === undefined ? null : !!ticket.is_qualified,
    handleRemark: ticket.handle_remark || '', category: ticket.category,
    categoryNote: ticket.category_note, resultType: ticket.result_type || '',
    samplesData: enrichedSamples,
    notifyUsers: parseNotifyUsers(ticket.notify_users),
    ccUsers: parseNotifyUsers(ticket.cc_users),
    parentTicketId: ticket.parent_ticket_id || '',
    dcId: _dcId,
    opsAdvertiserName: _opsAdvertiserName,
    elementFingerprint: _elementFingerprint,
    aiEvaluateReviewerName: _aiEvaluateReviewerName,
    mediaUrl: _mediaUrl,
    createdAt: ticket.created_at, timeline: tl,
  }
}

// 列表
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const me = req.currentUser.name
    const roles = req.currentUser.roles || []
    const canHandle = roles.includes('handler') || roles.includes('admin')
    let rows
    if (roles.includes('admin')) {
      // 管理员：查看全部工单（含演示工单），便于全局管控
      rows = await query(
        `SELECT * FROM tickets ORDER BY created_at DESC`
      )
    } else if (canHandle) {
      // 处理人：公共池待抢单工单 + 自己提交或处理的工单
      rows = await query(
        `SELECT * FROM tickets
         WHERE is_demo=0 AND (
           (status='submitted' AND (handler='' OR handler IS NULL))
           OR submitter=? OR handler=?
         ) ORDER BY created_at DESC`,
        [me, me]
      )
    } else {
      // 纯提需人：仅自己提交的工单
      rows = await query(
        "SELECT * FROM tickets WHERE is_demo=0 AND submitter=? ORDER BY created_at DESC",
        [me]
      )
    }
    return res.json(await Promise.all(rows.map(withTimeline)))
  } catch (e) { next(e) }
})

// 通知对象联想接口——从历史工单的 notify_users/submitter/handler 提取常用联系人
// 注意：此路由必须在 /:id 之前注册，否则 "notify-suggests" 会被当作 :id 参数匹配
router.get('/notify-suggests', requireLogin, async (req, res, next) => {
  try {
    const kw = (req.query.q || '').trim().toLowerCase()
    // 从 notify_users、submitter、handler 列中提取去重用户名
    const rows = await rawQuery(
      "SELECT DISTINCT submitter AS name FROM tickets WHERE submitter!='' UNION SELECT DISTINCT handler AS name FROM tickets WHERE handler!=''"
    )
    const notifyRows = await rawQuery("SELECT notify_users FROM tickets WHERE notify_users!=''")
    const nameSet = new Set()
    for (const r of rows) {
      if (r.name) nameSet.add(r.name.trim())
    }
    for (const r of notifyRows) {
      for (const u of parseNotifyUsers(r.notify_users)) {
        if (u) nameSet.add(u.trim())
      }
    }
    let names = [...nameSet]
    if (kw) {
      names = names.filter(n => n.toLowerCase().includes(kw))
    }
    // 按名称排序，最多返回 20 条
    names.sort()
    res.json(names.slice(0, 20))
  } catch (e) { next(e) }
})

// 工单搜索接口（供「嵌套依据工单」选择器使用，支持搜索全部工单）
// 注意：此路由必须在 /:id 之前注册，否则 "search" 会被当作 :id 参数匹配
router.get('/search', requireLogin, async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim()
    let sql = 'SELECT id, title, status, tag, tag_id FROM tickets WHERE is_demo=0'
    const args = []
    if (q) {
      sql += ' AND (id LIKE ? OR title LIKE ?)'
      args.push(`%${q}%`, `%${q}%`)
    }
    sql += ' ORDER BY created_at DESC LIMIT 50'
    const rows = await query(sql, args)
    res.json(rows.map(r => ({ id: r.id, title: r.title, status: r.status, tag: r.tag, tagId: r.tag_id })))
  } catch (e) { next(e) }
})

// ===== 工单草稿：提需中断保留现场，草稿箱可恢复到离开时的步骤 =====
// 列表：当前登录人所有草稿
router.get('/drafts', requireLogin, async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT id, owner, step, summary, created_at, updated_at FROM ticket_drafts WHERE owner=? ORDER BY updated_at DESC',
      [req.currentUser.name]
    )
    res.json(rows.map(r => ({
      id: r.id, owner: r.owner, step: r.step, summary: r.summary,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })))
  } catch (e) { next(e) }
})

// 保存/更新草稿：payload 为前端序列化的工单表单（含 step、samples、clusters、字段）
router.post('/drafts', requireLogin, async (req, res, next) => {
  try {
    const b = req.body
    const id = b.id || `DR-${Date.now()}-${Math.floor(Math.random() * 1e4)}`
    const step = Number(b.step || 1)
    const summary = String(b.summary || '').slice(0, 255)
    const payload = JSON.stringify(b.payload || {})
    const existing = await query('SELECT id FROM ticket_drafts WHERE id=? AND owner=?', [id, req.currentUser.name])
    if (existing.length) {
      await query(
        "UPDATE ticket_drafts SET step=?, summary=?, payload=?, updated_at=datetime('now','localtime') WHERE id=? AND owner=?",
        [step, summary, payload, id, req.currentUser.name]
      )
    } else {
      await query(
        "INSERT INTO ticket_drafts (id, owner, step, summary, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))",
        [id, req.currentUser.name, step, summary, payload]
      )
    }
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

// 拉取草稿详情（含完整表单 payload）
router.get('/drafts/:id', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM ticket_drafts WHERE id=? AND owner=?', [req.params.id, req.currentUser.name])
    if (!rows.length) return res.status(404).json({ error: '草稿不存在或已被删除' })
    const r = rows[0]
    let payload = {}
    try { payload = JSON.parse(r.payload || '{}') } catch { payload = {} }
    res.json({ id: r.id, owner: r.owner, step: r.step, summary: r.summary, payload, updatedAt: r.updated_at })
  } catch (e) { next(e) }
})

// 删除草稿
router.delete('/drafts/:id', requireLogin, async (req, res, next) => {
  try {
    await query('DELETE FROM ticket_drafts WHERE id=? AND owner=?', [req.params.id, req.currentUser.name])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 详情
router.get('/:id', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM tickets WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    res.json(await withTimeline(rows[0]))
  } catch (e) { next(e) }
})

// 新建工单（提需人）
router.post('/', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const b = req.body
    await ensureTicketColumns()
    const seq = await query('SELECT COUNT(*) AS c FROM tickets')
    const id = b.id || `TKT-${2053 + Number(seq[0].c)}`
    const samplesJson = JSON.stringify(Array.isArray(b.samplesData) ? b.samplesData : [])
    const clustersJson = JSON.stringify(Array.isArray(b.clusters) ? b.clusters : [])
    const notifyUsers = Array.isArray(b.notifyUsers) ? b.notifyUsers.filter(Boolean) : []
    const ccUsers = Array.isArray(b.ccUsers) ? b.ccUsers.filter(Boolean) : []
    const ccUsersStr = JSON.stringify(ccUsers)
    const handler = String(b.handler || '').trim()
    const parentTicketId = String(b.parentTicketId || '').trim()
    // 指派了处理人 → 不落公共池，直接进入处理中（accepted）；否则 submitted 进公共池抢单
    const initialStatus = handler ? 'accepted' : 'submitted'
    const notifyUsersStr = JSON.stringify(notifyUsers)
    // 从 samplesData 中提取四个字段（取第一条样本的字段），同时支持从请求体直接传入
    const firstSample = Array.isArray(b.samplesData) && b.samplesData.length > 0 ? b.samplesData[0] : {}
    const _dcId = b.dcId || firstSample.dcId || firstSample.dc_id || ''
    const _opsAdvertiserName = b.opsAdvertiserName || b.ops_advertiser_name || firstSample.opsAdvertiserName || firstSample.ops_advertiser_name || ''
    const _elementFingerprint = b.elementFingerprint || firstSample.elementFingerprint || firstSample.element_fingerprint || ''
    const _aiEvaluateReviewerName = b.reviewerName || b.aiEvaluateReviewerName || firstSample.aiEvaluateReviewerName || firstSample.ai_evaluate_reviewer_name || ''
    // 使用前端传入的本地时间，若未传则用服务器时间
    const ticketCreatedAt = b.createdAt || now()
    await query(
      `INSERT INTO tickets (id,title,tag,tag_id,element_type,industry_l1,industry_l2,urgency,status,submitter,handler,sample_count,descr,is_demo,created_at,samples_data,clusters_data,notify_users,cc_users,parent_ticket_id,dc_id,ops_advertiser_name,element_fingerprint,ai_evaluate_reviewer_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.title, b.tag || '', b.tagId || 0, b.elementType || '', b.industryL1 || '', b.industryL2 || '',
       b.urgency || 2, initialStatus, req.currentUser.name, handler, b.sampleCount || 0, b.desc || '', 0, ticketCreatedAt, samplesJson, clustersJson, notifyUsersStr,
       ccUsersStr, parentTicketId,
       _dcId, _opsAdvertiserName, _elementFingerprint, _aiEvaluateReviewerName]
    )
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, "提交工单", ?, ?)',
      [id, req.currentUser.name, ticketCreatedAt])
    if (handler) {
      await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, ?, ?, ?)',
        [id, `指派处理人 ${handler}`, req.currentUser.name, ticketCreatedAt])
    }
    if (parentTicketId) {
      await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, ?, ?, ?)',
        [id, `嵌套依据工单 ${parentTicketId}`, req.currentUser.name, ticketCreatedAt])
    }
    await audit(req, '提交工单', id)
    const rows = await query('SELECT * FROM tickets WHERE id=?', [id])
    const ticket = rows[0]
    // 企微通知：@通知对象（通知对象 + 抄送 + 指派处理人）
    const notifyAll = [...new Set([...notifyUsers, ...ccUsers, ...(handler ? [handler] : [])])]
    wecomNotify.notifyTicketCreated({
      id: ticket.id, title: ticket.title, tagId: ticket.tag_id, tag: ticket.tag,
      elementType: ticket.element_type, industryL1: ticket.industry_l1, industryL2: ticket.industry_l2,
      urgency: ticket.urgency, submitter: req.currentUser.eng, sampleCount: ticket.sample_count,
    }, notifyAll).catch((e) => console.error('[wecomNotify] 创建工单通知失败:', e.message))
    res.json(await withTimeline(ticket))
  } catch (e) { next(e) }
})

// 处理人受理
router.post('/:id/accept', requireRole('handler', 'admin'), async (req, res, next) => {
  try {
    await query('UPDATE tickets SET status="accepted", handler=? WHERE id=? AND status="submitted" AND is_demo=0',
      [req.currentUser.name, req.params.id])
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, "处理人受理", ?, ?)',
      [req.params.id, req.currentUser.name, now()])
    await audit(req, '处理人受理', req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 提交结论（处理人）
router.post('/:id/conclude', requireRole('handler', 'admin'), async (req, res, next) => {
  try {
    const { conclusion, handleReason, needTag, conclusionImages, isQualified, handleRemark, category, categoryChangeNote } = req.body
    await ensureTicketColumns()
    // 处理人可修改问题分类：变更时更新并写时间线留痕，提需人可见
    if (category !== undefined && category !== null) {
      const cur = await query('SELECT category FROM tickets WHERE id=? AND is_demo=0', [req.params.id])
      const oldCat = cur.length ? (cur[0].category || '') : ''
      if (String(category) !== String(oldCat)) {
        await query('UPDATE tickets SET category=? WHERE id=? AND is_demo=0',
          [category || '', req.params.id])
        await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, ?, ?, ?)',
          [req.params.id, categoryChangeNote || '处理人修改问题分类', req.currentUser.name, now()])
      }
    }
    await query(
      `UPDATE tickets
       SET status="concluded", conclusion=?, conclusion_images=?, handle_reason=?, need_tag=?, is_qualified=?, handle_remark=?, handler=?
       WHERE id=? AND is_demo=0`,
      [
        conclusion || '',
        JSON.stringify(Array.isArray(conclusionImages) ? conclusionImages : []),
        handleReason || '',
        needTag ? 1 : 0,
        isQualified === null || isQualified === undefined ? null : (isQualified ? 1 : 0),
        handleRemark || '',
        req.currentUser.name,
        req.params.id,
      ]
    )
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, "提交结论", ?, ?)',
      [req.params.id, req.currentUser.name, now()])
    await audit(req, '提交结论', req.params.id)
    // 企微通知：@通知对象（处理人选择的人，兜底用工单提需时指定的人）
    const ticketRows = await query('SELECT * FROM tickets WHERE id=?', [req.params.id])
    if (ticketRows.length) {
      const t = ticketRows[0]
      const notifyUsers = (req.body && Array.isArray(req.body.notifyUsers) && req.body.notifyUsers.length)
        ? req.body.notifyUsers.filter(Boolean)
        : parseNotifyUsers(t.notify_users)
      wecomNotify.notifyTicketConcluded({
        id: t.id, title: t.title, handler: t.handler, conclusion: t.conclusion,
        handleReason: t.handle_reason, isQualified: t.is_qualified,
      }, notifyUsers).catch((e) => console.error('[wecomNotify] 提交结论通知失败:', e.message))
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 采纳并确定问题分类（提需人）——采纳时自动写入/更新结论沉淀库
router.post('/:id/adopt', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const { category, categoryNote, resultType } = req.body
    const resolvedResultType = resultType || ''
    const rows = await query('SELECT * FROM tickets WHERE id=? AND is_demo=0', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    const t = rows[0]

    await query('UPDATE tickets SET status="done", category=?, category_note=?, result_type=? WHERE id=? AND is_demo=0',
      [category || '', categoryNote || '', resolvedResultType, req.params.id])
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, "采纳并确定问题分类", ?, ?)',
      [req.params.id, req.currentUser.name, now()])
    await audit(req, '采纳并确定问题分类', req.params.id)

    // 企微通知：@通知对象（工单提需时指定的人）
    wecomNotify.notifyTicketAdopted({
      id: t.id, title: t.title, category: category || '', resultType: resolvedResultType,
      handler: t.handler, submitter: t.submitter,
    }, parseNotifyUsers(t.notify_users)).catch((e) => console.error('[wecomNotify] 采纳通知失败:', e.message))

    // 同步结论沉淀库：若该工单已有沉淀记录则更新，否则新建
    const existSed = await query('SELECT id FROM sediments WHERE ticket_id=?', [req.params.id])
    const tagRows = await query('SELECT tag_name AS name FROM real_data_tags WHERE tag_id=?', [t.tag_id])
    const tagName = tagRows.length ? tagRows[0].name : (t.tag || '')
    const sedData = {
      ticket_id: req.params.id,
      title: t.title,
      type: t.element_type || '',
      category: category || '',
      result_type: resolvedResultType,
      tag_id: t.tag_id,
      tag_name: tagName,
      tags: tagName,
      industry: t.industry_l1 || '',
      industry_l1: t.industry_l1 || '',
      industry_l2: t.industry_l2 || '',
      submitter: t.submitter,
      handler: t.handler,
      adopted_at: now(),
      samples: t.sample_count,
      descr: t.descr || '',
      feature: '',
      conclusion: t.conclusion || '',
      fp_reason: t.handle_reason || '',
      related_materials: t.samples_data || '[]',
      handle_info: `处理人：${t.handler} · 处理原因：${t.handle_reason || ''} · 结果类型：${resolvedResultType === 'real_fp' ? '真实误杀' : resolvedResultType === 'machine_right' ? '机审正确' : '未选择'}`,
      dc_id: t.dc_id || '',
      ops_advertiser_name: t.ops_advertiser_name || '',
      element_fingerprint: t.element_fingerprint || '',
      ai_evaluate_reviewer_name: t.ai_evaluate_reviewer_name || '',
    }
    if (existSed.length) {
      // 更新已有沉淀记录
      await query(
        `UPDATE sediments SET title=?,type=?,category=?,result_type=?,tag_id=?,tag_name=?,tags=?,industry=?,industry_l1=?,industry_l2=?,submitter=?,handler=?,adopted_at=?,samples=?,descr=?,conclusion=?,fp_reason=?,related_materials=?,handle_info=?,dc_id=?,ops_advertiser_name=?,element_fingerprint=?,ai_evaluate_reviewer_name=? WHERE id=?`,
        [sedData.title, sedData.type, sedData.category, sedData.result_type, sedData.tag_id, sedData.tag_name,
         sedData.tags, sedData.industry, sedData.industry_l1, sedData.industry_l2, sedData.submitter, sedData.handler, sedData.adopted_at, sedData.samples,
         sedData.descr, sedData.conclusion, sedData.fp_reason, sedData.related_materials, sedData.handle_info,
         sedData.dc_id, sedData.ops_advertiser_name, sedData.element_fingerprint, sedData.ai_evaluate_reviewer_name,
         existSed[0].id]
      )
      // 追加更新记录
      await query('INSERT INTO sediment_updates (sediment_id,by_user,reason,at) VALUES (?,?,?,?)',
        [existSed[0].id, req.currentUser.name, '工单重新修改结论后采纳入库', now()])
    } else {
      // 新建沉淀记录
      await query(
        `INSERT INTO sediments (ticket_id,title,type,category,result_type,tag_id,tag_name,tags,industry,industry_l1,industry_l2,submitter,handler,adopted_at,samples,descr,feature,conclusion,fp_reason,related_materials,handle_info,dc_id,ops_advertiser_name,element_fingerprint,ai_evaluate_reviewer_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sedData.ticket_id, sedData.title, sedData.type, sedData.category, sedData.result_type, sedData.tag_id,
         sedData.tag_name, sedData.tags, sedData.industry, sedData.industry_l1, sedData.industry_l2, sedData.submitter, sedData.handler, sedData.adopted_at,
         sedData.samples, sedData.descr, sedData.feature, sedData.conclusion, sedData.fp_reason,
         sedData.related_materials, sedData.handle_info, sedData.dc_id, sedData.ops_advertiser_name,
         sedData.element_fingerprint, sedData.ai_evaluate_reviewer_name]
      )
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 退回（提需人/管理员）——退回到原处理人继续改，不清 handler
router.post('/:id/reject', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason || !reason.trim()) return res.status(400).json({ error: '退回原因必填' })
    // 仅 concluded 状态可退回
    const rows = await query('SELECT status, title, handler, submitter FROM tickets WHERE id=? AND is_demo=0', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    if (rows[0].status !== 'concluded') return res.status(400).json({ error: '仅待采纳工单可退回' })

    // 状态回到 rejected，保留 handler（原处理人继续改）
    await query('UPDATE tickets SET status="rejected" WHERE id=? AND is_demo=0', [req.params.id])
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, ?, ?, ?)',
      [req.params.id, `退回：${reason.trim()}`, req.currentUser.name, now()])
    await audit(req, '退回工单', req.params.id)
    // 企微通知：@处理人（工单已被退回）
    wecomNotify.notifyTicketRejected({
      id: req.params.id, title: rows[0].title, handler: rows[0].handler, submitter: rows[0].submitter,
    }, req.currentUser.name, reason.trim()).catch((e) => console.error('[wecomNotify] 退回通知失败:', e.message))
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 重开工单（提需人/管理员）——done 状态可重开回到 concluded，重新修改结论后入库
router.post('/:id/reopen', requireRole('submitter', 'admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT status, title, handler, submitter FROM tickets WHERE id=? AND is_demo=0', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    if (rows[0].status !== 'done') return res.status(400).json({ error: '仅已采纳工单可重开' })

    await query('UPDATE tickets SET status="concluded" WHERE id=? AND is_demo=0', [req.params.id])
    await query('INSERT INTO ticket_timeline (ticket_id,action,op,t) VALUES (?, "重开工单", ?, ?)',
      [req.params.id, req.currentUser.name, now()])
    await audit(req, '重开工单', req.params.id)
    // 企微通知：@处理人（工单已重开）
    wecomNotify.notifyTicketReopened({
      id: req.params.id, title: rows[0].title, handler: rows[0].handler, submitter: rows[0].submitter,
    }, req.currentUser.name).catch((e) => console.error('[wecomNotify] 重开通知失败:', e.message))
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 下载工单数据（Excel）——包含工单所有字段 + 每条素材的是否需要打标 + 到达时间
router.get('/:id/export', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM tickets WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    const ticket = rows[0]
    const samples = parseJsonArray(ticket.samples_data)

    // 动态导入 exceljs
    const ExcelJS = (await import('exceljs')).default || (await import('exceljs'))
    const workbook = new ExcelJS.Workbook()
    const ws = workbook.addWorksheet('工单数据')

    // 工单级字段
    const ticketFields = [
      ['工单编号', ticket.id], ['标题', ticket.title], ['标签ID', ticket.tag_id], ['标签名', ticket.tag],
      ['元素类型', ticket.element_type], ['一级行业', ticket.industry_l1], ['二级行业', ticket.industry_l2],
      ['紧急程度', ticket.urgency === 3 ? '高' : ticket.urgency === 1 ? '低' : '中'],
      ['状态', ticket.status], ['提需人', ticket.submitter], ['处理人', ticket.handler],
      ['样本数', ticket.sample_count], ['问题描述', ticket.descr],
      ['专家结论', ticket.conclusion], ['是否需要打标', ticket.need_tag ? '是' : '否'],
      ['问题分类', ticket.category], ['结果类型', ticket.result_type],
      ['审核人', ticket.ai_evaluate_reviewer_name || ''], ['创意ID(DCID)', ticket.dc_id || ''],
      ['客户主体名称', ticket.ops_advertiser_name || ''], ['审核物理指纹(md5)', ticket.element_fingerprint || ''],
      ['创建时间', ticket.created_at], ['处理原因', ticket.handle_reason], ['备注', ticket.handle_remark || ''],
    ]
    ws.columns = [
      { header: '字段', key: 'field' },
      { header: '值', key: 'value' },
    ]
    for (const [f, v] of ticketFields) {
      ws.addRow({ field: f, value: v ?? '' })
    }

    // 素材明细 sheet（与素材特征分类模块导出列一致）
    if (samples.length) {
      const ws2 = workbook.addWorksheet('素材明细')
      const sampleCols = [
        { header: '到达时间', key: 'arriveTime' },
        { header: '创意ID(DCID)', key: 'dcId' },
        { header: '元素类型', key: 'elementType' },
        { header: '一级行业', key: 'firstLevelIndustry' },
        { header: '二级行业', key: 'secondLevelIndustry' },
        { header: '审核标签ID', key: 'policyIds' },
        { header: 'AI评测人审标签', key: 'aiEvaluatePolicyIds' },
        { header: 'ocr_text', key: 'ocrContent' },
        { header: 'asr_text', key: 'asrContent' },
        { header: '审核元素值', key: 'mediaUrl' },
        { header: '审核物理指纹(md5)', key: 'elementFingerprint' },
        { header: '广告主ID(UID)', key: 'uid' },
        { header: '审核人', key: 'aiEvaluateReviewerName' },
        { header: '是否打标', key: 'needTag' },
        { header: '备注', key: 'remark' },
      ]
      ws2.columns = sampleCols
      for (const s of samples) {
        ws2.addRow({
          arriveTime: s.arriveTime || s.arrive_time || '',
          dcId: s.dcId || s.dc_id || '',
          elementType: ticket.element_type || '',
          firstLevelIndustry: ticket.industry_l1 || '',
          secondLevelIndustry: ticket.industry_l2 || '',
          policyIds: s.policyIds || s.machineTag || s.machine_tag || '',
          aiEvaluatePolicyIds: s.aiEvaluatePolicyIds || s.humanTag || s.human_tag || '',
          ocrContent: s.ocr || s.ocrContent || s.ocr_content || '',
          asrContent: s.asr || s.asrContent || s.asr_content || '',
          mediaUrl: s.mediaUrl || s.media_url || '',
          elementFingerprint: s.elementFingerprint || s.element_fingerprint || '',
          uid: s.uid || s.advertiserId || s.advertiser_id || '',
          aiEvaluateReviewerName: s.aiEvaluateReviewerName || s.ai_evaluate_reviewer_name || s.reviewerName || '',
          needTag: s.needTag !== undefined ? s.needTag : (s.need_tag !== undefined ? s.need_tag : ''),
          remark: s.remark || s.remark || '',
        })
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${ticket.id}.xlsx"`)
    await workbook.xlsx.write(res)
    res.end()
  } catch (e) { next(e) }
})

// 删除工单（管理员专属）——联动删除工单时间线
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query('SELECT id, title FROM tickets WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    await query('DELETE FROM ticket_timeline WHERE ticket_id=?', [req.params.id])
    await query('DELETE FROM ticket_similar_library WHERE ticket_id=?', [req.params.id])
    await query('DELETE FROM tickets WHERE id=?', [req.params.id])
    await audit(req, '删除工单', `${req.params.id} - ${rows[0].title}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ===== 工单相似样本库（基于工单样本逐条 TRAG 检索，独立持久化留痕） =====
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']

function isVideoByUrl(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  if (VIDEO_EXT.includes(ext)) return true
  if (IMAGE_EXT.includes(ext)) return false
  if (/video/i.test(clean)) return true
  return false
}

// 自动探测任务类型（与前端 TragSearchModal.autoDetectTask 口径一致）
function autoDetectTask(r) {
  if (!r) return 'text_text'
  const mediaUrl = r.mediaUrl || r.media_url || ''
  if (r.type === '文本' || (!isVideoByUrl(mediaUrl) && !mediaUrl)) return 'text_text'
  if (isVideoByUrl(mediaUrl)) {
    if (r.ocr) return 'video_ocr'
    if (r.asr) return 'video_asr'
    if (r.elementFingerprint) return 'video_video'
    return 'video_frame'
  }
  if (r.ocr) return 'image_ocr'
  if (mediaUrl) return 'image_image_shangshu'
  return 'text_text'
}

// 自动填充检索 query（与前端 TragSearchModal.autoFillQuery 口径一致）
function autoFillQuery(task, r) {
  if (!r) return ''
  const mediaUrl = r.mediaUrl || r.media_url || ''
  const ocr = r.ocr || r.ocrContent || ''
  const asr = r.asr || r.asrContent || ''
  const fp = r.elementFingerprint || r.element_fingerprint || ''
  switch (task) {
    case 'text_text': return mediaUrl || ocr || asr || ''
    case 'image_image_shangshu':
    case 'video_frame': return mediaUrl || ''
    case 'image_ocr':
    case 'video_ocr': return ocr || ''
    case 'video_asr':
    case 'video_patch_asr': return asr || ocr || ''
    case 'video_video': return fp || ''
    default: return ''
  }
}

function libMediaUrl(it) {
  return it.element_value || it.media_url || it.cos_url || it.video_url || ''
}

function libOcr(it) { return it.ocr_content || it.ocr_text || '' }
function libAsr(it) { return it.asr_content || it.asr_text || '' }

function toLibItem(r) {
  const tryArr = (s) => {
    if (!s) return []
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : [s] } catch { return [s] }
  }
  return {
    id: r.id,
    ticketId: r.ticket_id,
    seedFingerprint: r.seed_fingerprint || '',
    seedMediaUrl: r.seed_media_url || '',
    taskType: r.task_type || '',
    elementFingerprint: r.element_fingerprint || '',
    elementValue: r.element_value || '',
    elementType: r.element_type || '',
    score: Number(r.score) || 0,
    ocrContent: r.ocr_content || '',
    asrContent: r.asr_content || '',
    dcId: r.dc_id || '',
    opsAdvertiserName: r.ops_advertiser_name || '',
    policyIds: tryArr(r.policy_ids),
    aiEvaluatePolicyIds: tryArr(r.ai_evaluate_policy_ids),
    selected: !!r.selected,
    createdAt: r.created_at,
  }
}

// 触发相似检索：逐条样本检索 → 合并去重 → 清空旧库重写 → 返回样本库
router.post('/:id/similar-search', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM tickets WHERE id=? AND is_demo=0', [req.params.id])
    if (!rows.length) return res.status(404).json({ error: '工单不存在' })
    const ticket = rows[0]
    const samples = parseJsonArray(ticket.samples_data)
    if (!samples.length) return res.status(400).json({ error: '该工单暂无关联样本，无法检索相似素材' })

    const threshold = Number(req.body.threshold) || 0
    const limit = Math.max(1, Math.min(Number(req.body.limit) || 10, 50))
    const taskType = String(req.body.taskType || 'auto').trim() || 'auto'

    // 逐条样本并行检索（每条样本自动探测任务类型 + 自动填充 query）
    const jobs = samples.map((s) => {
      const task = taskType === 'auto' ? autoDetectTask(s) : taskType
      const q = autoFillQuery(task, s)
      if (!q) return null
      return upstreamSearch({ task, query: q, limit, threshold })
        .then((data) => ({
          seed: s,
          task,
          results: Array.isArray(data.results) ? data.results : [],
        }))
    }).filter(Boolean)

    const all = await Promise.all(jobs)

    // 合并去重：优先按 element_fingerprint 去重，无指纹则按 URL 去重，保留最高分
    const dedup = new Map()
    for (const { seed, task, results } of all) {
      for (const item of results) {
        const fp = item.element_fingerprint || item.elementFingerprint || ''
        const url = libMediaUrl(item)
        const key = fp || (url ? `url:${url}` : '')
        if (!key) continue
        const score = Number(item.score) || 0
        const seedFp = seed.elementFingerprint || seed.element_fingerprint || ''
        const seedUrl = seed.mediaUrl || seed.media_url || ''
        const prev = dedup.get(key)
        if (!prev || score > prev._score) {
          dedup.set(key, { ...item, _score: score, _seedFp: seedFp, _seedUrl: seedUrl, _task: task })
        }
      }
    }
    const merged = [...dedup.values()]

    // 标签增强（机审/人审标签）
    await enrichResultsWithTags(req, merged)

    // 清空旧库，重写新结果
    await query('DELETE FROM ticket_similar_library WHERE ticket_id=?', [req.params.id])
    for (const it of merged) {
      const machineTag = typeof it.machineTag === 'string' ? it.machineTag : JSON.stringify(it.machineTag || it.policy_list || '')
      const humanTag = typeof it.humanTag === 'string' ? it.humanTag : JSON.stringify(it.humanTag || '')
      await query(
        `INSERT INTO ticket_similar_library
          (ticket_id, seed_fingerprint, seed_media_url, task_type, element_fingerprint, element_value, element_type, score, ocr_content, asr_content, dc_id, ops_advertiser_name, policy_ids, ai_evaluate_policy_ids)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, it._seedFp, it._seedUrl, it._task,
         it.element_fingerprint || it.elementFingerprint || '', libMediaUrl(it),
         it.element_type || it.data_type || '', it._score,
         libOcr(it), libAsr(it),
         it.dc_id || it.dcId || '', it.ops_advertiser_name || '',
         machineTag, humanTag]
      )
    }

    await audit(req, '相似样本检索', `${req.params.id} → ${merged.length} 条相似样本`)

    const lib = await query('SELECT * FROM ticket_similar_library WHERE ticket_id=? ORDER BY score DESC', [req.params.id])
    res.json({ total: lib.length, items: lib.map(toLibItem), taskType })
  } catch (e) { next(e) }
})

// 查询工单相似样本库（可反复查看、留痕）
router.get('/:id/similar-library', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM ticket_similar_library WHERE ticket_id=? ORDER BY score DESC', [req.params.id])
    res.json({ total: rows.length, items: rows.map(toLibItem) })
  } catch (e) { next(e) }
})

// 清空工单相似样本库
router.delete('/:id/similar-library', requireLogin, async (req, res, next) => {
  try {
    await query('DELETE FROM ticket_similar_library WHERE ticket_id=?', [req.params.id])
    await audit(req, '清空相似样本库', req.params.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 勾选/取消勾选相似样本（供发起提需，跨会话留痕）
router.post('/:id/similar-library/select', requireLogin, async (req, res, next) => {
  try {
    const { ids, selected } = req.body
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids 必填' })
    const ph = ids.map(() => '?').join(',')
    await query(`UPDATE ticket_similar_library SET selected=? WHERE ticket_id=? AND id IN (${ph})`,
      [selected ? 1 : 0, req.params.id, ...ids])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export default router