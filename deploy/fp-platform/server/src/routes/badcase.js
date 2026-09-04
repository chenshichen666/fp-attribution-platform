import { Router } from 'express'
import { rawQuery, query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'
import { rewriteDataTables } from '../middleware/dataMode.js'

const router = Router()

// ===== 两类口径卡片统计 =====
// 精标结果一致：ratio < 40% 或 > 60%
// 精标分歧：40% ≤ ratio ≤ 60%
router.get('/stats', requireLogin, async (req, res, next) => {
  try {
    const { labelId } = req.query
    if (!labelId) return res.status(400).json({ error: 'labelId is required' })

    const labelVal = String(labelId)
    const rows = await rawQuery(
      `SELECT cluster_id, COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(fine_labels) WHERE json_each.value = ?) THEN 1 ELSE 0 END) AS hit
       FROM sample_library_fine_label
       GROUP BY cluster_id
       HAVING hit > 0`,
      [labelVal]
    )

    let consistent = { clusters: 0, elements: 0, high: { clusters: 0, elements: 0 }, low: { clusters: 0, elements: 0 } }
    let disagree = { clusters: 0, elements: 0 }

    for (const r of rows) {
      const total = Number(r.total)
      const hit = Number(r.hit)
      const ratio = total > 0 ? (hit / total * 100) : 0

      if (ratio >= 40 && ratio <= 60) {
        disagree.clusters++
        disagree.elements += total
      } else {
        consistent.clusters++
        consistent.elements += total
        if (ratio > 60) { consistent.high.clusters++; consistent.high.elements += total }
        if (ratio < 40) { consistent.low.clusters++; consistent.low.elements += total }
      }
    }

    return res.json({ consistent, disagree })
  } catch (e) { next(e) }
})

// ===== 聚类簇列表（含该标签的簇） =====
router.get('/clusters', requireLogin, async (req, res, next) => {
  try {
    const { labelId, sort = 'ratio' } = req.query
    if (!labelId) return res.status(400).json({ error: 'labelId is required' })

    const labelVal2 = String(labelId)
    const rows = await rawQuery(
      `SELECT cluster_id, COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(fine_labels) WHERE json_each.value = ?) THEN 1 ELSE 0 END) AS hit,
              SUM(CASE WHEN element_type IN ('视频','VIDEO','ELEMENT_TYPE_VIDEO') THEN 1 ELSE 0 END) AS video_cnt
       FROM sample_library_fine_label
       GROUP BY cluster_id
       HAVING hit > 0`,
      [labelVal2]
    )

    const clusters = rows.map(r => {
      const total = Number(r.total)
      const hit = Number(r.hit)
      const ratio = total > 0 ? Number((hit / total * 100).toFixed(1)) : 0
      let zone
      if (ratio >= 40 && ratio <= 60) zone = 'disagree'
      else if (ratio > 60) zone = 'cons_high'
      else zone = 'cons_low'
      return {
        clusterId: r.cluster_id,
        total,
        hit,
        ratio,
        zone,
        videoCount: Number(r.video_cnt) || 0,
        imageCount: total - (Number(r.video_cnt) || 0),
      }
    })

    // 排序
    if (sort === 'n') clusters.sort((a, b) => b.total - a.total)
    else clusters.sort((a, b) => Math.abs(b.ratio - 50) - Math.abs(a.ratio - 50))

    return res.json({ clusters, total: clusters.length })
  } catch (e) { next(e) }
})

// ===== 直方图数据（按标签占比区间统计簇数） =====
router.get('/histogram', requireLogin, async (req, res, next) => {
  try {
    const { labelId } = req.query
    if (!labelId) return res.status(400).json({ error: 'labelId is required' })

    const labelVal3 = String(labelId)
    const rows = await rawQuery(
      `SELECT cluster_id, COUNT(*) AS total,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(fine_labels) WHERE json_each.value = ?) THEN 1 ELSE 0 END) AS hit
       FROM sample_library_fine_label
       GROUP BY cluster_id
       HAVING hit > 0`,
      [labelVal3]
    )

    // 10 个区间：[0,10), [10,20), ..., [90,100]
    const buckets = Array.from({ length: 10 }, (_, i) => ({ min: i * 10, max: (i + 1) * 10, count: 0 }))
    // 最后一个区间边界包含 100
    buckets[9].max = 101

    for (const r of rows) {
      const total = Number(r.total)
      const hit = Number(r.hit)
      const ratio = total > 0 ? (hit / total * 100) : 0
      const idx = Math.min(Math.floor(ratio / 10), 9)
      buckets[idx].count++
    }

    return res.json({ buckets })
  } catch (e) { next(e) }
})

// ===== 可用标签列表 =====
router.get('/labels', requireLogin, async (req, res, next) => {
  try {
    const rows = await rawQuery(`SELECT DISTINCT fine_labels FROM sample_library_fine_label LIMIT 5000`)
    const labelSet = new Set()
    for (const r of rows) {
      try {
        const raw = r.fine_labels
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]')
        arr.forEach(l => { if (l) labelSet.add(String(l)) })
      } catch { /* ignore */ }
    }
    return res.json([...labelSet].sort())
  } catch (e) { next(e) }
})

