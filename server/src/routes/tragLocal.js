/**
 * 本地 Python 微服务检索逻辑（仅 TRAG_MODE=local 时启用）
 *
 * 从原 routes/trag.js 抽取，保留 MySQL 缓存、标签增强与 503 优雅降级。
 */
import { query } from '../db/pool.js'
import { rewriteDataTables } from '../middleware/dataMode.js'
import { getServiceUrl, markUnhealthy } from '../trag/manager.js'

export async function getLocalSearch(req, res, p) {
  const { task, query, input_mode, tags, first_industries, second_industries, filter_expr, limit, threshold, group_by_video } = p

  const tragUrl = getServiceUrl()
  if (!tragUrl) {
    const status = { starting: false }
    const msg = 'TRAG 检索服务暂不可用，请稍后重试'
    return res.status(503).json({ error: msg, tragStatus: status })
  }

  function buildFilterExpr(tags, firstInds, secondInds, customExpr) {
    const parts = []
    if (tags && tags.length) {
      if (tags.length === 1) parts.push(`policy_list = "${tags[0]}"`)
      else parts.push(`policy_list in (${tags.map((t) => `"${t}"`).join(', ')})`)
    }
    if (firstInds && firstInds.length) {
      if (firstInds.length === 1) parts.push(`v6_level_name_1 = "${firstInds[0]}"`)
      else parts.push(`v6_level_name_1 in (${firstInds.map((v) => `"${v}"`).join(', ')})`)
    }
    if (secondInds && secondInds.length) {
      if (secondInds.length === 1) parts.push(`v6_level_name_2 = "${secondInds[0]}"`)
      else parts.push(`v6_level_name_2 in (${secondInds.map((v) => `"${v}"`).join(', ')})`)
    }
    if (customExpr) parts.push(customExpr)
    return parts.length ? parts.join(' and ') : ''
  }

  const finalFilter = buildFilterExpr(tags, first_industries, second_industries, filter_expr)
  const actualLimit = limit || 10
  const crypto = (await import('node:crypto')).default
  const cacheKey = crypto.createHash('md5')
    .update(`${task}|${query}|${finalFilter}|${actualLimit}|${threshold}`)
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
  } catch { /* ignore */ }

  let r
  try {
    r = await fetch(`${tragUrl}/trag/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, query, input_mode, tags, first_industries, second_industries, filter_expr, limit: actualLimit, threshold, group_by_video }),
      signal: AbortSignal.timeout(60000),
    })
  } catch (fetchErr) {
    markUnhealthy(fetchErr.message)
    return res.status(503).json({ error: 'TRAG 检索服务暂时不可用，正在自动恢复中，请稍后重试' })
  }

  if (!r.ok) {
    const errText = await r.text()
    let detail = errText
    try {
      const errJson = JSON.parse(errText)
      detail = errJson.detail || errJson.error || errJson.message || errText
    } catch { /* ignore */ }
    return res.status(r.status).json({ error: `TRAG检索失败: ${detail}` })
  }

  const data = await r.json()
  const results = data.results || []
  await enrichResultsWithTags(req, results)

  try {
    await query(
      "INSERT OR REPLACE INTO trag_cache (cache_key, task, query_text, results, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
      [cacheKey, task, String(query).slice(0, 500), JSON.stringify(results)]
    )
  } catch { /* ignore */ }

  res.json({ results, total: results.length, task, cached: false })
}

async function enrichResultsWithTags(req, results) {
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
    } catch { /* ignore */ }

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
      } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}
