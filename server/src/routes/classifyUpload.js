import { Router } from 'express'
import { query, pool } from '../db/pool.js'
import { requireLogin, audit } from '../middleware/auth.js'
import ExcelJS from 'exceljs'

const router = Router()

// 元素类型枚举值 → 中文名映射
const ELEMENT_TYPE_MAP = {
  'ELEMENT_TYPE_IMAGE': '图片',
  'ELEMENT_TYPE_VIDEO': '视频',
  'ELEMENT_TYPE_TEXT': '文本',
  'ELEMENT_TYPE_URL': '落地页',
  '1': '文本',
  '2': '图片',
  '3': '图片',
  '4': '视频',
  '5': '落地页',
  '6': '音频',
  '7': '图文',
}
function mapElementType(raw) {
  return ELEMENT_TYPE_MAP[raw] || raw || ''
}

/* ============ 上传数据（Excel/CSV 解析后由前端 POST JSON） ============
 * 前端用 SheetJS 解析文件，将每行转为 JSON 对象后发送
 * 同一标签多次上传：覆盖策略（先删旧再插新）
 * 上传数据中的"分类"和"补充说明"列 → 写入 material_category_relation 表
 */
router.post('/upload', requireLogin, async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { tagId, tagName, fileName, samples, categories, supplements } = req.body || {}

    if (!tagId) {
      conn.release()
      return res.status(400).json({ error: '缺少标签ID' })
    }
    if (!Array.isArray(samples) || !samples.length) {
      conn.release()
      return res.status(400).json({ error: '缺少样本数据' })
    }

    const by = req.currentUser?.name || req.currentUser?.eng || '未知用户'

    // ===== 提高会话超时：上传事务可能持续较久 =====
    await conn.execute('SET SESSION wait_timeout=600')
    await conn.execute('SET SESSION interactive_timeout=600')

    await conn.beginTransaction()

    // 覆盖策略：先删除该标签的旧上传数据
    await conn.execute('DELETE FROM uploaded_classify_data WHERE tag_id=?', [tagId])

    // ===== 逐批写入，每批BATCH条，失败批次收集后返回 =====
    const BATCH = 500
    const batchId = Date.now()
    const failedBatches = [] // 收集失败的批次索引，供前端重试

    for (let i = 0; i < samples.length; i += BATCH) {
      const batch = samples.slice(i, i + BATCH)
      try {
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
        const values = batch.flatMap(s => {
          const elementType = s.elementType || s.type || ''
          const elementTypeName = s.elementTypeName || mapElementType(elementType) || ''
          const isVideo = s.isVideo ? 1 : (elementType === 'ELEMENT_TYPE_VIDEO' || elementTypeName === '视频') ? 1 : 0
          const machineTag = String(s.machineTag || s.auditTagId || '').replace(/[\[\]]/g, '')
          const humanTag = String(s.humanTag || s.aiReviewTagId || '').replace(/[\[\]]/g, '')
          return [
            tagId, tagName || '', s.sampleId || s.id || '',
            elementType, elementTypeName, isVideo,
            machineTag, humanTag,
            s.industryL1 || s.firstLevelIndustryName || '',
            s.industryL2 || s.secondLevelIndustryName || '',
            s.mediaUrl || s.elementValue || '',
            s.ocrContent || s.ocrText || '',
            s.asrContent || s.asrText || '',
            s.classNum || 0,
            s.classId || '',
            s.uid || '',
            s.arriveTime || '',
            s.ds || '',
            s.elementFingerprint || s.fingerprint || '',
            s.isFp !== undefined ? (s.isFp ? 1 : 0) : 1,
            batchId, by,
            s.dcId || '', s.opsAdvertiserName || '', s.reviewerName || '',
          ]
        })
        await conn.execute(
          `INSERT INTO uploaded_classify_data
           (tag_id, tag_name, sample_id, element_type, element_type_name, is_video, policy_ids, ai_evaluate_policy_ids,
            first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, class_id, uid,
            arrive_time, ds, element_fingerprint, is_fp, batch_id, uploaded_by,
            dc_id, ops_advertiser_name, ai_evaluate_reviewer_name)
           VALUES ${placeholders}`,
          values
        )
      } catch (batchErr) {
        // 记录失败批次信息，继续处理后续批次
        failedBatches.push({
          batchIndex: i,
          start: i,
          end: Math.min(i + BATCH, samples.length),
          count: batch.length,
          error: batchErr.message?.substring(0, 200) || String(batchErr),
        })
        console.error(`[upload] 批次 [${i}-${Math.min(i + BATCH, samples.length)}] 写入失败:`, batchErr.message)
      }
    }

    // ===== 如果全部批次都失败，回滚整个事务 =====
    if (failedBatches.length > 0 && failedBatches.length >= Math.ceil(samples.length / BATCH)) {
      await conn.rollback()
      conn.release()
      return res.status(500).json({
        error: '所有批次写入失败，事务已回滚',
        failedCount: samples.length,
        firstError: failedBatches[0]?.error,
      })
    }

    // 处理"分类"和"补充说明"列 → 写入 material_category_relation
    const catMap = {}
    if (Array.isArray(categories)) {
      for (const c of categories) {
        if (c.sampleId && c.categoryName) catMap[c.sampleId] = { categoryName: c.categoryName, supplement: '' }
      }
    } else if (categories && typeof categories === 'object') {
      for (const [sid, cname] of Object.entries(categories)) {
        if (sid && cname) catMap[sid] = { categoryName: String(cname), supplement: '' }
      }
    }
    if (Array.isArray(supplements)) {
      for (const s of supplements) {
        if (s.sampleId) {
          if (!catMap[s.sampleId]) catMap[s.sampleId] = { categoryName: '', supplement: s.supplement || '' }
          else catMap[s.sampleId].supplement = s.supplement || ''
        }
      }
    } else if (supplements && typeof supplements === 'object') {
      for (const [sid, stext] of Object.entries(supplements)) {
        if (sid) {
          if (!catMap[sid]) catMap[sid] = { categoryName: '', supplement: String(stext) }
          else catMap[sid].supplement = String(stext)
        }
      }
    }

    const catNameToId = {}
    for (const { categoryName } of Object.values(catMap)) {
      if (categoryName && !catNameToId[categoryName]) {
        const existing = await conn.execute(
          'SELECT id FROM material_category WHERE tag_id=? AND name=? LIMIT 1',
          [tagId, categoryName]
        )
        if (existing[0].length) {
          catNameToId[categoryName] = existing[0][0].id
        } else {
          const ins = await conn.execute(
            'INSERT INTO material_category (tag_id, name, feature, source, owner) VALUES (?,?,?,?,?)',
            [tagId, categoryName, '', 'upload', by]
          )
          catNameToId[categoryName] = ins[0].insertId
        }
      }
    }

    for (const [sampleId, info] of Object.entries(catMap)) {
      const categoryId = info.categoryName ? (catNameToId[info.categoryName] || 0) : 0
      await conn.execute(
        `INSERT INTO material_category_relation (tag_id, sample_id, category_id, feature_desc, supplement, owner)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tag_id, sample_id) DO UPDATE SET category_id=excluded.category_id, supplement=excluded.supplement, owner=excluded.owner`,
        [tagId, sampleId, categoryId, '', info.supplement || '', by]
      )
    }

    await conn.commit()
    conn.release()

    // 统计（用新的只读连接查询）
    const classCountRows = await query(
      'SELECT COUNT(DISTINCT class_num) AS cnt FROM uploaded_classify_data WHERE tag_id=?',
      [tagId]
    )
    const classCount = (classCountRows.length ? classCountRows[0].cnt : 0) || 0

    // 写入上传历史
    await query(
      `INSERT INTO uploaded_classify_history (tag_id, tag_name, file_name, sample_count, class_count, uploaded_by)
       VALUES (?,?,?,?,?,?)`,
      [tagId, tagName || '', fileName || '', samples.length - failedBatches.reduce((s, b) => s + b.count, 0), classCount, by]
    )

    // 查询完整数据返回给前端
    const uploadedRows = await query(
      `SELECT s.sample_id AS id, s.element_type AS elementType, s.element_type_name AS elementTypeName,
       s.is_video AS isVideo, s.policy_ids AS machineTag, s.ai_evaluate_policy_ids AS humanTag,
       s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
       s.media_url AS mediaUrl, s.ocr_content AS ocrContent, s.asr_content AS asrContent,
       s.class_num AS classNum, COALESCE(NULLIF(s.class_id, ''), d.class_id) AS classId, s.uid, s.arrive_time AS arriveTime, s.ds,
       s.is_fp AS isFp, COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint) AS elementFingerprint,
       COALESCE(NULLIF(d.policy_ids, ''), s.policy_ids) AS policyIds,
       COALESCE(NULLIF(d.ai_evaluate_policy_ids, ''), s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
       COALESCE(d.dc_id, '') AS dcId,
       COALESCE(d.ops_advertiser_name, '') AS opsAdvertiserName,
       COALESCE(NULLIF(s.reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
       rel.category_id AS categoryId, rel.feature_desc AS featureDesc, rel.supplement AS supplement,
       cat.name AS categoryName
       FROM uploaded_classify_data s
       LEFT JOIN (
         SELECT element_value,
           MAX(NULLIF(element_fingerprint, '')) AS element_fingerprint,
           MAX(CASE WHEN policy_ids <> '[]' AND policy_ids <> '' THEN policy_ids END) AS policy_ids,
           MAX(CASE WHEN ai_evaluate_policy_ids <> '[]' AND ai_evaluate_policy_ids <> '' THEN ai_evaluate_policy_ids END) AS ai_evaluate_policy_ids,
           MAX(dc_id) AS dc_id, MAX(class_id) AS class_id,
           MAX(NULLIF(ops_advertiser_name, '')) AS ops_advertiser_name,
           MAX(NULLIF(ai_evaluate_reviewer_name, '')) AS ai_evaluate_reviewer_name,
           MAX(NULLIF(uid, '')) AS uid
         FROM ai_evaluate_detail GROUP BY element_value
       ) d ON d.element_value = s.media_url OR (CASE WHEN instr(d.element_value,'?')>0 THEN substr(d.element_value,1,instr(d.element_value,'?')-1) ELSE d.element_value END) = (CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END)
       LEFT JOIN material_category_relation rel ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
       LEFT JOIN material_category cat ON cat.id = rel.category_id
       WHERE s.tag_id=? ORDER BY s.class_num, s.id`,
      [tagId]
    )

    const dedupedMap = new Map()
    for (const row of uploadedRows) {
      const key = row.id
      if (key && dedupedMap.has(key)) {
        const prev = dedupedMap.get(key)
        if (row.categoryId && !prev.categoryId) {
          prev.categoryId = row.categoryId
          prev.featureDesc = row.featureDesc
          prev.supplement = row.supplement
          prev.categoryName = row.categoryName
        }
        continue
      }
      row.isVideo = !!row.isVideo
      if (row.machineTag) row.machineTag = String(row.machineTag).replace(/[\[\]]/g, '')
      if (row.humanTag) row.humanTag = String(row.humanTag).replace(/[\[\]]/g, '')
      dedupedMap.set(key, row)
    }
    const dedupedRows = [...dedupedMap.values()]

    await audit(req, '上传分类数据', `tag#${tagId}:${fileName || ''} (${samples.length - failedBatches.reduce((s, b) => s + b.count, 0)}条)`)

    const resultPayload = {
      ok: true,
      sampleCount: samples.length - failedBatches.reduce((s, b) => s + b.count, 0),
      totalSubmitted: samples.length,
      classCount,
      samples: dedupedRows,
    }

    // 如果部分批次失败，附加失败信息
    if (failedBatches.length > 0) {
      resultPayload.ok = false
      resultPayload.partialFailure = true
      resultPayload.failedBatches = failedBatches
      resultPayload.message = `${failedBatches.length} 个批次写入失败（${failedBatches.reduce((s, b) => s + b.count, 0)} 条），已成功 ${resultPayload.sampleCount} 条。可重试失败批次`
      resultPayload.retryTagId = tagId
      resultPayload.retryTagName = tagName
      resultPayload.retryFileName = fileName
    }

    res.json(resultPayload)
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    conn.release()
    next(e)
  }
})