// ===== 簇元素明细 =====
router.get('/clusters/:clusterId/elements', requireLogin, async (req, res, next) => {
  try {
    const { clusterId } = req.params
    const { labelId } = req.query

    let where = 'WHERE cluster_id = ?'
    const params = [clusterId]

    const rows = await rawQuery(
      `SELECT id, cluster_id, element_value, element_fingerprint, element_type,
              fine_labels, first_level_industry_name, second_level_industry_name
       FROM sample_library_fine_label ${where}
       ORDER BY id`,
      params
    )

    const elements = rows.map(r => {
      let labels = []
      try { labels = Array.isArray(r.fine_labels) ? r.fine_labels : JSON.parse(r.fine_labels || '[]') } catch { /* ignore */ }
      return {
        id: r.id,
        clusterId: r.cluster_id,
        elementValue: r.element_value || '',
        elementFingerprint: r.element_fingerprint || '',
        elementType: r.element_type || '图片',
        fineLabels: labels,
        firstLevelIndustry: r.first_level_industry_name || '',
        secondLevelIndustry: r.second_level_industry_name || '',
      }
    })

    return res.json({ elements, total: elements.length })
  } catch (e) { next(e) }
})

// ===== 检查是否有数据 =====
router.get('/has-data', requireLogin, async (req, res, next) => {
  try {
    const rows = await rawQuery(`SELECT COUNT(*) AS c FROM sample_library_fine_label`)
    return res.json({ hasData: rows.length > 0 && Number(rows[0].c) > 0, count: rows.length ? Number(rows[0].c) : 0 })
  } catch (e) { next(e) }
})

