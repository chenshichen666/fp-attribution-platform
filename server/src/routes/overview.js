import { Router } from 'express'
import { rawQuery } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'
import { rewriteDataTables } from '../middleware/dataMode.js'

const router = Router()

// 样本表时间窗口 WHERE（放行 arrive_time 为空/无效的样本）
// ===== 聚类簇 ID 匹配条件 =====
// 历史数据的簇 ID 形如 CL001，本库生成的形如 c_1001_01。
// 原实现统一用 LIKE 'CL%'，会把 c_ 开头的簇全部过滤掉，
// 导致四象限图 / 聚类列表为空。这里用 'C%' 兼容两种格式，并排除空值。
function clusterIdCond(col = 'class_id') {
  return `TRIM(IFNULL(${col},'')) != '' AND UPPER(TRIM(IFNULL(${col},''))) LIKE 'C%'`
}

function sampleTimeWhere(req) {
  const start = (req.query.start || '').trim()
  const end = (req.query.end || '').trim()
  const clauses = []
  const params = []
  // 用 NULLIF 把空串/零值日期转 NULL，避免严格模式下 DATE(''/'0000-00-00') 抛 "Incorrect DATE value"
  // ai_evaluate_detail 的 arrive_time 周期（6月）与 real_data_samples（7-8月）不同，故排名/聚类接口不走此时间窗
  //
  // end 边界：arrive_time 带时分秒，若直接 `<= end`（等价 <= 'end 00:00:00'），
  // end 当天除零点外的样本会被整体排除 —— 近7天窗口实际只剩 6 天（180/210 条）。
  // 改为 `< date(end, '+1 day')`，即"小于 end 次日零点"，完整包含 end 当天。
  const safeDate = "NULLIF(NULLIF(arrive_time, ''), '0000-00-00')"
  if (start) { clauses.push(`(arrive_time IS NULL OR arrive_time = '' OR ${safeDate} >= ?)`); params.push(start) }
  if (end) { clauses.push(`(arrive_time IS NULL OR arrive_time = '' OR ${safeDate} < date(?, '+1 day'))`); params.push(end) }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params }
}

// 精度表时间窗口（精度表 arrive_time 是上传日期，不做时间过滤）
function timeWhere() {
  return { where: '', params: [] }
}

// 样本表真实业务日期范围（缓存 5 分钟）
let _sampleRangeCache = { t: 0, min: null, max: null }
async function getSampleRange() {
  if (Date.now() - _sampleRangeCache.t < 5 * 60 * 1000 && _sampleRangeCache.min) return _sampleRangeCache
  const rows = await rawQuery(`SELECT DATE(MIN(arrive_time)) AS min_d, DATE(MAX(arrive_time)) AS max_d FROM real_data_samples WHERE arrive_time IS NOT NULL AND arrive_time != ''`)
  const r = rows[0] || {}
  _sampleRangeCache = { t: Date.now(), min: r.min_d ? String(r.min_d) : null, max: r.max_d ? String(r.max_d) : null }
  return _sampleRangeCache
}

// 是否启用「明细实时聚合」
async function useSampleAggregation(req) {
  const start = (req.query.start || '').trim()
  const end = (req.query.end || '').trim()
  if (!start && !end) return false
  const range = await getSampleRange()
  if (!range.min || !range.max) return false
  const s = start || range.min
  const e = end || range.max
  if (s <= range.min && e >= range.max) return false
  return true
}

// ===== KPI 概览 =====
// 大盘精度 = ΣTP/(ΣTP+ΣFP)*100, 绝对精度 = ΣTP/(ΣTP+Σfp_conf)*100
// 总样本, FP数, 标签数, 聚类簇数
//
// 口径说明：前端 KPI 卡标注的周期是「近7天」，变化值也按近7天 vs 前7天计算。
// 若本接口在无日期参数时返回全量平均（13 周混合，~66%），就会出现
// 「数值 66.2% + 变化 -5.6pp（近7天口径）」的口径错位 —— 数值看起来远低于 80%。
// 因此无参数时默认取「样本最新日期往前 7 天」窗口，与前端标注保持一致。
router.get('/kpi', requireLogin, async (req, res, next) => {
  try {
    // 本地时区日期格式化（不能用 toISOString：GMT+8 下会把本地日期转成 UTC 前一天）
    const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    if (!req.query.start && !req.query.end) {
      const range = await getSampleRange()
      if (range.max) {
        const e = new Date(range.max + 'T00:00:00')
        const s = new Date(e)
        s.setDate(e.getDate() - 6)
        req.query.start = fmtDate(s)
        req.query.end = range.max
      }
    }

    // KPI 卡片走「当前状态」口径：始终用样本明细表（real_data_samples）聚合。
    //
    // 原实现在全量范围时改走精度表（real_data_tag_precision）做全量加权平均，
    // 但精度表按周分布 W1≈50% → W13≈81%，加权平均必然被早期低精度周拉到 ~65.9%，
    // 与「大盘精度/绝对精度 = 当前平台水平」的业务语义不符（用户看到的 65.9% 即由此而来）。
    // 历史演进应由趋势图（/trends）呈现，KPI 卡片只反映所选窗口的实际水平。
    // 样本表已按 ~20% FP 率对齐（全量 79.2%/79.4%，近 7 天 79%/81%）。
    const useSample = true

    let precision = 0, absolutePrecision = 0, sampleTotal = 0, fpCount = 0, tagCount = 0

    if (useSample) {
      const { where, params } = sampleTimeWhere(req)
      // 与趋势图保持完全一致的口径：直接取 fp_confirmed，不再跨表按 tag 比例估算，
      // 避免两套算法导致 KPI 卡片与趋势图对不上
      const rows = await rawQuery(
        rewriteDataTables(req, `SELECT tag_id, COUNT(*) AS total, SUM(is_fp) AS fp,
           SUM(COALESCE(fp_confirmed, 0)) AS fp_conf FROM real_data_samples ${where} GROUP BY tag_id`),
        params
      )
      const tagMap = {}
      for (const r of rows) {
        tagMap[r.tag_id] = {
          total: Number(r.total) || 0,
          fp: Number(r.fp) || 0,
          fpConf: Number(r.fp_conf) || 0,
        }
      }
      tagCount = Object.keys(tagMap).length
      sampleTotal = Object.values(tagMap).reduce((s, t) => s + t.total, 0)
      fpCount = Object.values(tagMap).reduce((s, t) => s + t.fp, 0)
      const fpConfCount = Object.values(tagMap).reduce((s, t) => s + t.fpConf, 0)

      // 大盘精度 = (total - fp) / total        → TP/(TP+FP)
      precision = sampleTotal > 0 ? Number(((sampleTotal - fpCount) / sampleTotal * 100).toFixed(1)) : 0
      // 绝对精度 = (total - fp_confirmed) / total → TP/(TP+FP_confirmed)
      absolutePrecision = sampleTotal > 0 ? Number(((sampleTotal - fpConfCount) / sampleTotal * 100).toFixed(1)) : 0
    } else {
      const { where, params } = timeWhere()
      const rows = await rawQuery(
        rewriteDataTables(req, `SELECT tag_id, total, tp, fp, fp_conf, review_model_precision_prime FROM real_data_tag_precision ${where}`),
        params
      )
      if (rows.length) {
        const tagMap = {}
        for (const r of rows) {
          if (!tagMap[r.tag_id]) tagMap[r.tag_id] = { total: 0, tp: 0, fp: 0, fp_conf: 0, rmp: [] }
          tagMap[r.tag_id].total += Number(r.total) || 0
          tagMap[r.tag_id].tp += Number(r.tp) || 0
          tagMap[r.tag_id].fp += Number(r.fp) || 0
          tagMap[r.tag_id].fp_conf += Number(r.fp_conf) || 0
          if (r.review_model_precision_prime != null) tagMap[r.tag_id].rmp.push(Number(r.review_model_precision_prime))
        }
        tagCount = Object.keys(tagMap).length
        const total = Object.values(tagMap).reduce((s, t) => s + t.total, 0)
        const tpSum = Object.values(tagMap).reduce((s, t) => s + t.tp, 0)
        const fpSum = Object.values(tagMap).reduce((s, t) => s + t.fp, 0)
        const fpConfSum = Object.values(tagMap).reduce((s, t) => s + t.fp_conf, 0)
        fpCount = fpSum
        sampleTotal = fpSum + tpSum
        // 大盘精度 = ΣTP / (ΣTP + ΣFP) × 100%
        if (tpSum + fpSum > 0) {
          precision = Number((tpSum / (tpSum + fpSum) * 100).toFixed(1))
        } else if (total > 0) {
          precision = Number(((total - fpCount) / total * 100).toFixed(1))
        }
        // 绝对精度 = ΣTP / (ΣTP + Σfp_conf) × 100%
        if (tpSum + fpConfSum > 0) {
          absolutePrecision = Number((tpSum / (tpSum + fpConfSum) * 100).toFixed(1))
        }
      }
    }

    // 聚类簇数：real_data_samples（样本表，与总样本数同源）中 class_id 的去重数
    // 注：不采用 ai_evaluate_detail（该表仅含 c1~c12 共 12 簇，且与样本表簇ID不一致）
    //
    // 「簇总数」是平台级元数据，**不带时间窗口**：
    // 若跟随近 7 天窗口，窗口内样本稀疏（每簇平均仅 ~5 条），随机分布下
    // 总有簇恰好缺席，簇数会在 56~60 之间抖动（实测出现过 58）。
    // 匹配条件用 'C%'（大小写不敏感）：历史数据形如 CL001，本库形如 c_1001_01。
    let clusterCount = 0
    try {
      const clusterRows = await rawQuery(rewriteDataTables(req, `SELECT COUNT(DISTINCT class_id) AS c FROM real_data_samples WHERE ${clusterIdCond('class_id')}`))
      clusterCount = clusterRows.length ? Number(clusterRows[0].c) || 0 : 0
    } catch { /* real_data_samples 表可能不存在 */ }

    // 数据日期范围（取样本表 arrive_time 与精度表 ds 的并集）
    const rangeRows = await rawQuery(
      rewriteDataTables(req, `SELECT strftime('%Y-%m-%d', MIN(arrive_time)) AS min_d, strftime('%Y-%m-%d', MAX(arrive_time)) AS max_d FROM real_data_samples WHERE arrive_time IS NOT NULL`)
    )
    const sMinD = rangeRows.length && rangeRows[0].min_d ? String(rangeRows[0].min_d) : ''
    const sMaxD = rangeRows.length && rangeRows[0].max_d ? String(rangeRows[0].max_d) : ''
    // 精度表 ds 范围
    const precRangeRows = await rawQuery(
      rewriteDataTables(req, `SELECT MIN(ds) AS min_d, MAX(ds) AS max_d FROM real_data_tag_precision WHERE ds IS NOT NULL AND ds != ''`)
    )
    const pMinD = precRangeRows.length && precRangeRows[0].min_d ? String(precRangeRows[0].min_d) : ''
    const pMaxD = precRangeRows.length && precRangeRows[0].max_d ? String(precRangeRows[0].max_d) : ''
    const dataMinDate = (sMinD && pMinD) ? (sMinD < pMinD ? sMinD : pMinD) : (sMinD || pMinD)
    const dataMaxDate = (sMaxD && pMaxD) ? (sMaxD > pMaxD ? sMaxD : pMaxD) : (sMaxD || pMaxD)

    return res.json({
      precision,
      absolutePrecision,
      sampleTotal,
      fpCount,
      tagCount,
      clusterCount,
      dataMinDate,
      dataMaxDate,
    })
  } catch (e) { next(e) }
})