/* ============ 查询上传数据（按标签） ============
 * 返回该标签下所有上传的样本数据，JOIN material_category_relation 获取分类信息
 * 用于前端加载上传数据替代平台数据
 */
router.get('/:tagId/samples', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const rows = await query(
      `SELECT s.sample_id AS id, s.element_type AS elementType, s.element_type_name AS elementTypeName,
       s.is_video AS isVideo, s.policy_ids AS machineTag, s.ai_evaluate_policy_ids AS humanTag,
       s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
       s.media_url AS mediaUrl, s.ocr_content AS ocrContent, s.asr_content AS asrContent,
       s.class_num AS classNum, COALESCE(NULLIF(s.class_id, ''), d.class_id) AS classId, s.uid, s.arrive_time AS arriveTime, s.ds,
       s.is_fp AS isFp, COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint) AS elementFingerprint,
       COALESCE(NULLIF(d.policy_ids, ''), s.policy_ids) AS policyIds,
       COALESCE(NULLIF(d.ai_evaluate_policy_ids, ''), s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
       COALESCE(d.dc_id, '') AS dcId,
       COALESCE(d.ops_advertiser_name, '') AS opsAdvertiserName,
       COALESCE(NULLIF(s.reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
       rel.category_id AS categoryId, rel.feature_desc AS featureDesc, rel.supplement AS supplement,
       cat.name AS categoryName
       FROM uploaded_classify_data s
       LEFT JOIN (
         SELECT element_value,
           MAX(NULLIF(element_fingerprint, '')) AS element_fingerprint,
           MAX(CASE WHEN policy_ids <> '[]' AND policy_ids <> '' THEN policy_ids END) AS policy_ids,
           MAX(CASE WHEN ai_evaluate_policy_ids <> '[]' AND ai_evaluate_policy_ids <> '' THEN ai_evaluate_policy_ids END) AS ai_evaluate_policy_ids,
           MAX(dc_id) AS dc_id, MAX(class_id) AS class_id,
           MAX(NULLIF(ops_advertiser_name, '')) AS ops_advertiser_name,
           MAX(NULLIF(ai_evaluate_reviewer_name, '')) AS ai_evaluate_reviewer_name,
           MAX(NULLIF(uid, '')) AS uid
         FROM ai_evaluate_detail GROUP BY element_value
       ) d ON d.element_value = s.media_url OR (CASE WHEN instr(d.element_value,'?')>0 THEN substr(d.element_value,1,instr(d.element_value,'?')-1) ELSE d.element_value END) = (CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END)
       LEFT JOIN material_category_relation rel ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
       LEFT JOIN material_category cat ON cat.id = rel.category_id
       WHERE s.tag_id=? ORDER BY s.class_num, s.id`,
      [tagId]
    )

    // 去重：LEFT JOIN material_category_relation / cluster_data 可能产生重复行
    // 按「归一化复合 key」去重：指纹 > 归一化 media_url（去签名参数） > sample_id
    const _norm = (url) => {
      if (!url || typeof url !== 'string') return ''
      try {
        const x = new URL(url)
        const path = x.pathname.replace(/\/+$/, '')
        return `${x.protocol}//${x.hostname.toLowerCase()}${path}`
      } catch { return url.split('?')[0].split('#')[0] }
    }
    const _dedupKey = (r) => {
      if (r.elementFingerprint) return `fp:${r.elementFingerprint}`
      const nu = _norm(r.mediaUrl)
      if (nu) return `url:${nu}`
      return `id:${r.id}`
    }
    const _seenIds = new Set()
    const dedupedRows = []
    // rawTotal：去重前的真实原始样本总数（同一素材因签名参数/不同 sample_id 产生的重复副本计入总数）
    const _rawTotal = rows.length
    for (const r of rows) {
      const key = _dedupKey(r)
      if (key && _seenIds.has(key)) {
        // 已存在：如果当前行有分类信息而之前没有，补充
        const prev = dedupedRows.find(x => _dedupKey(x) === key)
        if (r.categoryId && !prev.categoryId) {
          prev.categoryId = r.categoryId
          prev.featureDesc = r.featureDesc
          prev.supplement = r.supplement
          prev.categoryName = r.categoryName
        }
        continue
      }
      _seenIds.add(key)
      dedupedRows.push(r)
    }

    // 清洗数据
    for (const r of dedupedRows) {
      r.isVideo = !!r.isVideo
      if (r.machineTag) r.machineTag = String(r.machineTag).replace(/[\[\]]/g, '')
      if (r.humanTag) r.humanTag = String(r.humanTag).replace(/[\[\]]/g, '')
    }

    // 通过数组非索引属性携带真实总数（兼容前端 Array.isArray 判断，不影响渲染遍历）
    Object.defineProperty(dedupedRows, 'rawTotal', { value: _rawTotal, enumerable: false, configurable: true })

    res.json(dedupedRows)
  } catch (e) { next(e) }
})

