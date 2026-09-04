import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'
import { rewriteDataTables } from '../middleware/dataMode.js'
import { TASK_TYPES, getTasks, search as upstreamSearch, exportCsv, uploadImage as upstreamUploadImage, isLocalMode, baseUrl } from '../trag/upstream.js'
import { getServiceUrl as getLocalServiceUrl, getStatus } from '../trag/manager.js'
import { getLocalSearch } from './tragLocal.js'
import { localSearch, localExportCsv, localUploadImage } from '../trag/localEngine.js'
import crypto from 'node:crypto'

const router = Router()

// ===== 任务类型列表 =====
router.get('/tasks', requireLogin, async (req, res, next) => {
  try {
    if (isLocalMode()) {
      const localUrl = getLocalServiceUrl()
      if (localUrl) {
        try {
          const r = await fetch(`${localUrl}/trag/tasks`, { signal: AbortSignal.timeout(5000) })
          if (r.ok) {
            const data = await r.json()
            return res.json(data)
          }
        } catch { /* 本地不可达，回退静态 */ }
      }
      return res.json(TASK_TYPES)
    }
    // 上游模式：尝试从正式服务拉取最新任务元信息，失败回退静态
    const tasks = await getTasks()
    res.json(tasks && tasks.length ? tasks : TASK_TYPES)
  } catch {
    res.json(TASK_TYPES)
  }
})

// ===== 检索（带缓存） =====
router.post('/search', requireLogin, async (req, res, next) => {
  try {
    const { task, query, input_mode = 'auto', tags, first_industries, second_industries,
            filter_expr, limit = 10, threshold = 0, group_by_video = false } = req.body

    if (!task || !query) return res.status(400).json({ error: 'task 和 query 为必填参数' })

    // 统一把数组参数规整
    const arr = (v) => Array.isArray(v) ? v : (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [])
    const normTags = arr(tags)
    const normL1 = arr(first_industries)
    const normL2 = arr(second_industries)

    // 本地兜底模式：仍然走原 Python 微服务 + MySQL 缓存
    if (isLocalMode()) {
      return await getLocalSearch(req, res, {
        task, query, input_mode, tags: normTags, first_industries: normL1,
        second_industries: normL2, filter_expr, limit, threshold, group_by_video,
      })
    }

    // ===== 上游模式：直接转发正式 TRAG API =====
    // 构建缓存 key（与正式服务返回结果缓存一致）
    const finalFilter = filter_expr || ''
    const actualLimit = limit || 10
    const cacheKey = crypto.createHash('md5')
      .update(`${task}|${query}|${finalFilter}|${normTags.join(',')}|${normL1.join(',')}|${normL2.join(',')}|${actualLimit}|${threshold}|${group_by_video}`)
      .digest('hex')

    try {
      const cached = await query(
        "SELECT results FROM trag_cache WHERE cache_key = ? AND created_at > datetime('now','localtime','-24 hours')",
        [cacheKey]
      )
      if (cached.length) {
        const row = cached[0]
        let results = typeof row.results === 'string' ? JSON.parse(row.results) : row.results
        await enrichResultsWithTags(req, results)
        return res.json({ results, total: results.length, task, cached: true })
      }
    } catch { /* 缓存表可能不存在，忽略 */ }

    let data
    try {
      data = await upstreamSearch({
        task, query, limit: actualLimit, filter_expr: finalFilter,
        tags: normTags, first_industries: normL1, second_industries: normL2,
        group_by_video, threshold,
      })
    } catch (e) {
      // 上游（内网 IDC 向量集群）不可达 —— 外网 Demo 的正常情况。
      // 回退到本地检索引擎，保证「点击素材 → 相似样本检索」链路真实可用，
      // 而不是返回一个错误把功能废掉。
      try {
        const local = await localSearch({
          task, query, limit: actualLimit, threshold,
          tags: normTags, first_industries: normL1, second_industries: normL2,
        })
        const localResults = local.results || []
        await enrichResultsWithTags(req, localResults)
        try {
          await query(
            "INSERT OR REPLACE INTO trag_cache (cache_key, task, query_text, results, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
            [cacheKey, task, String(query).slice(0, 500), JSON.stringify(localResults)]
          )
        } catch { /* ignore */ }
        return res.json({
          results: localResults,
          total: localResults.length,
          task,
          cached: false,
          engine: 'local',
          engineNote: local.engineNote,
          upstreamError: e.message,
        })
      } catch (localErr) {
        return res.status(502).json({
          error: `上游检索失败且本地引擎异常: ${localErr.message}`,
          tragStatus: { mode: 'upstream', base: baseUrl() },
        })
      }
    }

    const results = data.results || []

    // 数据增强：根据 elementFingerprint 补充标签ID（policy_ids / ai_evaluate_policy_ids）
    await enrichResultsWithTags(req, results)

    try {
      await query(
        "INSERT OR REPLACE INTO trag_cache (cache_key, task, query_text, results, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
        [cacheKey, task, String(query).slice(0, 500), JSON.stringify(results)]
      )
    } catch { /* ignore */ }

    res.json({ results, total: results.length, task, cached: false })
  } catch (e) {
    next(e)
  }
})