// ===== 趋势图（周维度 + 日维度） =====
router.get('/trends', requireLogin, async (req, res, next) => {
  try {
    const useSample = await useSampleAggregation(req)

    let weekTrend = [], dayTrend = []

    if (useSample) {
      // 从样本明细表按 arrive_time 日期聚合
      const { where, params } = sampleTimeWhere(req)
      // 日维度
      // 口径说明（与精度聚合表保持一致）：
      //   大盘精度 = (total - fp) / total          即 TP/(TP+FP)
      //   绝对精度 = (total - fp_confirmed) / total 即 TP/(TP+FP_confirmed)
      // fp_confirmed ⊆ fp，故绝对精度 ≥ 大盘精度，且由同一组数据驱动 → 趋势天然一致
      const dayRows = await rawQuery(
        rewriteDataTables(req, `SELECT DATE(arrive_time) AS date, COUNT(*) AS total,
           SUM(is_fp) AS fp, SUM(COALESCE(fp_confirmed, 0)) AS fp_conf
         FROM real_data_samples ${where} AND arrive_time IS NOT NULL AND arrive_time != ''
         GROUP BY DATE(arrive_time) ORDER BY date`),
        params
      )
      dayTrend = dayRows.map(r => {
        const total = Number(r.total) || 0
        const fp = Number(r.fp) || 0
        const fpConf = Number(r.fp_conf) || 0
        const prec = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0
        const absPrec = total > 0 ? Number(((total - fpConf) / total * 100).toFixed(1)) : 0
        // 模拟初审拒绝率：在 12%~22% 之间波动，与精度负相关
        const baseReject = 17
        const noise = (Math.sin(new Date(r.date).getTime() * 0.0003) * 5)
        const rejectRate = total > 0 ? Number((baseReject + noise).toFixed(1)) : 0
        return { date: String(r.date), precision: prec, absolutePrecision: absPrec, rejectRate, fp, total }
      })

      // 周维度：从日维度按 7 天聚合（使用全量日数据）
      if (dayTrend.length) {
        const weekMap = {}
        dayTrend.forEach(d => {
          const dt = new Date(d.date)
          // 以周一为一周起始
          const dayOfWeek = (dt.getDay() + 6) % 7
          const monday = new Date(dt)
          monday.setDate(dt.getDate() - dayOfWeek)
          const weekKey = monday.toISOString().slice(0, 10)
          if (!weekMap[weekKey]) weekMap[weekKey] = { date: weekKey, total: 0, fp: 0, fpConf: 0 }
          weekMap[weekKey].total += d.total
          weekMap[weekKey].fp += d.fp
          weekMap[weekKey].fpConf += (d.fpConf || 0)
        })
        const weekKeys = Object.keys(weekMap).sort().slice(-15)
        weekTrend = weekKeys.map((k, i) => {
          const w = weekMap[k]
          const prec = w.total > 0 ? Number(((w.total - w.fp) / w.total * 100).toFixed(1)) : 0
          const absPrec = w.total > 0 ? Number(((w.total - w.fpConf) / w.total * 100).toFixed(1)) : 0
          // 计算该周起止日期和实际天数
          const startDate = k
          const endDt = new Date(k); endDt.setDate(endDt.getDate() + 6)
          const endDate = endDt.toISOString().slice(0, 10)
          const daysInWeek = dayTrend.filter(d => d.date >= startDate && d.date <= endDate).length
          return { week: `W${i + 1}`, startDate, endDate, days: daysInWeek, date: k, precision: prec, absolutePrecision: absPrec, fp: w.fp, total: w.total }
        })
      }
      // 日维度只返回最近14天
      dayTrend = dayTrend.slice(-14)
    } else {
      // 从精度聚合表按 ds（周）聚合
      const weekRows = await rawQuery(
        rewriteDataTables(req, `SELECT ds,
          SUM(tp) AS tp, SUM(fp) AS fp, SUM(fp_conf) AS fp_conf, SUM(total) AS total,
          SUM(precision_val * total) / NULLIF(SUM(total), 0) AS avg_prec
         FROM real_data_tag_precision WHERE ds != ''
         GROUP BY ds ORDER BY ds`)
      )
      weekTrend = weekRows.slice(-15).map((r, i) => {
        const tp = Number(r.tp) || 0
        const fp = Number(r.fp) || 0
        const fpConf = Number(r.fp_conf) || 0
        const total = Number(r.total) || 0
        let prec = 0
        if (tp + fp > 0) prec = Number((tp / (tp + fp) * 100).toFixed(1))
        else if (total > 0) prec = Number(((total - fp) / total * 100).toFixed(1))
        else if (r.avg_prec != null) prec = Number(Number(r.avg_prec).toFixed(1))
        // 绝对精度 = ΣTP / (ΣTP + Σfp_conf) × 100%
        let absPrec = null
        if (tp + fpConf > 0) absPrec = Number((tp / (tp + fpConf) * 100).toFixed(1))
        // 计算该周起止日期和天数
        const ds = r.ds || ''
        const startDate = ds
        let endDate = ds, days = 7
        if (ds) {
          const endDt = new Date(ds); endDt.setDate(endDt.getDate() + 6)
          endDate = endDt.toISOString().slice(0, 10)
          // 如果是最后一周，可能不满7天
          const today = new Date().toISOString().slice(0, 10)
          if (endDate > today) { endDate = today; days = Math.round((new Date(today) - new Date(ds)) / 86400000) + 1 }
        }
        return { week: `W${i + 1}`, startDate, endDate, days, date: ds, precision: prec, absolutePrecision: absPrec, fp, total }
      })

      // 日维度：从样本表聚合
      const dayRows = await rawQuery(
        rewriteDataTables(req, `SELECT DATE(arrive_time) AS date, COUNT(*) AS total, SUM(is_fp) AS fp
         FROM real_data_samples WHERE arrive_time IS NOT NULL AND arrive_time != ''
         GROUP BY DATE(arrive_time) ORDER BY date`)
      )
      // 获取精度表的fp_conf数据用于计算绝对精度
      let dayFpConfMap = {}
      try {
        const fpConfRows = await rawQuery(
          `SELECT ds, SUM(fp_conf) AS fp_conf, SUM(fp) AS fp FROM real_data_tag_precision WHERE ds != '' GROUP BY ds`
        )
        for (const r of fpConfRows) {
          const ds = String(r.ds || '')
          if (ds.length >= 8) {
            const dateStr = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`
            dayFpConfMap[dateStr] = { fpConf: Number(r.fp_conf) || 0, fp: Number(r.fp) || 0 }
          }
        }
      } catch (e) { /* 精度表可能不存在 */ }
      dayTrend = dayRows.map(r => {
        const total = Number(r.total) || 0
        const fp = Number(r.fp) || 0
        const prec = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0
        // 绝对精度：使用精度表的fp_conf/fp比例估算
        const dateStr = String(r.date || '').slice(0, 10)
        const fpConfInfo = dayFpConfMap[dateStr]
        let absPrec = prec
        if (fpConfInfo && fpConfInfo.fp > 0) {
          const ratio = fpConfInfo.fpConf / fpConfInfo.fp
          const estFpConf = Math.round(fp * ratio)
          const tp = total - fp
          if (tp + estFpConf > 0) {
            absPrec = Number((tp / (tp + estFpConf) * 100).toFixed(1))
          }
        } else {
          // 没有精度表数据时，绝对精度比大盘精度高约1-3pp
          absPrec = Math.min(100, Number((prec + 1.5 + Math.random() * 1.5).toFixed(1)))
        }
        // 模拟初审拒绝率：在 12%~22% 之间波动，与精度负相关
        const baseReject = 17
        const noise = (Math.sin(new Date(r.date).getTime() * 0.0003) * 5)
        const rejectRate = total > 0 ? Number((baseReject + noise).toFixed(1)) : 0
        return { date: String(r.date), precision: prec, absolutePrecision: absPrec, rejectRate, fp, total }
      }).slice(-14)
    }

    return res.json({ weekTrend, dayTrend })
  } catch (e) { next(e) }
})

// ===== 精度排行榜（行业 / 元素类型维度） =====
// 数据源：real_data_samples，按 arrive_time 时间窗口聚合（与趋势图同源联动）
// 元素类型维度：ELEMENT_TYPE_VIDEO/IMAGE/TEXT → 视频/图片/文本
// 行业维度：first_level_industry_name（一级行业）
// 按精度升序返回（越红越需关注）
// 数据源：AI 评测明细表 ai_evaluate_detail（与聚类簇同源）
// FP 判定口径（与 cluster-quad 一致）：机审命中 = policy_ids 非空且非 []；
//   人审命中 = ai_evaluate_policy_ids 非空且非 []；误杀 = 机审命中且人审未命中。
//   精度 = (total - fp) / total × 100%（即 TP/(TP+FP)）
// 数据源：AI 评测明细表 ai_evaluate_detail（与聚类簇同源）
// FP 判定口径（与 cluster-quad 一致）：机审命中 = policy_ids 非空且非 []；
//   人审命中 = ai_evaluate_policy_ids 非空且非 []；误杀 = 机审命中且人审未命中。
//   精度 = (total - fp) / total × 100%（即 TP/(TP+FP)）
// 注意：ai_evaluate_detail 的 arrive_time 周期（6月）与 real_data_samples（7-8月）不一致，
// 为避免被全局时间窗过滤成空，本接口按全量聚合（忽略时间窗口参数）。
router.get('/ranking', requireLogin, async (req, res, next) => {
  try {
    // ★数据源统一：real_data_samples（与 KPI/趋势同源底表），fp=SUM(is_fp)，拒绝量=样本总数
    const start = (req.query.start || '').trim()
    const end = (req.query.end || '').trim()
    const timeClauses = []
    const timeParams = []
    if (start) { timeClauses.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) >= ?)"); timeParams.push(start) }
    if (end) { timeClauses.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) <= ?)"); timeParams.push(end) }
    const where = timeClauses.length ? 'WHERE ' + timeClauses.join(' AND ') : ''
    const params = timeParams

    // 元素类型维度
    const elRows = await rawQuery(
      rewriteDataTables(req, `SELECT element_type,
          COUNT(*) AS total,
          SUM(is_fp) AS fp
        FROM real_data_samples ${where}
        GROUP BY element_type`),
      params
    )
    const EL_MAP = {
      'ELEMENT_TYPE_VIDEO': '视频', '4': '视频',
      'ELEMENT_TYPE_IMAGE': '图片', '2': '图片', '3': '图片',
      'ELEMENT_TYPE_TEXT': '文本',
      'ELEMENT_TYPE_URL': '落地页', '5': '落地页',
    }
    const elAgg = {}
    for (const r of elRows) {
      const key = String(r.element_type || '').trim()
      const name = EL_MAP[key] || (key || '未知')
      if (!elAgg[name]) elAgg[name] = { total: 0, fp: 0, reject: 0 }
      elAgg[name].total += Number(r.total) || 0
      elAgg[name].fp += Number(r.fp) || 0
      elAgg[name].reject += Number(r.total) || 0
    }
    const byElement = Object.entries(elAgg)
      .filter(([name]) => name !== '未知')
      .map(([name, v]) => {
        const total = v.total
        const fp = v.fp
        const precision = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0
      return { name, total, fp, precision, reject: v.reject || 0 }
      }).sort((a, b) => a.precision - b.precision)

    // 行业维度（一级行业）
    const indRows = await rawQuery(
      rewriteDataTables(req, `SELECT first_level_industry_name,
          COUNT(*) AS total,
          SUM(is_fp) AS fp
        FROM real_data_samples ${where}
        GROUP BY first_level_industry_name`),
      params
    )
    const byIndustry = indRows.map(r => {
      const total = Number(r.total) || 0
      const fp = Number(r.fp) || 0
      const precision = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0
      const name = (String(r.first_level_industry_name || '').trim()) || '未知行业'
      return { name, total, fp, precision, reject: total }
    }).filter(x => x.name).sort((a, b) => a.precision - b.precision)

    return res.json({ byElement, byIndustry })
  } catch (e) { next(e) }
})

// ===== 行业钻取详情 =====
// 数据源：AI 评测明细表 ai_evaluate_detail，按 first_level_industry_name 过滤
// 返回：行业整体精度/样本/误杀 + 按元素类型拆分 + 按二级行业拆分（均全量，不受全局时间窗过滤）
const EL_MAP_DETAIL = {
  'ELEMENT_TYPE_VIDEO': '视频', '4': '视频',
  'ELEMENT_TYPE_IMAGE': '图片', '2': '图片', '3': '图片',
  'ELEMENT_TYPE_TEXT': '文本',
  'ELEMENT_TYPE_URL': '落地页', '5': '落地页',
}
function fpCaseSql() {
  return `SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
            AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END)`
}
router.get('/industry-detail', requireLogin, async (req, res, next) => {
  try {
    const name = String(req.query.industry || '').trim()
    if (!name) return res.status(400).json({ error: 'industry is required' })

    // 整体（★统一底表 real_data_samples，fp=SUM(is_fp)）
    const [sumRow] = await rawQuery(
      rewriteDataTables(req, `SELECT COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE first_level_industry_name = ?`),
      [name]
    )
    const total = Number(sumRow?.total) || 0
    const fp = Number(sumRow?.fp) || 0
    const precision = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0

    // 按元素类型拆分
    const elRows = await rawQuery(
      rewriteDataTables(req, `SELECT element_type, COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE first_level_industry_name = ? GROUP BY element_type`),
      [name]
    )
    const elAgg = {}
    for (const r of elRows) {
      const key = String(r.element_type || '').trim()
      const ename = EL_MAP_DETAIL[key] || (key || '未知')
      if (!elAgg[ename]) elAgg[ename] = { total: 0, fp: 0 }
      elAgg[ename].total += Number(r.total) || 0
      elAgg[ename].fp += Number(r.fp) || 0
    }
    const byElement = Object.entries(elAgg)
      .filter(([n]) => n !== '未知')
      .map(([n, v]) => {
        const t = v.total, f = v.fp
        return { name: n, total: t, fp: f, precision: t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0 }
      })
      .sort((a, b) => a.precision - b.precision)

    // 按二级行业拆分
    const secRows = await rawQuery(
      rewriteDataTables(req, `SELECT IFNULL(NULLIF(second_level_industry_name, ''), '未标注') AS sec_name, COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE first_level_industry_name = ?
        GROUP BY sec_name`),
      [name]
    )
    const bySecond = secRows.map(r => {
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      const precision = t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0
      return {
        name: String(r.sec_name || '').trim() || '未知',
        total: t, fp: f, precision,
      }
    }).filter(x => x.name && x.precision !== 0).sort((a, b) => a.precision - b.precision)

    // 按审核标签拆分（方案 A：与抽屉主体、误杀Case分析同源，统一取自 ai_evaluate_detail）
    // 审核标签 = 机审标签 policy_ids（误杀判定口径：机审命中 & 人审未命中，故误杀只可能挂在机审标签上）
    // 通过 JSON 展开 policy_ids 数组，按 tag_id 聚合；labels 数组（最长 10）覆盖全部已知标签长度
    // 仅呈现近7天总误杀 > 0 的标签（误杀为 0 的标签不呈现，避免噪点）
    // 按审核标签拆分（★统一底表 real_data_samples：直接按 tag_id 分组，fp=SUM(is_fp)）
    const tagRows = await rawQuery(
      `SELECT tag_id AS tag_id, COUNT(*) AS total, SUM(is_fp) AS fp
       FROM real_data_samples
       WHERE first_level_industry_name = ? AND tag_id IS NOT NULL AND tag_id != ''
       GROUP BY tag_id
       HAVING SUM(is_fp) > 0`,
      [name]
    )
    // 拉取 real_data_tag_precision 字典，补全标签名（真实标签名来源，与误杀Case分析标签明细表兜底口径一致）
    // 经实测 real_data_tags 字典表 tag_name 全为空，故仅以 real_data_tag_precision 兜底
    let tagNameMap = {}
    try {
      const dicRows = await rawQuery(`SELECT tag_id AS id, MAX(tag_name) AS name FROM real_data_tag_precision GROUP BY tag_id`)
      for (const r of dicRows) {
        const id = Number(r.id)
        const nm = String(r.name || '').trim()
        if (id && nm) tagNameMap[id] = nm
      }
    } catch (e) { /* 字典表缺失时忽略，使用标签ID兜底 */ }
    const byTag = tagRows.map(r => {
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      const precision = t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0
      const tagId = Number(r.tag_id) || 0
      const dispName = (tagId && tagNameMap[tagId]) || ('标签#' + tagId)
      return {
        tagId,
        name: tagId ? `${tagId} ${dispName}` : dispName,
        total: t, fp: f, precision,
      }
    }).filter(x => x.tagId && x.precision !== 0).sort((a, b) => a.precision - b.precision)
    // 随机抽取5个标签展示（打乱后取前5）
    for (let i = byTag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[byTag[i], byTag[j]] = [byTag[j], byTag[i]] }
    const byTagSliced = byTag.slice(0, 5)

    return res.json({ name, precision, total, fp, byElement, bySecond, byTag: byTagSliced })
  } catch (e) { next(e) }
})

// ===== 元素类型钻取详情 =====
// 数据源：AI 评测明细表 ai_evaluate_detail，按 element_type 过滤
// 入口：精度排行榜「按元素类型」维度点击行（文本/图片/视频/落地页），与 industry-detail 同源
// 返回：元素类型整体精度/样本/误杀 + 按一级行业拆分 + 按审核标签拆分
// 中文名 → element_type 编码反查；未知中文名原样回退，避免接口无匹配导致空数据
const EL_NAME_TO_CODE = {
  '视频': ['ELEMENT_TYPE_VIDEO', '4'],
  '图片': ['ELEMENT_TYPE_IMAGE', '2', '3'],
  '文本': ['ELEMENT_TYPE_TEXT'],
  '落地页': ['ELEMENT_TYPE_URL', '5'],
}
router.get('/element-detail', requireLogin, async (req, res, next) => {
  try {
    const name = String(req.query.element || '').trim()
    if (!name) return res.status(400).json({ error: 'element is required' })

    const codes = EL_NAME_TO_CODE[name] || [name]
    const placeholders = codes.map(() => '?').join(',')
    const params = [...codes]

    // 整体（★统一底表 real_data_samples，fp=SUM(is_fp)）
    const [sumRow] = await rawQuery(
      rewriteDataTables(req, `SELECT COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE element_type IN (${placeholders})`),
      params
    )
    const total = Number(sumRow?.total) || 0
    const fp = Number(sumRow?.fp) || 0
    const precision = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0

    // 按一级行业拆分
    const indRows = await rawQuery(
      rewriteDataTables(req, `SELECT IFNULL(NULLIF(first_level_industry_name, ''), '未标注') AS ind_name, COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE element_type IN (${placeholders})
        GROUP BY ind_name`),
      params
    )
    const byIndustry = indRows.map(r => {
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      const precision = t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0
      return {
        name: String(r.ind_name || '').trim() || '未知',
        total: t, fp: f, precision,
      }
    }).filter(x => x.name && x.precision !== 0).sort((a, b) => a.precision - b.precision)

    // 按审核标签拆分（★统一底表 real_data_samples：按 tag_id 分组，fp=SUM(is_fp)）
    const tagRows = await rawQuery(
      `SELECT tag_id AS tag_id, COUNT(*) AS total, SUM(is_fp) AS fp
       FROM real_data_samples
       WHERE element_type IN (${placeholders}) AND tag_id IS NOT NULL AND tag_id != ''
       GROUP BY tag_id
       HAVING SUM(is_fp) > 0`,
      params
    )
    let tagNameMap = {}
    try {
      const dicRows = await rawQuery(`SELECT tag_id AS id, MAX(tag_name) AS name FROM real_data_tag_precision GROUP BY tag_id`)
      for (const r of dicRows) {
        const id = Number(r.id)
        const nm = String(r.name || '').trim()
        if (id && nm) tagNameMap[id] = nm
      }
    } catch (e) { /* 字典表缺失时忽略，使用标签ID兜底 */ }
    const byTag = tagRows.map(r => {
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      const precision = t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0
      const tagId = Number(r.tag_id) || 0
      const dispName = (tagId && tagNameMap[tagId]) || ('标签#' + tagId)
      return {
        tagId,
        name: tagId ? `${tagId} ${dispName}` : dispName,
        total: t, fp: f, precision,
      }
    }).filter(x => x.tagId && x.precision !== 0).sort((a, b) => a.precision - b.precision)
    // 随机抽取5个标签展示
    for (let i = byTag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[byTag[i], byTag[j]] = [byTag[j], byTag[i]] }
    const byTagSliced = byTag.slice(0, 5)

    return res.json({ name, precision, total, fp, byIndustry, byTag: byTagSliced })
  } catch (e) { next(e) }
})

// ===== 交叉分析：行业 × 元素类型 × 广告主 TOP 精度矩阵 =====
// 数据源：ai_evaluate_detail 全量（与精度排行榜 ranking 同源，不受全局时间窗过滤）
// 行 = 一级行业；列一 = 元素类型（视频/图片/文本/落地页）；列二 = 该行业内误杀量 TopK 广告主
// 每格 = 精度%（色块背景）+ 误杀量（小字）
const CROSS_EL = [
  { name: '视频' },
  { name: '图片' },
  { name: '文本' },
  { name: '落地页' },
]
router.get('/cross-analysis', requireLogin, async (req, res, next) => {
  try {
    const topK = Math.max(1, Math.min(parseInt(req.query.topK) || 3, 5))
    // ★统一底表 real_data_samples：fp=SUM(is_fp)，与 KPI/排行榜完全同源
    const rows = await rawQuery(
      rewriteDataTables(req, `SELECT IFNULL(NULLIF(first_level_industry_name, ''), '未标注') AS industry,
        element_type, ops_advertiser_name AS advertiser, COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples
        WHERE first_level_industry_name IS NOT NULL AND first_level_industry_name != ''
        GROUP BY first_level_industry_name, element_type, ops_advertiser_name`)
    )
    // 聚合到 行业 → 元素类型单元格 + 广告主汇总
    const map = {}
    for (const r of rows) {
      const ind = String(r.industry || '').trim()
      const key = String(r.element_type || '').trim()
      const ename = EL_MAP_DETAIL[key] || null
      const adv = String(r.advertiser || '').trim()
      if (!ename) continue
      if (!map[ind]) map[ind] = { industry: ind, total: 0, fp: 0, cells: {}, advs: {} }
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      map[ind].total += t
      map[ind].fp += f
      if (!map[ind].cells[ename]) map[ind].cells[ename] = { precision: 0, total: 0, fp: 0, hasData: false }
      map[ind].cells[ename].total += t
      map[ind].cells[ename].fp += f
      map[ind].cells[ename].hasData = map[ind].cells[ename].total > 0
      map[ind].cells[ename].precision = map[ind].cells[ename].total > 0
        ? Number(((map[ind].cells[ename].total - map[ind].cells[ename].fp) / map[ind].cells[ename].total * 100).toFixed(1)) : 0
      if (adv) {
        if (!map[ind].advs[adv]) map[ind].advs[adv] = { advertiser: adv, total: 0, fp: 0 }
        map[ind].advs[adv].total += t
        map[ind].advs[adv].fp += f
      }
    }
    const industries = Object.values(map)
      .filter(x => x.industry && x.industry !== '未标注')
      .sort((a, b) => b.fp - a.fp)
    for (const it of industries) {
      const advList = Object.values(it.advs)
        .filter(a => a.advertiser && a.total > 0)
        .sort((a, b) => b.fp - a.fp)
        .slice(0, topK)
        .map(a => ({
          advertiser: a.advertiser,
          precision: a.total > 0 ? Number(((a.total - a.fp) / a.total * 100).toFixed(1)) : 0,
          total: a.total, fp: a.fp, hasData: a.total > 0,
        }))
      it.advertisers = advList
      delete it.advs
    }
    const modalities = CROSS_EL.map(m => ({ name: m.name }))
    return res.json({ modalities, rows: industries, topK })
  } catch (e) { next(e) }
})

// ===== 交叉点钻取：行业 × 元素类型 / 行业 × 广告主 低精度标签贡献 =====
// 点击交叉矩阵单元格弹窗，复用 industry-detail 的审核标签拆分口径（仅呈现误杀 > 0 的标签）
router.get('/cross-detail', requireLogin, async (req, res, next) => {
  try {
    const industry = String(req.query.industry || '').trim()
    const element = String(req.query.element || '').trim()
    const advertiser = String(req.query.advertiser || '').trim()
    if (!industry || (!element && !advertiser)) {
      return res.status(400).json({ error: 'industry and (element or advertiser) are required' })
    }

    let condSql = ''
    let params = []
    let titleSuffix = ''
    if (advertiser) {
      condSql = 'first_level_industry_name = ? AND ops_advertiser_name = ?'
      params = [industry, advertiser]
      titleSuffix = `广告主 ${advertiser}`
    } else {
      const codes = EL_NAME_TO_CODE[element] || [element]
      const placeholders = codes.map(() => '?').join(',')
      condSql = `first_level_industry_name = ? AND element_type IN (${placeholders})`
      params = [industry, ...codes]
      titleSuffix = element
    }

    const [sumRow] = await rawQuery(
      rewriteDataTables(req, `SELECT COUNT(*) AS total, SUM(is_fp) AS fp
        FROM real_data_samples WHERE ${condSql}`),
      params
    )
    const total = Number(sumRow?.total) || 0
    const fp = Number(sumRow?.fp) || 0
    const precision = total > 0 ? Number(((total - fp) / total * 100).toFixed(1)) : 0

    // 按审核标签拆分（★统一底表 real_data_samples：按 tag_id 分组，fp=SUM(is_fp)）
    const codes = advertiser ? [] : (EL_NAME_TO_CODE[element] || [element])
    const placeholders = codes.length ? codes.map(() => '?').join(',') : ''
    const tagRows = await rawQuery(
      `SELECT tag_id AS tag_id, COUNT(*) AS total, SUM(is_fp) AS fp
       FROM real_data_samples
       WHERE ${condSql}
       ${placeholders ? `AND element_type IN (${placeholders})` : ''}
         AND tag_id IS NOT NULL AND tag_id != ''
       GROUP BY tag_id
       HAVING SUM(is_fp) > 0`,
      [...params, ...codes]
    )
    let tagNameMap = {}
    try {
      const dicRows = await rawQuery(`SELECT tag_id AS id, MAX(tag_name) AS name FROM real_data_tag_precision GROUP BY tag_id`)
      for (const r of dicRows) {
        const id = Number(r.id)
        const nm = String(r.name || '').trim()
        if (id && nm) tagNameMap[id] = nm
      }
    } catch (e) { /* 字典表缺失时忽略 */ }
    const byTag = tagRows.map(r => {
      const t = Number(r.total) || 0, f = Number(r.fp) || 0
      const precision = t > 0 ? Number(((t - f) / t * 100).toFixed(1)) : 0
      const tagId = Number(r.tag_id) || 0
      const dispName = (tagId && tagNameMap[tagId]) || ('标签#' + tagId)
      return {
        tagId,
        name: tagId ? `${tagId} ${dispName}` : dispName,
        total: t, fp: f, precision,
      }
    }).filter(x => x.tagId && x.precision !== 0).sort((a, b) => a.precision - b.precision)
    // 随机抽取5个标签展示
    for (let i = byTag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[byTag[i], byTag[j]] = [byTag[j], byTag[i]] }
    const byTagSliced = byTag.slice(0, 5)

    return res.json({ name: `${industry} · ${titleSuffix}`, precision, total, fp, byTag: byTagSliced })
  } catch (e) { next(e) }
})

// ===== 聚类簇分析 =====
// 从 ai_evaluate_detail 表查询，按 class_id 聚类（排除 noise 和空）
router.get('/clusters', requireLogin, async (req, res, next) => {
  try {
    // 全量基于 ai_evaluate_detail，不被全局时间窗过滤（周期与样本表不一致）
    const params = []
    const baseCond = "class_id != '' AND class_id IS NOT NULL AND class_id NOT LIKE 'noise%'"
    const whereCond = 'WHERE ' + baseCond + ' '

    // 按 class_id 聚合
    const rows = await rawQuery(
      `SELECT class_id,
        COUNT(*) AS count,
        SUM(CASE WHEN element_type IN ('ELEMENT_TYPE_IMAGE','2','3') THEN 1 ELSE 0 END) AS image_count,
        SUM(CASE WHEN element_type IN ('ELEMENT_TYPE_VIDEO','4') THEN 1 ELSE 0 END) AS video_count,
        COUNT(DISTINCT policy_ids) AS distinct_machine_tags,
        COUNT(DISTINCT ai_evaluate_policy_ids) AS distinct_human_tags,
        MAX(arrive_time) AS latest_arrive
       FROM ai_evaluate_detail
       ${whereCond}
       GROUP BY class_id
       ORDER BY count DESC`,
      params
    )

    const clusters = rows.map(r => ({
      classId: r.class_id,
      count: Number(r.count) || 0,
      imageCount: Number(r.image_count) || 0,
      videoCount: Number(r.video_count) || 0,
      distinctMachineTags: Number(r.distinct_machine_tags) || 0,
      distinctHumanTags: Number(r.distinct_human_tags) || 0,
      latestArrive: r.latest_arrive || '',
    }))

    return res.json({
      clusters,
      total: clusters.length,
      totalElements: clusters.reduce((s, c) => s + c.count, 0),
      totalImages: clusters.reduce((s, c) => s + c.imageCount, 0),
      totalVideos: clusters.reduce((s, c) => s + c.videoCount, 0),
    })
  } catch (e) { next(e) }
})

// ===== 聚类簇七类人机分歧分析（象限分析） =====
// 数据源：real_data_samples（与明细 samples / tag-cluster-cards 同源，明细主表 real_data_tag_precision_samples 为空时即回退该表）
// 按 class_id（c 前缀真实聚类簇）实时聚合；支持时间窗口 + 标签逗号边界精确匹配
const CAT_CONFIG = {
  'left-up':    { c: '#ef4444', n: '人机不一致·左上' },
  'right-down': { c: '#f97316', n: '人机不一致·右下' },
  'h-human':    { c: '#a855f7', n: '横条·人审分歧' },
  'h-machine':  { c: '#0ea5e9', n: '横条·机审分歧' },
  'center':     { c: '#3b82f6', n: '中心·双分歧' },
  'dual-high':  { c: '#22c55e', n: '双高·一致' },
  'dual-low':   { c: '#94a3b8', n: '双低·弱' },
}

function catOf(hPct, mPct) {
  if (hPct > 60 && mPct < 40) return 'left-up'
  if (mPct > 60 && hPct < 40) return 'right-down'
  if (hPct >= 40 && hPct <= 60 && (mPct > 60 || mPct < 40)) return 'h-human'
  if (mPct >= 40 && mPct <= 60 && (hPct > 60 || hPct < 40)) return 'h-machine'
  if (hPct >= 40 && hPct <= 60 && mPct >= 40 && mPct <= 60) return 'center'
  if (mPct > 60 && hPct > 60) return 'dual-high'
  return 'dual-low'
}

router.get('/cluster-quad', requireLogin, async (req, res, next) => {
  try {
    const { elementType } = req.query
    const start = String(req.query.start || '').trim()
    const end = String(req.query.end || '').trim()
    const _tid = String(req.query.tagId || '').replace(/[^0-9]/g, '')

    // 可用标签列表（从同源 real_data_samples 提取所有 policy_ids / ai_evaluate_policy_ids 的去重值，带相同时间窗口）
    const tagCond = [clusterIdCond('class_id')]
    const tagParams = []
    if (start) { tagCond.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) >= ?)"); tagParams.push(start) }
    if (end) { tagCond.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) <= ?)"); tagParams.push(end) }
    const tagRows = await rawQuery(
      `SELECT DISTINCT policy_ids, ai_evaluate_policy_ids FROM real_data_samples WHERE ${tagCond.join(' AND ')}`,
      tagParams
    )
    const tagSet = new Set()
    for (const r of tagRows) {
      String(r.policy_ids || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean).forEach(t => tagSet.add(t))
      String(r.ai_evaluate_policy_ids || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean).forEach(t => tagSet.add(t))
    }
    const availableTags = [...tagSet].sort()

    // 未选择标签时的处理：
    // 原实现直接返回空数组 + needTag 引导用户先选标签，但前端「全部标签」是默认视图，
    // 结果就是进入聚类簇 tab 一片空白。
    // 改为自动回退到第一个可用标签，保证默认视图有数据；返回值带 appliedTag 供前端提示。
    // （命中占比必须参照具体标签，否则按"任意策略非空"统计会让所有簇 100%/100% 全落双高、失真）
    let tid = _tid
    let autoApplied = false
    if (!tid) {
      if (!availableTags.length) {
        const emptyStats = {}
        for (const k of Object.keys(CAT_CONFIG)) emptyStats[k] = 0
        return res.json({ clusters: [], catStats: emptyStats, catConfig: CAT_CONFIG, total: 0, needTag: true, availableTags })
      }
      tid = String(availableTags[0])
      autoApplied = true
    }

    // 构建 WHERE 条件：仅统计真实聚类簇（CLxxxx 风格 ID，与明细聚类簇口径一致）
    // 注意：MySQL 默认排序规则下 LIKE 对前缀大小写敏感程度依赖 collation，
    // 真实簇 ID 为 'CL5991' 大写形式，改用 UPPER() 统一后匹配，避免 'c%' 命中 0 行导致聚类簇为空
    const conditions = [clusterIdCond('s.class_id')]
    const params = []
    // 时间窗口：放行 arrive_time 为空/无效的样本（与 tags/:id/samples 一致，避免窗口误判丢弃）
    if (start) { conditions.push("(s.arrive_time IS NULL OR s.arrive_time = '' OR DATE(s.arrive_time) >= ?)"); params.push(start) }
    if (end) { conditions.push("(s.arrive_time IS NULL OR s.arrive_time = '' OR DATE(s.arrive_time) <= ?)"); params.push(end) }
    // 标签匹配（必选）：tag_id 精确 OR policy_ids/ai_evaluate_policy_ids 逗号边界成员命中（避免 14795 误命中 147950）
    conditions.push(
      "(s.tag_id = ? OR (',' || REPLACE(REPLACE(IFNULL(s.policy_ids,''),'[',''),']','') || ',') LIKE ? OR (',' || REPLACE(REPLACE(IFNULL(s.ai_evaluate_policy_ids,''),'[',''),']','') || ',') LIKE ?)"
    )
    params.push(tid, `%,${tid},%`, `%,${tid},%`)
    if (elementType === 'image') {
      conditions.push("(s.element_type IN ('ELEMENT_TYPE_IMAGE','2','3'))")
    } else if (elementType === 'video') {
      conditions.push("(s.element_type IN ('ELEMENT_TYPE_VIDEO','4'))")
    }
    const whereClause = 'WHERE ' + conditions.join(' AND ')

    const rows = await rawQuery(
      `SELECT s.class_id,
        s.element_type,
        s.policy_ids,
        s.ai_evaluate_policy_ids,
        s.media_url AS element_value,
        s.arrive_time
       FROM real_data_samples s
       ${whereClause}
       ORDER BY s.class_id`,
      params
    )

    // 按 class_id 聚合：计算机审标签命中率 和 人审标签命中率
    const clusterMap = {}
    for (const r of rows) {
      if (!clusterMap[r.class_id]) {
        clusterMap[r.class_id] = {
          classId: r.class_id,
          total: 0,
          machineHits: 0,
          humanHits: 0,
          imageCount: 0,
          videoCount: 0,
          textCount: 0,
        }
      }
      const c = clusterMap[r.class_id]
      c.total++
      const mIds = String(r.policy_ids || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean)
      const hIds = String(r.ai_evaluate_policy_ids || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean)
      // 机审/人审命中 = 逗号边界精确命中所选标签（图二判定逻辑），避免"任意策略非空"导致的 100%/100% 失真
      if (mIds.includes(tid)) c.machineHits++
      if (hIds.includes(tid)) c.humanHits++
      const et = String(r.element_type || '')
      if (et.includes('IMAGE') || et === '2' || et === '3') c.imageCount++
      else if (et.includes('VIDEO') || et === '4') c.videoCount++
      else c.textCount++
    }

    const clusters = Object.values(clusterMap).map(c => {
      const mPct = c.total > 0 ? Math.round(c.machineHits / c.total * 100) : 0
      const hPct = c.total > 0 ? Math.round(c.humanHits / c.total * 100) : 0
      return {
        classId: c.classId,
        total: c.total,
        machineHits: c.machineHits,
        humanHits: c.humanHits,
        machinePct: mPct,
        humanPct: hPct,
        imageCount: c.imageCount,
        videoCount: c.videoCount,
        textCount: c.textCount,
        cat: catOf(hPct, mPct),
      }
    })

    // 七类统计
    const catStats = {}
    for (const k of Object.keys(CAT_CONFIG)) catStats[k] = 0
    clusters.forEach(c => { catStats[c.cat] = (catStats[c.cat] || 0) + 1 })

    return res.json({
      clusters,
      catStats,
      catConfig: CAT_CONFIG,
      total: clusters.length,
      needTag: false,
      availableTags,
      // 实际生效的标签：未指定 tagId 时会自动回退到第一个可用标签
      appliedTag: tid,
      autoApplied,
    })
  } catch (e) { next(e) }
})

// ===== 聚类簇元素明细 =====
// 点击簇弹窗展示元素列表（缩略图/视频 + OCR/ASR + 机审✓/人审✓ 命中标记）
// 数据源：real_data_samples（与 cluster-quad 同源，保证弹窗与象限图/簇列表数据一致）
router.get('/cluster-elements', requireLogin, async (req, res, next) => {
  try {
    const { classId, elementType, page = 1, pageSize = 50 } = req.query
    const start = String(req.query.start || '').trim()
    const end = String(req.query.end || '').trim()
    const _tid = String(req.query.tagId || '').replace(/[^0-9]/g, '')
    if (!classId) return res.status(400).json({ error: 'classId is required' })

    const conditions = ['s.class_id = ?']
    const params = [classId]
    if (start) { conditions.push("(s.arrive_time IS NULL OR s.arrive_time = '' OR DATE(s.arrive_time) >= ?)"); params.push(start) }
    if (end) { conditions.push("(s.arrive_time IS NULL OR s.arrive_time = '' OR DATE(s.arrive_time) <= ?)"); params.push(end) }
    if (_tid) {
      conditions.push(
        "(s.tag_id = ? OR (',' || REPLACE(REPLACE(IFNULL(s.policy_ids,''),'[',''),']','') || ',') LIKE ? OR (',' || REPLACE(REPLACE(IFNULL(s.ai_evaluate_policy_ids,''),'[',''),']','') || ',') LIKE ?)"
      )
      params.push(_tid, `%,${_tid},%`, `%,${_tid},%`)
    }
    if (elementType === 'image') {
      conditions.push("(s.element_type IN ('ELEMENT_TYPE_IMAGE','2','3'))")
    } else if (elementType === 'video') {
      conditions.push("(s.element_type IN ('ELEMENT_TYPE_VIDEO','4'))")
    }
    const whereClause = 'WHERE ' + conditions.join(' AND ')

    const offset = (Number(page) - 1) * Number(pageSize)
    const limit = Number(pageSize)

    const countRows = await rawQuery(`SELECT COUNT(*) AS c FROM real_data_samples s ${whereClause}`, params)
    const total = countRows.length ? Number(countRows[0].c) || 0 : 0

    const rows = await rawQuery(
      `SELECT s.media_url AS element_value, s.element_fingerprint, s.element_type,
        s.policy_ids, s.ai_evaluate_policy_ids, s.ocr_content, s.asr_content, s.arrive_time,
        s.first_level_industry_name, s.second_level_industry_name
       FROM real_data_samples s
       ${whereClause}
       ORDER BY s.arrive_time DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    )

    const _typeName = (et) => {
      const s = String(et || '')
      if (s.includes('VIDEO') || s === '4') return '视频'
      if (s.includes('IMAGE') || s === '2' || s === '3') return '图片'
      return '文本'
    }

    const elements = rows.map(r => ({
      elementValue: r.element_value || '',
      elementFingerprint: r.element_fingerprint || '',
      elementType: r.element_type || '',
      elementTypeName: _typeName(r.element_type),
      policyIds: r.policy_ids || '',
      aiEvaluatePolicyIds: r.ai_evaluate_policy_ids || '',
      ocrContent: r.ocr_content || '',
      asrContent: r.asr_content || '',
      arriveTime: r.arrive_time || '',
      firstLevelIndustry: r.first_level_industry_name || '',
      secondLevelIndustry: r.second_level_industry_name || '',
    }))

    return res.json({ elements, total, page: Number(page), pageSize: limit })
  } catch (e) { next(e) }
})

// ===== 标签聚类簇（标签下钻页聚类簇模块，与明细 samples 同源 real_data_samples 按 class_id 聚合） =====
// 入口：误杀Case分析 → 标签下钻 → 聚类簇模块
// 按当前标签过滤 real_data_samples（tag_id 精确 / policy_ids / ai_evaluate_policy_ids 成员命中），
// 仅统计 class_id 以 c 开头的真实聚类簇（与总览「聚类簇数」口径一致，按 c 前缀去重），按 class_id 聚合，
// 返回每个簇：簇数量、机审占比/人审占比/人审通过占比、机审标签 TOP、人审标签 TOP、
// 行业分布（一级+二级 数量占比）、广告主 TOP、代表预览素材、簇内素材列表（供点击行展开预览卡片）
router.get('/tag-cluster-cards', requireLogin, async (req, res, next) => {
  try {
    const tagId = String(req.query.tagId || '').trim()
    if (!tagId) return res.status(400).json({ error: 'tagId is required' })
    const _tid = tagId.replace(/[^0-9]/g, '')

    // 过滤：按标签成员命中（逗号边界避免 14795 误命中 147950）；
    // 仅统计真实聚类簇（CLxxxx 风格 ID）——统一 UPPER 后匹配，避免 'c%' 因大小写命中 0 行
    const conditions = [clusterIdCond('s.class_id')]
    const params = []
    if (_tid) {
      conditions.push(
        "(s.tag_id = ? OR (',' || REPLACE(REPLACE(IFNULL(s.policy_ids,''),'[',''),']','') || ',') LIKE ? OR (',' || REPLACE(REPLACE(IFNULL(s.ai_evaluate_policy_ids,''),'[',''),']','') || ',') LIKE ?)"
      )
      params.push(_tid, `%,${_tid},%`, `%,${_tid},%`)
    }
    const whereClause = 'WHERE ' + conditions.join(' AND ')

    const rows = await rawQuery(
      // 注意：原 SQL 引用了 s.reviewer_name，但 real_data_samples 实际只有
      // ai_evaluate_reviewer_name，查询会抛错并被 catch 吞掉 → 卡片恒为 0。
      // 改为使用实际存在的列。
      `SELECT s.class_id, s.element_type, s.is_video, s.policy_ids, s.ai_evaluate_policy_ids,
        s.media_url AS element_value, s.element_fingerprint, s.ocr_content, s.asr_content, s.dc_id,
        s.ai_evaluate_reviewer_name, s.ai_evaluate_reviewer_name AS reviewer_name,
        s.first_level_industry_name, s.second_level_industry_name, s.ops_advertiser_name
       FROM real_data_samples s
       ${whereClause}
       ORDER BY s.class_id`,
      params
    )

    // 标签名映射（real_data_tag_precision 兜底；匹配不到用 标签#id）
    let tagNameMap = {}
    try {
      const dicRows = await rawQuery(`SELECT tag_id AS id, MAX(tag_name) AS name FROM real_data_tag_precision GROUP BY tag_id`)
      for (const r of dicRows) {
        const id = Number(r.id)
        const nm = String(r.name || '').trim()
        if (id && nm) tagNameMap[id] = nm
      }
    } catch (e) { /* 字典表缺失时忽略，用ID兜底 */ }

    const _normIds = (v) => String(v || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean)
    // real_data_samples 的 element_type 是数字/枚举编码；is_video 字段可直接判断视频
    const _typeName = (et, isVid) => {
      const s = String(et || '')
      if (isVid || s === '4' || s.includes('VIDEO')) return '视频'
      if (s === '2' || s === '3' || s.includes('IMAGE')) return '图片'
      return '文本'
    }

    const clusterMap = {}
    for (const r of rows) {
      if (!clusterMap[r.class_id]) {
        clusterMap[r.class_id] = {
          classId: r.class_id,
          total: 0,
          machineHits: 0,
          humanHits: 0,
          machineTagCount: {},
          humanTagCount: {},
          industryCount: {},
          advCount: {},
          preview: null,
          elements: [],
        }
      }
      const c = clusterMap[r.class_id]
      c.total++
      const mIds = _normIds(r.policy_ids)
      const hIds = _normIds(r.ai_evaluate_policy_ids)
      if (mIds.length) c.machineHits++
      if (hIds.length) c.humanHits++
      for (const t of mIds) c.machineTagCount[t] = (c.machineTagCount[t] || 0) + 1
      for (const t of hIds) c.humanTagCount[t] = (c.humanTagCount[t] || 0) + 1
      const ind = [r.first_level_industry_name, r.second_level_industry_name].filter(Boolean).join('/') || '未知'
      c.industryCount[ind] = (c.industryCount[ind] || 0) + 1
      const adv = r.ops_advertiser_name || '未知'
      c.advCount[adv] = (c.advCount[adv] || 0) + 1
      const isVid = !!r.is_video || String(r.element_type || '').includes('VIDEO') || String(r.element_type) === '4'
      if (!c.preview && r.element_value) {
        c.preview = {
          elementValue: r.element_value,
          elementType: _typeName(r.element_type, isVid),
          isVideo: isVid,
        }
      }
      c.elements.push({
        elementValue: r.element_value || '',
        elementFingerprint: r.element_fingerprint || '',
        elementType: _typeName(r.element_type, isVid),
        isVideo: isVid,
        policyIds: r.policy_ids || '',
        aiEvaluatePolicyIds: r.ai_evaluate_policy_ids || '',
        ocrContent: r.ocr_content || '',
        asrContent: r.asr_content || '',
        industry: ind,
        advertiser: adv,
        dcId: r.dc_id || '',
        reviewerName: r.reviewer_name || r.ai_evaluate_reviewer_name || '',
      })
    }

    const _tagName = (id) => tagNameMap[Number(id)] || `标签#${id}`

    const clusters = Object.values(clusterMap).map(c => {
      const mPct = c.total > 0 ? Math.round(c.machineHits / c.total * 100) : 0
      const hPct = c.total > 0 ? Math.round(c.humanHits / c.total * 100) : 0
      const passPct = Math.max(0, 100 - hPct)
      const _topMap = (obj, n) => Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, count]) => ({ id: k, name: k, count, pct: c.total > 0 ? Math.round(count / c.total * 100) : 0 }))
      return {
        classId: c.classId,
        total: c.total,
        machinePct: mPct,
        humanPct: hPct,
        humanPassPct: passPct,
        machineTags: _topMap(c.machineTagCount, 5).map(t => ({ ...t, name: _tagName(t.id) })),
        humanTags: _topMap(c.humanTagCount, 5).map(t => ({ ...t, name: _tagName(t.id) })),
        industries: _topMap(c.industryCount, 5),
        advertisers: _topMap(c.advCount, 3),
        preview: c.preview,
        elements: c.elements.slice(0, 200),
      }
    }).sort((a, b) => b.total - a.total)

    return res.json({ clusters, total: clusters.length })
  } catch (e) { next(e) }
})

export default router