/* ============ 检查标签是否有上传数据 ============
 * 用于前端判断数据优先级：有上传数据 → 用上传数据；无 → 用平台数据
 */
router.get('/:tagId/status', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const rows = await query(
      'SELECT COUNT(*) AS cnt, MAX(uploaded_at) AS latestUpload FROM uploaded_classify_data WHERE tag_id=?',
      [tagId]
    )
    const count = rows.length ? Number(rows[0].cnt) : 0
    const latestUpload = rows.length && rows[0].latestUpload ? String(rows[0].latestUpload).slice(0, 19).replace('T', ' ') : ''
    res.json({ hasUploadedData: count > 0, count, latestUpload })
  } catch (e) { next(e) }
})

/* ============ 上传历史查询 ============ */
router.get('/history', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.query
    let sql = 'SELECT * FROM uploaded_classify_history'
    const params = []
    if (tagId) {
      sql += ' WHERE tag_id=?'
      params.push(tagId)
    }
    sql += ' ORDER BY uploaded_at DESC LIMIT 50'
    const rows = await query(sql, params)
    res.json(rows.map(r => ({
      id: r.id,
      tagId: r.tag_id,
      tagName: r.tag_name,
      fileName: r.file_name,
      sampleCount: r.sample_count,
      classCount: r.class_count,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at ? String(r.uploaded_at).slice(0, 19).replace('T', ' ') : '',
    })))
  } catch (e) { next(e) }
})