// ===== 数据洞察看板（真实数据，real_data_samples 样本级聚合） =====
// 三块：周精度趋势 / 行业置值下钻 / 3日精度快照；不受全局时间窗口影响
// 精度口径统一 = TP/(TP+FP)，TP = 总数 - FP（is_fp=1）
router.get('/data-insight', requireLogin, async (req, res, next) => {
  try {
    const tagId = req.query.tagId
    if (!tagId) return res.status(400).json({ error: 'tagId is required' })
    // 行业置值下钻时间窗口：days = 近N天（7/14/30）；start/end = 自定义区间
    const days = Number(req.query.days) || 0
    const start = (req.query.start || '').trim()
    const end = (req.query.end || '').trim()

    // arrive_time 兼容 '2026-07-15T00:00:00' / '2026-07-15' / '2026/07/15'
    const dayExpr = `DATE(REPLACE(NULLIF(arrive_time, ''), '/', '-'))`
    const where = `tag_id = ? AND arrive_time IS NOT NULL AND LENGTH(TRIM(arrive_time)) >= 8`
    const args = [tagId]

    const fmt = (d) => {
      if (!d) return ''
      const s = String(d).slice(0, 10)
      const dt = new Date(s + 'T00:00:00')
      if (isNaN(dt.getTime())) return ''
      return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}`
    }
    const shift = (d, n) => {
      const dt = new Date(String(d).slice(0, 10) + 'T00:00:00')
      dt.setDate(dt.getDate() + n)
      return dt.toISOString().slice(0, 10)
    }

    // ===== 1) 周精度趋势（按 ISO 周聚合，W1..Wn 顺序编号） =====
    const weekRows = await query(
      rewriteDataTables(req, `SELECT MIN(${dayExpr}) AS startD, MAX(${dayExpr}) AS endD,
              COUNT(*) AS total, SUM(is_fp) AS fp
       FROM real_data_samples
       WHERE ${where}
       GROUP BY strftime('%Y-%W', REPLACE(NULLIF(arrive_time, ''), '/', '-'))
       ORDER BY startD ASC`),
      args
    )
    const trend = { weeks: [], dateRanges: [], precision: [], tp: [], fp: [], total: [] }
    if (weekRows.length === 0) {
      // 无真实数据时用 mock 数据（参照图片趋势：W1~W19，从50%开始治理后整体上升但有波动）
      const mockPrec = [51.5, 55.4, 66.5, 67.2, 75.1, 62.8, 69.8, 75.7, 77.2, 78.1, 87.5, 86.2, 83.2, 86.0, 87.0, 89.3, 89.0, 86.5, 85.3]
      const mockTotal = [820, 890, 960, 1020, 1100, 950, 1000, 1080, 1120, 1150, 1300, 1260, 1180, 1240, 1280, 1350, 1320, 1270, 1230]
      // 生成每周日期范围（从 2026-01-06 每7天一组）
      const baseMs = new Date('2026-01-05T00:00:00').getTime()
      mockPrec.forEach((prec, i) => {
        const s = new Date(baseMs + i * 7 * 86400000)
        const e = new Date(baseMs + i * 7 * 86400000 + 6 * 86400000)
        const fmtD = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
        const total = mockTotal[i]
        const fp = Math.round(total * (1 - prec / 100))
        const tp = total - fp
        trend.weeks.push(`W${i + 1}`)
        trend.dateRanges.push(`${fmtD(s)}~${fmtD(e)}`)
        trend.precision.push(prec)
        trend.tp.push(tp)
        trend.fp.push(fp)
        trend.total.push(total)
      })
    } else {
      weekRows.forEach((r, i) => {
        const total = Number(r.total) || 0
        const fp = Number(r.fp) || 0
        const tp = total - fp
        trend.weeks.push(`W${i + 1}`)
        trend.dateRanges.push(`${fmt(r.startD)}~${fmt(r.endD)}`)
        trend.precision.push(total > 0 ? Number((tp / total * 100).toFixed(1)) : 0)
        trend.tp.push(tp)
        trend.fp.push(fp)
        trend.total.push(total)
      })
    }

    // ===== 2) 行业置值下钻（行业 × 元素类型，误杀 = fp） =====
    const elemMap = (t) => {
      const s = String(t || '').toUpperCase()
      if (s.includes('VIDEO')) return 'VIDEO'
      if (s.includes('IMAGE') || s.includes('图片')) return 'IMAGE'
      if (s.includes('TEXT') || s.includes('文本')) return 'TEXT'
      if (s.includes('URL') || s.includes('落地')) return 'URL'
      return s || 'IMAGE'
    }
    // 先求样本最新日期 maxD，用于「近N天」起点
    const maxRows = await query(
      rewriteDataTables(req, `SELECT MAX(${dayExpr}) AS maxD FROM real_data_samples WHERE ${where}`),
      args
    )
    const maxD = maxRows.length ? maxRows[0].maxD : null

    // 行业下钻时间窗口过滤：近N天（相对 maxD）或自定义区间
    let indWhere = where
    const indArgs = [tagId]
    if (days > 0 && maxD) {
      indWhere += ` AND ${dayExpr} >= ?`
      indArgs.push(shift(maxD, -(days - 1)))
    } else if (start && end) {
      indWhere += ` AND ${dayExpr} BETWEEN ? AND ?`
      indArgs.push(start, end)
    }

    const indRows = await query(
      rewriteDataTables(req, `SELECT first_level_industry_name AS industry, element_type AS elementType,
              MAX(${dayExpr}) AS cutoff,
              COUNT(*) AS total, SUM(is_fp) AS fp
       FROM real_data_samples
       WHERE ${indWhere}
       GROUP BY first_level_industry_name, element_type
       ORDER BY fp DESC, total DESC`),
      indArgs
    )
    const industryRows = indRows.map(r => {
      const total = Number(r.total) || 0
      const fp = Number(r.fp) || 0
      return {
        industry: r.industry || '未知行业',
        elementType: elemMap(r.elementType),
        precision: total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0,
        fpCount: fp,
        total,
      }
    })

    return res.json({
      trend,
      industryDrillDown: { cutoffDate: maxD || '', days, rows: industryRows },
    })
  } catch (e) { next(e) }
})

// ===== 聚类簇特征总结（可编辑套路）：按标签读取 =====
router.get('/cluster-features', requireLogin, async (req, res, next) => {
  try {
    const tagId = req.query.tagId
    if (!tagId) return res.status(400).json({ error: 'tagId is required' })
    const rows = await query(
      'SELECT class_id AS classId, feature_summary AS featureSummary, owner, updated_at AS updatedAt FROM cluster_features WHERE tag_id=? ORDER BY updated_at DESC',
      [tagId]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// ===== 聚类簇特征总结（可编辑套路）：保存（upsert） =====
router.post('/cluster-features', requireLogin, async (req, res, next) => {
  try {
    const { tagId, classId, featureSummary = '' } = req.body || {}
    if (!tagId || !classId) return res.status(400).json({ error: 'tagId and classId are required' })
    await query(
      `INSERT INTO cluster_features (tag_id, class_id, feature_summary, owner)
       VALUES (?,?,?,?)
       ON CONFLICT(tag_id, class_id) DO UPDATE SET feature_summary=excluded.feature_summary, owner=excluded.owner`,
      [tagId, String(classId), String(featureSummary || ''), req.currentUser.name || '']
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export default router