// ===== CSV 导出 =====
router.post('/export_csv', requireLogin, async (req, res, next) => {
  try {
    const { task, query, results } = req.body
    if (!task || !Array.isArray(results)) {
      return res.status(400).json({ error: 'task 与 results 为必填参数' })
    }
    let csv
    try {
      csv = await exportCsv({ task, query, results })
    } catch (e) {
      // 上游不可达：CSV 只是结果序列化，本地即可完成，无需依赖外部服务
      try {
        csv = localExportCsv({ task, query, results })
      } catch (localErr) {
        return res.status(502).json({ error: `CSV 导出失败: ${localErr.message}` })
      }
    }
    res.setHeader('Content-Type', csv.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${csv.filename}"`)
    res.setHeader('Cache-Control', 'no-store')
    return res.send(csv.buffer)
  } catch (e) {
    next(e)
  }
})

// ===== 图片上传（契约 3.5 节 POST /api/upload_image） =====
// 返回 { url, filename, size }，url 可作为 image_image_shangshu / video_frame 任务的 query
// 支持 multipart/form-data（字段名 file）与 json（{ filename, data_url }）两种方式
router.post('/upload_image', requireLogin, async (req, res, next) => {
  try {
    // 本地兜底模式：转 Python 微服务（multipart 透传）
    if (isLocalMode()) {
      try {
        const localUrl = getLocalServiceUrl()
        if (localUrl) {
          const r = await fetch(`${localUrl}/trag/upload_image`, {
            method: 'POST',
            headers: { ...req.headers, host: undefined, connection: undefined },
            body: req, // 直接透传原始请求流（multipart）
          })
          if (r.ok) {
            const data = await r.json()
            return res.json(data)
          }
          const errText = await r.text().catch(() => '')
          return res.status(r.status || 502).json({ error: errText || '本地上传失败' })
        }
      } catch (localErr) {
        return res.status(503).json({ error: `本地图片上传失败: ${localErr.message}` })
      }
    }

    // ===== 上游模式：优先用 data_url（json）转发，避免 Node 侧重新组装 multipart =====
    // 前端统一以 { filename, data_url } 方式上传
    const { filename, data_url } = req.body || {}
    if (!data_url) {
      return res.status(400).json({ error: '缺少 data_url（图片 base64 data URL）' })
    }
    let data
    try {
      data = await upstreamUploadImage({ filename, dataUrl: data_url })
    } catch (e) {
      // 上游（商数 API）不可达：改为本地落盘，保证「上传图片 → 以图搜图」链路可用
      try {
        data = localUploadImage({ filename, dataUrl: data_url })
      } catch (localErr) {
        const status = localErr.status || 502
        return res.status(status).json({ error: localErr.message })
      }
    }
    res.json(data)
  } catch (e) {
    next(e)
  }
})

// 数据增强：根据 elementFingerprint 补充标签ID 与标签名（沿用历史逻辑）
export async function enrichResultsWithTags(req, results) {
  if (!results || !results.length) return
  const fingerprints = [...new Set(results.map((item) =>
    item.elementFingerprint || item.element_fingerprint || ''
  ).filter(Boolean))]
  if (!fingerprints.length) return

  try {
    const tagNameMap = {}
    try {
      const rdtTags = await query(rewriteDataTables(req, `SELECT tag_id AS id, tag_name AS name FROM real_data_tags WHERE tag_name IS NOT NULL AND tag_name != ''`))
      for (const t of rdtTags) tagNameMap[t.id] = t.name
    } catch { /* ignore */ }
    try {
      const rdtpTags = await query(rewriteDataTables(req, `SELECT tag_id AS id, tag_name AS name FROM real_data_tag_precision WHERE tag_name IS NOT NULL AND tag_name != ''`))
      for (const t of rdtpTags) if (!tagNameMap[t.id]) tagNameMap[t.id] = t.name
    } catch { /* ignore */ }

    function parseTagIds(raw) {
      if (!raw) return []
      const ids = String(raw).replace(/[\[\]"'\s]/g, '').split(',').filter(Boolean).map(Number)
      return ids.map((id) => ({ id, name: tagNameMap[id] || '未知标签' }))
    }

    const tagMap = {}
    const placeholders = fingerprints.map(() => '?').join(',')
    try {
      const rdsRows = await query(
        rewriteDataTables(req, `SELECT element_fingerprint, policy_ids, ai_evaluate_policy_ids FROM real_data_samples WHERE element_fingerprint IN (${placeholders})`),
        fingerprints
      )
      for (const row of rdsRows) {
        tagMap[row.element_fingerprint] = { machineTagRaw: row.policy_ids || '', humanTagRaw: row.ai_evaluate_policy_ids || '' }
      }
    } catch { /* 表可能不存在 */ }

    const missingFps = fingerprints.filter((fp) => !tagMap[fp])
    if (missingFps.length) {
      try {
        const mp = missingFps.map(() => '?').join(',')
        const aideRows = await query(
          `SELECT element_fingerprint, policy_ids, ai_evaluate_policy_ids, dc_id FROM ai_evaluate_detail WHERE element_fingerprint IN (${mp})`,
          missingFps
        )
        for (const row of aideRows) {
          const rawHuman = row.ai_evaluate_policy_ids
          const isHumanEmpty = rawHuman === '[]' || (Array.isArray(rawHuman) && rawHuman.length === 0)
            || (typeof rawHuman === 'string' && rawHuman.replace(/[\s\[\]"']/g, '') === '')
          tagMap[row.element_fingerprint] = { machineTagRaw: row.policy_ids || '', humanTagRaw: rawHuman || '', isHumanEmpty, dc_id: row.dc_id || '' }
        }
      } catch { /* 表可能不存在 */ }
    }

    for (const item of results) {
      const fp = item.elementFingerprint || item.element_fingerprint || ''
      if (fp && tagMap[fp]) {
        const t = tagMap[fp]
        item.machineTag = t.machineTagRaw
        item.humanTag = t.humanTagRaw
        item.humanTagEmpty = t.isHumanEmpty || false
        item.dcId = t.dc_id || ''
        item.machineTags = parseTagIds(t.machineTagRaw)
        item.humanTags = parseTagIds(t.humanTagRaw)
      } else {
        const rawPolicyList = item.policy_list || []
        if (Array.isArray(rawPolicyList) && rawPolicyList.length) {
          const policyIds = rawPolicyList.filter((id) => typeof id === 'string' || typeof id === 'number')
          if (policyIds.length) {
            item.machineTags = policyIds.map((id) => ({ id, name: tagNameMap[id] || '未知标签' }))
            item.machineTag = JSON.stringify(policyIds)
          }
        }
      }
    }
  } catch { /* 表可能不存在，忽略 */ }
}

export default router