/* ============ 一键清空所有上传数据 ============ */
router.delete('/all', requireLogin, async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute('DELETE FROM uploaded_classify_data')
    await conn.execute('DELETE FROM uploaded_classify_history')
    await conn.commit()
    await audit(req, '清空所有上传分类数据', '全部标签')
    res.json({ ok: true, message: '已清空所有上传数据' })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    next(e)
  } finally {
    conn.release()
  }
})

/* ============ 清空指定标签的上传数据 ============ */
router.delete('/:tagId', requireLogin, async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { tagId } = req.params
    await conn.beginTransaction()
    await conn.execute('DELETE FROM uploaded_classify_data WHERE tag_id=?', [tagId])
    await conn.execute('DELETE FROM uploaded_classify_history WHERE tag_id=?', [tagId])
    await conn.commit()
    await audit(req, '清空标签上传数据', `tag#${tagId}`)
    res.json({ ok: true, message: `已清空标签 ${tagId} 的上传数据` })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    next(e)
  } finally {
    conn.release()
  }
})

/* ============ 导出选中上传数据为 Excel ============
 * POST /:tagId/export/excel
 * 请求体: { sampleIds: [...] }
 * 查询 uploaded_classify_data 表，LEFT JOIN ai_evaluate_detail + material_category_relation
 * 复用 tags.js 中 generateExcel 的 Excel 生成逻辑（13列格式）
 */
router.post('/:tagId/export/excel', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const { sampleIds } = req.body || {}
    if (!Array.isArray(sampleIds) || !sampleIds.length) {
      return res.status(400).json({ error: '请选择至少一条素材进行导出' })
    }

    const idPlaceholders = sampleIds.map(() => '?').join(',')
    const idParams = sampleIds.map(String)

    const rows = await query(
      `SELECT s.sample_id AS id, s.element_type AS elementType, s.element_type_name AS elementTypeName,
       s.is_video AS isVideo, s.policy_ids AS machineTag, s.ai_evaluate_policy_ids AS humanTag,
       s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
       s.media_url AS elementValue, s.arrive_time AS arriveTime, s.class_num AS classNum,
       s.uid, s.ds,
       s.ocr_content AS ocrContent, s.asr_content AS asrContent,
       COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint, '') AS elementFingerprint,
       COALESCE(NULLIF(s.class_id, ''), d.class_id, c.class_id) AS classId,
       COALESCE(NULLIF(d.policy_ids, ''), s.policy_ids) AS policyIds,
       COALESCE(NULLIF(d.ai_evaluate_policy_ids, ''), s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
       COALESCE(d.dc_id, '') AS dcId,
       COALESCE(d.ops_advertiser_name, '') AS opsAdvertiserName,
       COALESCE(NULLIF(s.reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
       rel.category_id AS categoryId, rel.feature_desc AS featureDesc,
       rel.supplement AS supplement, cat.name AS categoryName
       FROM uploaded_classify_data s
       LEFT JOIN (
         SELECT element_value,
           MAX(NULLIF(element_fingerprint, '')) AS element_fingerprint,
           MAX(CASE WHEN policy_ids <> '[]' AND policy_ids <> '' THEN policy_ids END) AS policy_ids,
           MAX(CASE WHEN ai_evaluate_policy_ids <> '[]' AND ai_evaluate_policy_ids <> '' THEN ai_evaluate_policy_ids END) AS ai_evaluate_policy_ids,
           MAX(dc_id) AS dc_id, MAX(class_id) AS class_id,
           MAX(NULLIF(ops_advertiser_name, '')) AS ops_advertiser_name,
           MAX(NULLIF(ai_evaluate_reviewer_name, '')) AS ai_evaluate_reviewer_name,
           MAX(NULLIF(uid, '')) AS uid
         FROM ai_evaluate_detail GROUP BY element_value
       ) d ON d.element_value = s.media_url OR (CASE WHEN instr(d.element_value,'?')>0 THEN substr(d.element_value,1,instr(d.element_value,'?')-1) ELSE d.element_value END) = (CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END)
       LEFT JOIN (SELECT element_fingerprint, MAX(class_id) AS class_id, MAX(element_value) AS element_value FROM cluster_data GROUP BY element_fingerprint) c ON c.element_fingerprint = s.element_fingerprint OR c.element_value = s.media_url
       LEFT JOIN material_category_relation rel ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
       LEFT JOIN material_category cat ON cat.id = rel.category_id
       WHERE s.tag_id = ?
         AND s.sample_id IN (${idPlaceholders})
       ORDER BY s.class_num, s.id`,
      [tagId, ...idParams]
    )

    // 去重：LEFT JOIN 可能产生重复行，按 sample_id 去重
    const _exportSeen = new Map()
    for (const r of rows) {
      const key = r.id
      if (!_exportSeen.has(key)) {
        _exportSeen.set(key, r)
      } else {
        const prev = _exportSeen.get(key)
        if (r.categoryId && !prev.categoryId) {
          prev.categoryId = r.categoryId
          prev.supplement = r.supplement
          prev.categoryName = r.categoryName
        }
      }
    }
    const dedupedRows = Array.from(_exportSeen.values())

    // 清洗数据
    for (const r of dedupedRows) {
      if (!r.elementTypeName) r.elementTypeName = mapElementType(r.elementType)
      if (r.machineTag) r.machineTag = String(r.machineTag).replace(/[\[\]]/g, '')
      if (r.humanTag) r.humanTag = String(r.humanTag).replace(/[\[\]]/g, '')
    }

    // 生成 Excel（与 tags.js 的 generateExcel 格式一致：13列）
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('素材特征分类导出', {
      properties: { defaultColWidth: 18 },
      views: [{ state: 'frozen', ySplit: 1 }],
    })

    const headers = [
      '到达时间', 'AMS一级行业名称(开户行业)', 'AMS二级行业名称(开户行业)',
      '审核元素类型', '审核标签ID', 'AI评测人审标签',
      '审核人', '创意ID(DCID)', '客户主体名称(OPS)',
      '审核元素值', '审核物理指纹(md5)', 'ocr_text', 'asr_text',
      'class_num', '分类', '补充说明',
    ]
    const headerRow = ws.addRow(headers)
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F7CFF' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    })
    ws.getRow(1).height = 28

    for (const r of dedupedRows) {
      ws.addRow([
        r.arriveTime || '', r.firstLevelIndustryName || '', r.secondLevelIndustryName || '',
        r.elementTypeName || '', r.machineTag || '', r.humanTag || '',
        r.reviewerName || '', r.dcId || '', r.opsAdvertiserName || '',
        r.elementValue || '', r.elementFingerprint || '',
        r.ocrContent || '', r.asrContent || '',
        r.classNum ?? '', r.categoryName || '', r.supplement || '',
      ])
    }

    ws.columns.forEach((col, i) => {
      let maxLen = headers[i].length
      ws.eachRow((row, rowNum) => {
        if (rowNum > 1) {
          const val = row.getCell(i + 1).value
          const len = val ? String(val).length : 0
          if (len > maxLen) maxLen = len
        }
      })
      col.width = Math.min(Math.max(maxLen + 4, 14), 40)
    })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="upload-tag-${tagId}-export.xlsx"`)

    const buffer = await wb.xlsx.writeBuffer()
    res.send(Buffer.from(buffer))

    await audit(req, '导出上传数据Excel', `tag#${tagId} (${dedupedRows.length}条)`)
  } catch (e) { next(e) }
})

/* ============ 重试上传失败批次 ============
 * 前端收到 partialFailure 后，调用此接口仅重新插入失败的批次数据
 * POST /retry-failed  { tagId, tagName, fileName, failedSamples (失败的样本数组), categories?, supplements? }
 */
router.post('/retry-failed', requireLogin, async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { tagId, tagName, fileName, failedSamples, categories, supplements } = req.body || {}

    if (!tagId || !Array.isArray(failedSamples) || !failedSamples.length) {
      conn.release()
      return res.status(400).json({ error: '缺少 tagId 或 failedSamples' })
    }

    const by = req.currentUser?.name || req.currentUser?.eng || '未知用户'

    // 提高会话超时
    await conn.execute('SET SESSION wait_timeout=600')
    await conn.execute('SET SESSION interactive_timeout=600')

    // 不复用大事务：逐批提交，失败批次继续收集
    const BATCH = 500
    const batchId = Date.now()
    const retryFailedBatches = []

    for (let i = 0; i < failedSamples.length; i += BATCH) {
      const batch = failedSamples.slice(i, i + BATCH)
      try {
        await conn.beginTransaction()

        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
        const values = batch.flatMap(s => {
          const elementType = s.elementType || s.type || ''
          const elementTypeName = s.elementTypeName || mapElementType(elementType) || ''
          const isVideo = s.isVideo ? 1 : (elementType === 'ELEMENT_TYPE_VIDEO' || elementTypeName === '视频') ? 1 : 0
          const machineTag = String(s.machineTag || s.auditTagId || '').replace(/[\[\]]/g, '')
          const humanTag = String(s.humanTag || s.aiReviewTagId || '').replace(/[\[\]]/g, '')
          return [
            tagId, tagName || '', s.sampleId || s.id || '',
            elementType, elementTypeName, isVideo,
            machineTag, humanTag,
            s.industryL1 || s.firstLevelIndustryName || '',
            s.industryL2 || s.secondLevelIndustryName || '',
            s.mediaUrl || s.elementValue || '',
            s.ocrContent || s.ocrText || '',
            s.asrContent || s.asrText || '',
            s.classNum || 0,
            s.classId || '',
            s.uid || '',
            s.arriveTime || '',
            s.ds || '',
            s.elementFingerprint || s.fingerprint || '',
            s.isFp !== undefined ? (s.isFp ? 1 : 0) : 1,
            batchId, by,
            s.dcId || '', s.opsAdvertiserName || '', s.reviewerName || '',
          ]
        })
        await conn.execute(
          `INSERT INTO uploaded_classify_data
           (tag_id, tag_name, sample_id, element_type, element_type_name, is_video, policy_ids, ai_evaluate_policy_ids,
            first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, class_id, uid,
            arrive_time, ds, element_fingerprint, is_fp, batch_id, uploaded_by,
            dc_id, ops_advertiser_name, ai_evaluate_reviewer_name)
           VALUES ${placeholders}`,
          values
        )

        await conn.commit()
      } catch (batchErr) {
        try { await conn.rollback() } catch { /* ignore */ }
        retryFailedBatches.push({
          batchIndex: i,
          start: i,
          end: Math.min(i + BATCH, failedSamples.length),
          count: batch.length,
          error: batchErr.message?.substring(0, 200) || String(batchErr),
        })
        console.error(`[upload:retry] 批次 [${i}-${Math.min(i + BATCH, failedSamples.length)}] 写入失败:`, batchErr.message)
      }
    }

    const succeeded = failedSamples.length - retryFailedBatches.reduce((s, b) => s + b.count, 0)

    if (retryFailedBatches.length > 0 && succeeded === 0) {
      conn.release()
      return res.status(500).json({
        error: '所有重试批次写入失败',
        failedCount: failedSamples.length,
        firstError: retryFailedBatches[0]?.error,
      })
    }

    // 如果有分类信息需要更新
    if (categories || supplements) {
      const catMap = {}
      if (Array.isArray(categories)) {
        for (const c of categories) {
          if (c.sampleId && c.categoryName) catMap[c.sampleId] = { categoryName: c.categoryName, supplement: '' }
        }
      } else if (categories && typeof categories === 'object') {
        for (const [sid, cname] of Object.entries(categories)) {
          if (sid && cname) catMap[sid] = { categoryName: String(cname), supplement: '' }
        }
      }
      if (Array.isArray(supplements)) {
        for (const s of supplements) {
          if (s.sampleId) {
            if (!catMap[s.sampleId]) catMap[s.sampleId] = { categoryName: '', supplement: s.supplement || '' }
            else catMap[s.sampleId].supplement = s.supplement || ''
          }
        }
      } else if (supplements && typeof supplements === 'object') {
        for (const [sid, stext] of Object.entries(supplements)) {
          if (sid) {
            if (!catMap[sid]) catMap[sid] = { categoryName: '', supplement: String(stext) }
            else catMap[sid].supplement = String(stext)
          }
        }
      }
      const catNameToId = {}
      for (const { categoryName } of Object.values(catMap)) {
        if (categoryName && !catNameToId[categoryName]) {
          const existing = await conn.execute(
            'SELECT id FROM material_category WHERE tag_id=? AND name=? LIMIT 1',
            [tagId, categoryName]
          )
          if (existing[0].length) {
            catNameToId[categoryName] = existing[0][0].id
          } else {
            const ins = await conn.execute(
              'INSERT INTO material_category (tag_id, name, feature, source, owner) VALUES (?,?,?,?,?)',
              [tagId, categoryName, '', 'upload', by]
            )
            catNameToId[categoryName] = ins[0].insertId
          }
        }
      }
      for (const [sampleId, info] of Object.entries(catMap)) {
        const categoryId = info.categoryName ? (catNameToId[info.categoryName] || 0) : 0
        await conn.execute(
          `INSERT INTO material_category_relation (tag_id, sample_id, category_id, feature_desc, supplement, owner)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(tag_id, sample_id) DO UPDATE SET category_id=excluded.category_id, supplement=excluded.supplement, owner=excluded.owner`,
          [tagId, sampleId, categoryId, '', info.supplement || '', by]
        )
      }
    }

    conn.release()

    const resultPayload = {
      ok: retryFailedBatches.length === 0,
      sampleCount: succeeded,
      totalRetried: failedSamples.length,
      tagId,
    }

    if (retryFailedBatches.length > 0) {
      resultPayload.partialFailure = true
      resultPayload.failedBatches = retryFailedBatches
      resultPayload.message = `${retryFailedBatches.length} 个批次重试仍失败（${retryFailedBatches.reduce((s, b) => s + b.count, 0)} 条），已成功 ${succeeded} 条`
    }

    await audit(req, '重试上传分类数据', `tag#${tagId}:${fileName || ''} (${succeeded}/${failedSamples.length}条)`)
    res.json(resultPayload)
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    conn.release()
    next(e)
  }
})

export default router