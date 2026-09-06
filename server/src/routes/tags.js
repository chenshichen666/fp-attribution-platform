import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'
import { rewriteDataTables } from '../middleware/dataMode.js'
import { resolveSampleTag } from '../utils/resolveSampleTag.js'
import ExcelJS from 'exceljs'

const router = Router()

// ★ 统一解析标签 ID：入口可能传 real_data_tags.id（871+），样本/精度表用的是 tag_id（1001+）
async function sampleTagIdOf(rawId) {
  const st = await resolveSampleTag(rawId)
  return st ? st.sampleTagId : rawId
}

// ★性能优化 T6.3: overview 进程内缓存
// key = 数据版本号（取 data_meta 中 data_updated_at 的最大值），TTL=5分钟
const overviewCache = new Map()
const OVERVIEW_CACHE_TTL = 5 * 60 * 1000

// 标签列表（误杀样本分析）—— 从 real_data_tag_precision 表读取
// 标签 ID → 中文名 字典（来自 real_data_tags，匹配不到则用 ID 兜底）
async function nameMap() {
  const rows = await query(rewriteDataTables({ query: {} }, 'SELECT tag_id AS id, tag_name AS name FROM real_data_tags'))
  const m = {}
  for (const r of rows) m[r.id] = r.name
  return m
}

// 解析 policy_ids / ai_evaluate_policy_ids 字符串为升序数字数组
function parseIds(s) {
  return String(s).replace(/[[\]\s]/g, '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b)
}

// 整行标签一致性判定：机审标签ID中只要有一个出现在人审标签集合里就算一致
function rowConsistent(mIds, hIds) {
  if (!mIds.length || !hIds.length) return false
  return mIds.some(id => hIds.includes(id))
}

// 构建 WHERE 子句：按 arrive_time 时间周期过滤
// ⚠️ 注意：此函数用于 real_data_tag_precision（精度聚合表）查询。
// 精度表的 arrive_time 存的是"数据上传当天日期"，不是真实业务日期，
// 与 real_data_samples（样本表）的 arrive_time（真实业务到达日期）语义不同。
// 因此对精度表做时间过滤会错误排除标签（如业务日 7-12~7-18 会把上传日 7-20 的精度数据全过滤掉）。
// 精度表是全量聚合数据，按 tag_id 查询即可，时间窗口只在样本明细查询（useSampleAggregation 命中时）起作用。
function timeWhere(req) {
  return { where: '', params: [] }
}

// real_data_samples 表的 arrive_time 是 varchar，用 DATE() 规范化比较；
// 放行 arrive_time 为空/无效的样本——部分样本无到达时间，窗口下不应被误判为「窗口外」丢弃
function sampleTimeWhere(req) {
  const start = (req.query.start || '').trim()
  const end = (req.query.end || '').trim()
  const clauses = []
  const params = []
  if (start) { clauses.push('(arrive_time IS NULL OR arrive_time = \'\' OR DATE(arrive_time) >= ?)'); params.push(start) }
  if (end) { clauses.push('(arrive_time IS NULL OR arrive_time = \'\' OR DATE(arrive_time) <= ?)'); params.push(end) }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params }
}

// 样本表真实业务日期范围（缓存 5 分钟），用于判断「时间窗口是否覆盖全量」
let _sampleRangeCache = { t: 0, min: null, max: null }
async function getSampleRange() {
  if (Date.now() - _sampleRangeCache.t < 5 * 60 * 1000 && _sampleRangeCache.min) return _sampleRangeCache
  const rows = await query(`SELECT DATE(MIN(arrive_time)) AS min_d, DATE(MAX(arrive_time)) AS max_d FROM real_data_samples WHERE arrive_time IS NOT NULL AND arrive_time != ''`)
  const r = rows[0] || {}
  _sampleRangeCache = { t: Date.now(), min: r.min_d ? String(r.min_d) : null, max: r.max_d ? String(r.max_d) : null }
  return _sampleRangeCache
}

// 是否启用「明细实时聚合」（方案 A：时间窗口联动）
// - 无窗口（默认/全部时间）→ false：沿用精度聚合表（205 标签全量快照，保底）
// - 窗口覆盖数据全量范围 → 视为「全部时间」→ false：仍用精度聚合表，避免「205 ↔ 88 子集」的跳变
// - 窗口为全量范围内的子集 → true：从 real_data_samples 按 arrive_time 实时重算
//   标签精度 = (总样本 − FP) / 总样本 × 100，FP = SUM(is_fp)，
//   整体样本数 / FP 数 / 查准率随之联动变化
async function useSampleAggregation(req) {
  const start = (req.query.start || '').trim()
  const end = (req.query.end || '').trim()
  if (!start && !end) return false
  const range = await getSampleRange()
  if (!range.min || !range.max) return false
  const s = start || range.min
  const e = end || range.max
  // 覆盖（含超出）全量数据范围，等价于「全部时间」
  if (s <= range.min && e >= range.max) return false
  return true
}

// ===== 异常标签判定（tag + element_type 维度） =====
// 判定口径：某个标签下任一元素类型满足 精度≤60% AND FP≥100，则该标签整体为异常
// 数据来源：real_data_samples 按 tag_id + element_type 聚合
// 返回 Set<number>，包含所有异常标签的 tag_id
let _abnormalCache = { t: 0, set: null }
const ABNORMAL_CACHE_TTL = 5 * 60 * 1000
async function getAbnormalTagIds() {
  if (Date.now() - _abnormalCache.t < ABNORMAL_CACHE_TTL && _abnormalCache.set) return _abnormalCache.set
  const rows = await query(`
    SELECT tag_id FROM (
      SELECT tag_id, element_type,
        COUNT(*) AS total, SUM(is_fp) AS fp,
        ROUND((COUNT(*) - SUM(is_fp)) * 100.0 / NULLIF(COUNT(*), 0), 1) AS prec
      FROM real_data_samples
      GROUP BY tag_id, element_type
    ) sub
    WHERE prec <= 60 AND fp >= 100
  `)
  const set = new Set(rows.map(r => r.tag_id))
  _abnormalCache = { t: Date.now(), set }
  return set
}

// ===== 异常标签判定结束 =====

// 标签列表（误杀样本分析）
// 从当前模式对应的精度聚合表读取（AI评测分析表（策略_标签）数据）
// 精度 = SUM(tp) / (SUM(tp) + SUM(fp)) × 100（查准率 = TP / (TP+FP)）
router.get('/', requireLogin, async (req, res, next) => {
  try {
    // 方案 A：时间窗口命中（子集）→ 从样本明细实时聚合
    if (await useSampleAggregation(req)) {
      const { where, params } = sampleTimeWhere(req)
      const rows = await query(
        rewriteDataTables(req, `SELECT tag_id AS id, MAX(tag_name) AS name,
              COUNT(*) AS total, SUM(is_fp) AS fp,
              COALESCE(ROUND((COUNT(*) - SUM(is_fp)) * 100.0 / COUNT(*), 1), 0) AS "precision",
              (COUNT(*) - SUM(is_fp)) AS tp, 0 AS fpConf, 0 AS tn, 0 AS fn,
              COUNT(*) AS sampleCount,
              MAX(first_level_industry_name) AS industryL1, MAX(second_level_industry_name) AS industryL2,
              MAX(element_type) AS elementType, '' AS elementTypeName,
              MAX(arrive_time) AS arriveTime, '' AS ds, '' AS modelVersion, '' AS elementFingerprint,
              MAX(remark) AS remark, MAX(fp_reason) AS fpReason
       FROM real_data_samples
       ${where}
       GROUP BY tag_id
       ORDER BY "precision" DESC`),
        params
      )
      // 样本明细表 tag_name 普遍为空 → 用 real_data_tags 字典补全标签名（仅补名字，不影响窗口聚合数值）
      const nmMap = await nameMap()
      const abnormalSet = await getAbnormalTagIds()
      rows.forEach(r => {
        r.total = Number(r.total) || 0
        r.fp = Number(r.fp) || 0
        r.tp = Number(r.tp) || 0
        r.precision = Number(r.precision) || 0
        r.sampleTotal = r.total
        r.fpConf = 0; r.tn = 0; r.fn = 0
        r.sampleCount = r.total
        r.industryL1 = r.industryL1 || ''
        r.industryL2 = r.industryL2 || ''
        r.elementType = r.elementType || ''
        r.elementTypeName = ''
        r.arriveTime = r.arriveTime || ''
        r.ds = ''; r.modelVersion = ''; r.elementFingerprint = ''
        r.remark = r.remark || ''
        r.fpReason = r.fpReason || ''
        r.name = (r.name && r.name.trim()) ? r.name : (nmMap[r.id] || '')
        r.isAbnormal = abnormalSet.has(r.id)
      })
      rows.forEach((r, i) => { r.rank = i + 1 })
      return res.json(rows)
    }
    // 默认（无窗口 / 覆盖全量）：沿用精度聚合表
    const { where, params } = timeWhere(req)
    // 按 tag_id 聚合：同一标签可能有多行（不同日期数据），需合并 total/tp/fp 后重算精度
    // 精度计算优先级：SUM(tp)/(SUM(tp)+SUM(fp)) → SUM(precision_val*total)/SUM(total) → (SUM(total)-SUM(fp))/SUM(total) → 0
    const rows = await query(
      rewriteDataTables(req, `SELECT tag_id AS id, MAX(tag_name) AS name,
              SUM(total) AS total, SUM(fp) AS fp,
              COALESCE(
                -- SQLite 整数除法会截断（65/100 = 0），必须写成 * 100.0 / 的形式。
                -- 此行曾漏改（带空格的写法未被批量替换命中），导致所有标签精度显示为 0。
                ROUND(SUM(tp) * 100.0 / NULLIF(SUM(tp) + SUM(fp), 0), 1),
                ROUND(SUM(precision_val * total) / NULLIF(SUM(total), 0), 1),
                ROUND((SUM(total) - SUM(fp)) * 100.0 / NULLIF(SUM(total), 0), 1),
                0
              ) AS "precision",
              SUM(tp) AS tp, SUM(fp_conf) AS fpConf, SUM(tn) AS tn, SUM(fn) AS fn,
              SUM(sample_count) AS sampleCount,
              MAX(first_level_industry_name) AS industryL1, MAX(second_level_industry_name) AS industryL2,
              MAX(element_type) AS elementType, MAX(element_type_name) AS elementTypeName,
              MAX(arrive_time) AS arriveTime, MAX(ds) AS ds, MAX(model_version) AS modelVersion,
              MAX(element_fingerprint) AS elementFingerprint,
              MAX(remark) AS remark, MAX(fp_reason) AS fpReason
       FROM real_data_tag_precision
       ${where}
       GROUP BY tag_id
       ORDER BY "precision" DESC`),
      params
    )
    // 整体样本数：从精度聚合表取 FP+TP
    rows.forEach(r => { r.sampleTotal = (Number(r.fp) || 0) + (Number(r.tp) || 0) })
    // 异常标签判定（tag + element_type 维度）
    const abnormalSet = await getAbnormalTagIds()
    rows.forEach(r => { r.isAbnormal = abnormalSet.has(r.id) })
    // 添加精度排名
    rows.forEach((r, i) => { r.rank = i + 1 })
    return res.json(rows)
  } catch (e) { next(e) }
})

// 概览 KPI
// 从当前模式对应的精度聚合表聚合计算（AI评测分析表数据）
// 精度 = SUM(tp) / (SUM(tp) + SUM(fp)) × 100（查准率 = TP / (TP+FP)）
router.get('/overview', requireLogin, async (req, res, next) => {
  try {
    // 方案 A：时间窗口命中（子集）→ 从样本明细实时聚合
    if (await useSampleAggregation(req)) {
      const { where, params } = sampleTimeWhere(req)
      const rows = await query(
        rewriteDataTables(req, `SELECT tag_id, COUNT(*) AS total, SUM(is_fp) AS fp FROM real_data_samples ${where} GROUP BY tag_id`),
        params
      )
      const tagMap = {}
      for (const r of rows) {
        tagMap[r.tag_id] = { total: Number(r.total) || 0, fp: Number(r.fp) || 0 }
      }
      const tagCount = Object.keys(tagMap).length
      const total = Object.values(tagMap).reduce((s, t) => s + t.total, 0)
      const fpCount = Object.values(tagMap).reduce((s, t) => s + t.fp, 0)
      const sampleTotal = total
      const overallPrecision = total > 0 ? Number(((total - fpCount) / total * 100).toFixed(1)) : 0
      const [dsRows, rangeRows] = await Promise.all([
        query(rewriteDataTables(req, `SELECT MAX(ds) AS latest_ds FROM real_data_samples WHERE ds != ''`)),
        query(`SELECT strftime('%Y-%m-%d', MIN(arrive_time)) AS min_d, strftime('%Y-%m-%d', MAX(arrive_time)) AS max_d FROM real_data_samples WHERE arrive_time IS NOT NULL`),
      ])
      const latestDs = dsRows.length && dsRows[0].latest_ds ? String(dsRows[0].latest_ds) : ''
      const dataMinDate = rangeRows.length && rangeRows[0].min_d ? String(rangeRows[0].min_d) : ''
      const dataMaxDate = rangeRows.length && rangeRows[0].max_d ? String(rangeRows[0].max_d) : ''
      return res.json({
        precision: overallPrecision,
        fpRate: total > 0 ? Number((fpCount / total * 100).toFixed(1)) : 0,
        fpCount,
        tagCount,
        sampleTotal,
        fileName: '',
        latestDs,
        dataMinDate,
        dataMaxDate,
      })
    }
    // 默认（无窗口 / 覆盖全量）：沿用精度聚合表
    // ★T6.3: 先查缓存（5分钟 TTL）
    const cacheKey = 'overview_kpi'
    const cached = overviewCache.get(cacheKey)
    if (cached && Date.now() - cached.t < OVERVIEW_CACHE_TTL) {
      return res.json(cached.data)
    }

    const { where, params } = timeWhere(req)
    const rows = await query(rewriteDataTables(req, `SELECT tag_id, total, tp, fp, sample_count FROM real_data_tag_precision ${where}`), params)
    if (!rows.length) return res.json({ precision: 0, fpRate: 0, fpCount: 0, tagCount: 0, sampleTotal: 0, fileName: '' })
    // 按 tag_id 聚合后再汇总，避免同标签多行导致计数偏高
    const tagMap = {}
    for (const r of rows) {
      if (!tagMap[r.tag_id]) tagMap[r.tag_id] = { total: 0, tp: 0, fp: 0, sampleCount: 0 }
      tagMap[r.tag_id].total += r.total
      tagMap[r.tag_id].tp += r.tp
      tagMap[r.tag_id].fp += r.fp
      tagMap[r.tag_id].sampleCount += r.sample_count
    }
    const tagCount = Object.keys(tagMap).length
    const total = Object.values(tagMap).reduce((s, t) => s + t.total, 0)
    const tpSum = Object.values(tagMap).reduce((s, t) => s + t.tp, 0)
    const fpCount = Object.values(tagMap).reduce((s, t) => s + t.fp, 0)
    // 整体样本数：Σ(FP+TP) from 精度聚合表
    const sampleTotal = fpCount + tpSum
    // ★ 性能优化：以下 3 个查询彼此独立，改为并行执行（远程 MySQL 每轮 RTT 显著，
    // 串行约 3×RTT，并行仅 1×RTT）；meta 多轮查询合并为一次 IN 查询。
    const _metaKeySeq = ['data_updated_at_ai_eval', 'data_updated_at_tag_precision', 'data_updated_at']
    const [dsRows, metaRows, rangeRows] = await Promise.all([
      query(rewriteDataTables(req, `
        SELECT MAX(ds) AS latest_ds FROM (
          SELECT ds FROM real_data_tag_precision WHERE ds != ''
          UNION
          SELECT ds FROM real_data_samples WHERE ds != ''
        ) AS all_ds`)),
      query(`SELECT "key", value FROM data_meta WHERE "key" IN (?,?,?)`, _metaKeySeq),
      query(rewriteDataTables(req, `
        SELECT strftime('%Y-%m-%d', MIN(arrive_time)) AS min_d, strftime('%Y-%m-%d', MAX(arrive_time)) AS max_d
         FROM real_data_samples WHERE arrive_time IS NOT NULL`)),
    ])
    const latestDs = dsRows.length && dsRows[0].latest_ds ? String(dsRows[0].latest_ds) : ''
    // fileName 读取自 data_meta 正式元信息表（兼容旧通用 key 'data_updated_at'），按优先级取第一个命中
    const metaMap = {}
    for (const m of metaRows) metaMap[m.key] = m.value
    let fileName = ''
    for (const _k of _metaKeySeq) {
      if (metaMap[_k]) { fileName = metaMap[_k]; break }
    }
    // 数据实际的 arrive_time 日期范围（供前端对齐默认时间窗口，避免"前N天"落在无数据区间）
    // 注意：必须取 real_data_samples（样本表）的 arrive_time，它是真实业务到达日期；
    // 不能取 real_data_tag_precision（精度表），因为精度表的 arrive_time 存的是上传当天日期，与业务日期脱节
    const dataMinDate = rangeRows.length && rangeRows[0].min_d ? String(rangeRows[0].min_d) : ''
    const dataMaxDate = rangeRows.length && rangeRows[0].max_d ? String(rangeRows[0].max_d) : ''
    // 精度计算兜底：tp/(tp+fp) → (total-fp)/total → 0
    let overallPrecision = 0
    if (tpSum + fpCount > 0) {
      overallPrecision = Number((tpSum / (tpSum + fpCount) * 100).toFixed(1))
    } else if (total > 0) {
      overallPrecision = Number(((total - fpCount) / total * 100).toFixed(1))
    }
    const result = {
      precision: overallPrecision,
      fpRate: total > 0 ? Number((fpCount / total * 100).toFixed(1)) : 0,
      fpCount,
      tagCount,
      sampleTotal,
      fileName,
      latestDs,
      dataMinDate,
      dataMaxDate,
    }
    // ★T6.3: 写入缓存
    overviewCache.set(cacheKey, { data: result, t: Date.now() })
    return res.json(result)
  } catch (e) { next(e) }
})

// 元素类型枚举值 → 中文名映射
// 数据来源多样（ai_evaluate_detail、real_data_samples、用户上传文件），需要统一映射
const ELEMENT_TYPE_MAP = {
  'ELEMENT_TYPE_IMAGE': '图片',
  'ELEMENT_TYPE_VIDEO': '视频',
  'ELEMENT_TYPE_TEXT': '文本',
  'ELEMENT_TYPE_URL': '落地页',
  // real_data_samples 中 element_type 存储的是数字编码
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

// 标签 × 元素类型 精度（异常判定同维度）
// 从 real_data_samples 按 tag_id + element_type 聚合，返回每个组合的精度/FP/样本量，
// 供「各标签精度」柱状图按「标签-元素类型」维度展示（异常指标本身即标签×元素类型粒度）
router.get('/element-precision', requireLogin, async (req, res, next) => {
  try {
    const start = (req.query.start || '').trim()
    const end = (req.query.end || '').trim()
    const timeClauses = []
    const timeParams = []
    if (start) { timeClauses.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) >= ?)"); timeParams.push(start) }
    if (end) { timeClauses.push("(arrive_time IS NULL OR arrive_time = '' OR DATE(arrive_time) <= ?)"); timeParams.push(end) }
    const timeCond = timeClauses.length ? 'WHERE ' + timeClauses.join(' AND ') : ''

    const rows = await query(
      `SELECT tag_id AS id, MAX(tag_name) AS name, element_type AS elementType,
        COUNT(*) AS total, SUM(is_fp) AS fp,
        ROUND((COUNT(*) - SUM(is_fp)) * 100.0 / NULLIF(COUNT(*), 0), 1) AS "precision"
       FROM real_data_samples
       ${timeCond}
       GROUP BY tag_id, element_type
       ORDER BY "precision" ASC`,
      timeParams
    )
    // 标签名兜底：样本表 tag_name 普遍为空，回退精度表 real_data_tag_precision 的 tag_name（real_data_tags 字典常为空）
    const nmRows = await query(`SELECT tag_id, MAX(tag_name) AS tag_name FROM real_data_tag_precision GROUP BY tag_id`)
    const nmMap = {}
    for (const n of nmRows) nmMap[n.tag_id] = n.tag_name || ''
    for (const r of rows) {
      r.total = Number(r.total) || 0
      r.fp = Number(r.fp) || 0
      r.precision = Number(r.precision) || 0
      r.elementTypeName = mapElementType(r.elementType)
      r.name = (r.name && String(r.name).trim()) ? r.name : (nmMap[r.id] || '')
      r.isAbnormal = r.precision <= 60 && r.fp >= 100
    }
    return res.json(rows)
  } catch (e) { next(e) }
})

// 标签下的素材明细
// 从 real_data_tag_precision_samples 表读取 is_fp=1 数据
//   若精度样本表也为空，则回退到 real_data_samples（is_fp=1）
router.get('/:id/samples', requireLogin, async (req, res, next) => {
  try {
    // ★ 标签 ID 解析（871+ → 1001+）：UI 传 real_data_tags.id（871+），
    //   样本/精度/素材分类表用的是 tag_id（1001+），不解析会导致按标签查空 → 素材明细 0 条
    const resId = await sampleTagIdOf(req.params.id)
    // ===== 平台数据逻辑 =====
      // 解析时间窗口参数
      const start = (req.query.start || '').trim()
      const end = (req.query.end || '').trim()
      const timeClauses = []
      const timeParams = []
      // 用 DATE() 规范化 arrive_time（varchar 可能存 '2026-07-15T00:00:00'），避免当天数据被字符串比较排除
      // 放行 arrive_time 为空/无效（NULL/空串）的样本——部分 FP 样本无到达时间，不应被时间窗口误判为「窗口外」丢弃
      if (start) { timeClauses.push('(arrive_time IS NULL OR arrive_time = \'\' OR DATE(arrive_time) >= ?)'); timeParams.push(start) }
      if (end) { timeClauses.push('(arrive_time IS NULL OR arrive_time = \'\' OR DATE(arrive_time) <= ?)'); timeParams.push(end) }
      const timeCond = timeClauses.length ? ' AND ' + timeClauses.join(' AND ') : ''
      // JOIN 查询中需要带表别名前缀避免歧义
      const timeCondJoin = timeClauses.length ? ' AND ' + timeClauses.join(' AND ').replace(/arrive_time/g, 's.arrive_time') : ''

      // 标签匹配条件：tag_id 精确 OR policy_ids/ai_evaluate_policy_ids 复合成员命中（逗号边界避免 14795 误命中 147950）
      // 与「标签明细/工单关联素材」口径对齐：复合标签行（如 policy_ids='14748,14795'）的 tag_id 常存主标签，
      // 仅用 s.tag_id=? 精确匹配会漏掉这些行，导致「明细有数据、素材分类却 0 条」。
      const _tid = String(resId).replace(/[^0-9]/g, '')
      const tagMatchCond = `(s.tag_id = ? OR (',' || REPLACE(REPLACE(IFNULL(s.policy_ids,''),'[',''),']','') || ',') LIKE ? OR (',' || REPLACE(REPLACE(IFNULL(s.ai_evaluate_policy_ids,''),'[',''),']','') || ',') LIKE ?)`
      const tagMatchParams = [resId, `%,${_tid},%`, `%,${_tid},%`]

      // 审核判定筛选：默认仅返回误杀(FP)样本（兼容「素材分类」预览）；
      // status=all 时返回该标签下全部命中样本（含一致/漏放），并附 verifyStatus 供前端筛选
      const _includeAll = (req.query.status || '').trim() === 'all'
      const fpClause = _includeAll ? '' : ' AND s.is_fp=1'

      // ★T6.4: 主表优先——先查精度样本明细表，空则回退查 real_data_samples（避免两次复杂查询）
      // 本地 Mock：该表在 With 平台由 T+0 同步任务填充，本地无同步链路，
      // 空表时从 real_data_samples 导入 FP 样本一次（lazy 自愈，不依赖外部脚本顺序）。
      try {
        const _pc = await query(`SELECT COUNT(*) AS c FROM real_data_tag_precision_samples`)
        if (!Number(_pc[0]?.c)) {
          await query(`INSERT INTO real_data_tag_precision_samples
            (tag_id, tag_name, sample_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids,
             first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content,
             uid, arrive_time, ds, is_fp, fp_reason, remark, class_num, class_id, dc_id,
             ops_advertiser_name, element_fingerprint, ai_evaluate_reviewer_name)
          SELECT tag_id, tag_name, sample_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids,
             first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content,
             uid, arrive_time, ds, is_fp, fp_reason, remark, class_num, class_id, dc_id,
             ops_advertiser_name, element_fingerprint, ai_evaluate_reviewer_name
          FROM real_data_samples WHERE is_fp = 1`)
        }
      } catch { /* 表不可用时不阻塞主查询，走回退逻辑 */ }

      let rows = await query(
        rewriteDataTables(req, `SELECT s.sample_id AS id, s.element_type AS elementType, s.is_video AS isVideo, s.policy_ids AS machineTag, s.ai_evaluate_policy_ids AS humanTag,
         s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
         s.media_url AS mediaUrl, s.ocr_content AS ocrContent,
s.asr_content AS asrContent, s.class_num AS classNum, COALESCE(NULLIF(s.class_id, ''), d.class_id, c.class_id) AS classId, s.uid AS uid, s.arrive_time AS arriveTime, s.ds,
         s.is_fp AS isFp, s.fp_reason AS fpReason, s.remark,
         COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint, '') AS elementFingerprint,
         COALESCE(d.policy_ids, s.policy_ids) AS policyIds, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds, COALESCE(d.dc_id, '') AS dcId,
COALESCE(d.ops_advertiser_name, '') AS opsAdvertiserName, COALESCE(NULLIF(s.ai_evaluate_reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName, COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
         rel.category_id AS categoryId, rel.feature_desc AS featureDesc, rel.supplement AS supplement
         FROM real_data_tag_precision_samples s
         LEFT JOIN ai_evaluate_detail_url_idx d
         ON d.element_value_norm = CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END
         LEFT JOIN (SELECT element_fingerprint, MAX(class_id) AS class_id, MAX(element_value) AS element_value FROM cluster_data GROUP BY element_fingerprint) c ON c.element_fingerprint = s.element_fingerprint OR c.element_value = s.media_url
         LEFT JOIN material_category_relation rel ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
         WHERE ${tagMatchCond}${fpClause}${timeCondJoin} ORDER BY s.id`),
        [...tagMatchParams, ...timeParams]
      )
      // 注意：去掉原 `precisionFpCount > 0` 限制——该限制会让「精度聚合表 fp=0 但原始样本表 is_fp=1 有数据」
      // 的标签（如纯净误杀率口径外的标签）取不到任何素材，表现为「点进标签却无素材可预览」。
      // 主表空即回退，回退查询本身已按 s.is_fp=1 过滤，口径不变。
        if (!rows.length) {
        rows = await query(
          rewriteDataTables(req, `SELECT s.sample_id AS id, s.element_type AS elementType, s.is_video AS isVideo, s.policy_ids AS machineTag, s.ai_evaluate_policy_ids AS humanTag,
           s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
           s.media_url AS mediaUrl, s.ocr_content AS ocrContent,
s.asr_content AS asrContent, s.class_num AS classNum, s.uid AS uid, s.arrive_time AS arriveTime, s.ds,
         s.is_fp AS isFp, s.fp_reason AS fpReason, s.remark,
         COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint, '') AS elementFingerprint,
COALESCE(NULLIF(s.class_id, ''), d.class_id, c.class_id) AS classId, COALESCE(d.policy_ids, s.policy_ids) AS policyIds, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
         COALESCE(NULLIF(s.dc_id, ''), d.dc_id) AS dcId,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name) AS opsAdvertiserName,
         COALESCE(NULLIF(s.ai_evaluate_reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
         rel.category_id AS categoryId, rel.feature_desc AS featureDesc, rel.supplement AS supplement
         FROM real_data_samples s
         LEFT JOIN ai_evaluate_detail_url_idx d
         ON d.element_value_norm = CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END
         LEFT JOIN (SELECT element_fingerprint, MAX(class_id) AS class_id, MAX(element_value) AS element_value FROM cluster_data GROUP BY element_fingerprint) c ON c.element_fingerprint = s.element_fingerprint OR c.element_value = s.media_url
         LEFT JOIN material_category_relation rel ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
         WHERE ${tagMatchCond}${fpClause}${timeCondJoin} ORDER BY s.id`),
        [...tagMatchParams, ...timeParams]
        )
      }

      // 兜底恢复：sample_id 不匹配时，用 sample_id 匹配旧标注
      // 标注表通过 sample_id 关联（material_category_relation 表无 media_url 列）
      if (rows.length) {
        const unannotated = rows.filter(r => !r.categoryId && r.id)
        if (unannotated.length) {
          const idList = unannotated.map(r => r.id).filter(Boolean)
          if (idList.length) {
            const placeholders = idList.map(() => '?').join(',')
            try {
              const mediaRels = await query(
                `SELECT sample_id, category_id, feature_desc, supplement
                 FROM material_category_relation
                 WHERE tag_id=? AND sample_id IN (${placeholders}) AND category_id > 0`,
                [resId, ...idList]
              )
              if (mediaRels.length) {
                const mediaMap = {}
                for (const m of mediaRels) mediaMap[m.sample_id] = m
                for (const r of rows) {
                  if (!r.categoryId && r.id && mediaMap[r.id]) {
                    r.categoryId = mediaMap[r.id].category_id
                    r.featureDesc = mediaMap[r.id].feature_desc
                    r.supplement = mediaMap[r.id].supplement
                  }
                }
              }
            } catch (_) { /* 兜底匹配失败不影响主数据返回 */ }
          }
        }
      }

      // 将枚举值转为中文显示名
      for (const r of rows) {
        r.elementTypeName = mapElementType(r.elementType)
        r.isVideo = !!r.isVideo || r.elementType === 'ELEMENT_TYPE_VIDEO' || r.elementTypeName === '视频'
        // 清洗方括号：统一去掉 machineTag/humanTag 中的 [ ] 包裹
        if (r.machineTag) r.machineTag = String(r.machineTag).replace(/[\[\]]/g, '')
        if (r.humanTag) r.humanTag = String(r.humanTag).replace(/[\[\]]/g, '')
      }

      // 兜底：machineTag 为空或仅为 [] 时，填充为当前标签 ID（SQL 已按 tag_id 过滤，归属确定）
      const _tagIdStr = `${resId}`
      for (const r of rows) {
        if (!r.machineTag || r.machineTag === '[]' || String(r.machineTag).trim() === '') {
          r.machineTag = _tagIdStr
        }
      }

      // 检查明细数据中行业是否为空，若为空则从精度聚合表联动填充
      const hasEmptyIndustry = rows.some(r => !r.firstLevelIndustryName || !r.secondLevelIndustryName)
      if (hasEmptyIndustry) {
        const precisionRows = await query(
      rewriteDataTables(req, `SELECT first_level_industry_name, second_level_industry_name
           FROM real_data_tag_precision WHERE tag_id=? AND (first_level_industry_name!='' OR second_level_industry_name!='') LIMIT 1`),
          [resId]
        )
        if (precisionRows.length) {
          const p = precisionRows[0]
          const l1 = p.first_level_industry_name || ''
          const l2 = p.second_level_industry_name || ''
          for (const r of rows) {
            if (!r.firstLevelIndustryName) r.firstLevelIndustryName = l1
            if (!r.secondLevelIndustryName) r.secondLevelIndustryName = l2
          }
        }
      }

      // 去重：LEFT JOIN ai_evaluate_detail / cluster_data / material_category_relation 可能产生重复行
      // 按「归一化复合 key」去重：指纹 > 归一化 media_url（去签名参数） > sample_id
      // 以抗「同一素材不同 sample_id」或「同一视频 URL 带不同签名参数」造成的重复预览
      const _seenMap = new Map()
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
      // rawTotal：去重前的真实原始样本总数（同一素材因签名参数/不同 sample_id 产生的重复副本计入总数）
      // 与去重后渲染的 rows.length 区分，避免「卡片数 = 真实样本数」的口径误解
      const _rawTotal = rows.length
      for (const r of rows) {
        const key = _dedupKey(r)
        const prev = _seenMap.get(key)
        if (!prev) {
          _seenMap.set(key, r)
          continue
        }
        const curIsFp = Number(r.isFp) === 1
        const prevIsFp = Number(prev.isFp) === 1
        if (curIsFp && !prevIsFp) {
          // ★FP 优先：同一素材（指纹/URL）下 FP 与 TP 行混合时，必须保留 FP 行，
          // 否则去重会把误杀样本吞掉（如 14934：310 FP → 仅 8 条），
          // 导致「误杀数分布」等基于 isFp 的统计严重缺失。替换时保留已存在的分类信息。
          if (prev.categoryId && !r.categoryId) {
            r.categoryId = prev.categoryId
            r.featureDesc = prev.featureDesc
            r.supplement = prev.supplement
          }
          _seenMap.set(key, r)
        } else {
          // 已存在且不替换：如果当前行有分类信息而之前没有，补充
          if (r.categoryId && !prev.categoryId) {
            prev.categoryId = r.categoryId
            prev.featureDesc = r.featureDesc
            prev.supplement = r.supplement
          }
        }
      }
      rows = Array.from(_seenMap.values())
      // 通过数组非索引属性携带真实总数（兼容前端 Array.isArray 判断，不影响渲染遍历）
      Object.defineProperty(rows, 'rawTotal', { value: _rawTotal, enumerable: false, configurable: true })

      // 审核判定状态（与 TicketsView matStatus 口径一致，仅限「该标签」维度）：
      // consistent 一致：机审(审核标签ID)打了该标签 且 人审(ai_evaluate_policy_ids)也打了该标签
      // fp        误杀：机审打了该标签 但 人审没有打该标签
      // miss      漏放：除了一致和误杀的情况（即人审打了该标签但机审未打，或双方都未打）
      const _normTagIds = (v) => {
        const raw = String(v || '').replace(/[\[\]\s]/g, '')
        return raw ? raw.split(/[,，]/).map(t => t.trim()).filter(Boolean) : []
      }
      const _tid2 = String(resId).replace(/[^0-9]/g, '')
      for (const r of rows) {
        const mt = _normTagIds(r.machineTag)
        const ht = _normTagIds(r.humanTag)
        const machineHit = mt.includes(_tid2)
        const humanHit = ht.includes(_tid2)
        r.verifyStatus = machineHit && humanHit ? 'consistent' : (machineHit && !humanHit ? 'fp' : 'miss')
        r.tagId = req.params.id
      }

      return res.json(rows)
  } catch (e) { next(e) }
})

// real_data_samples 中 element_type 可能存编码/数字/中文，筛选时做多值匹配
const ELEMENT_TYPE_FILTER_MAP = {
  'ELEMENT_TYPE_IMAGE': ['ELEMENT_TYPE_IMAGE', '2', '3'],
  'ELEMENT_TYPE_VIDEO': ['ELEMENT_TYPE_VIDEO', '4'],
  'ELEMENT_TYPE_TEXT': ['ELEMENT_TYPE_TEXT', '1'],
  'ELEMENT_TYPE_URL': ['ELEMENT_TYPE_URL', '5'],
  '图片': ['ELEMENT_TYPE_IMAGE', '2', '3'],
  '视频': ['ELEMENT_TYPE_VIDEO', '4'],
  '文本': ['ELEMENT_TYPE_TEXT', '1'],
  '落地页': ['ELEMENT_TYPE_URL', '5'],
}
// 构建 trend 接口的行业/元素筛选条件（作用在聚合表/明细表的公共列上）
function buildTrendFilters(req) {
  const f = { cond: '', params: [] }
  const industry = (req.query.industry || '').trim()
  const industryL2 = (req.query.industryL2 || '').trim()
  const elementType = (req.query.elementType || '').trim()
  if (industry) { f.cond += ' AND first_level_industry_name = ?'; f.params.push(industry) }
  if (industryL2) { f.cond += ' AND second_level_industry_name = ?'; f.params.push(industryL2) }
  if (elementType) {
    const list = ELEMENT_TYPE_FILTER_MAP[elementType] || [elementType]
    f.cond += ` AND element_type IN (${list.map(() => '?').join(',')})`
    f.params.push(...list)
  }
  return f
}

// 标签趋势：支持按 arrive_time 日期逐天聚合 或 按 ds 周期聚合
// 从样本明细表/精度聚合表按日维度分组聚合（返回每日精度趋势）
// 日维度优先从样本明细表 real_data_samples 聚合（该表 arrive_time 格式规范），
// 周维度从精度聚合表 real_data_tag_precision 按 ds 聚合
// 支持筛选参数：industry（一级行业）、elementType（元素类型）、days（7/14/30）、start/end（时间区间）
router.get('/:id/trend', requireLogin, async (req, res, next) => {
  try {
    const groupBy = (req.query.groupBy || 'date').trim() === 'ds' ? 'ds' : 'date'
    // ★ 标签 ID 解析（871+ → 1001+），避免按标签查空
    const tid = await sampleTagIdOf(req.params.id)

    // 时间范围：优先 start/end，其次 days（默认 7 天，含当天）
    const days = parseInt(req.query.days, 10)
    let start = (req.query.start || '').trim()
    let end = (req.query.end || '').trim()
    if (!start && !end && days && days > 0) {
      // 「近N天」终点锚点取样本表最新业务日期，而非当天（数据可能不每日更新，当天会落空）
      const range = await getSampleRange()
      const d = range.max ? new Date(String(range.max).slice(0, 10) + 'T00:00:00') : new Date()
      const p = n => String(n).padStart(2, '0')
      end = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      const s = new Date(d.getTime() - (days - 1) * 86400000)
      start = `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`
    }

    if (groupBy === 'ds') {
      const f = buildTrendFilters(req)
      const rows = await query(
        rewriteDataTables(req, `SELECT ds AS date,
                SUM(tp) AS tp, SUM(fp) AS fp, SUM(total) AS total,
                COALESCE(
                  ROUND(SUM(tp) * 100.0 / NULLIF(SUM(tp) + SUM(fp), 0), 1),
                  ROUND(SUM(precision_val * total) / NULLIF(SUM(total), 0), 1),
                  ROUND((SUM(total) - SUM(fp)) * 100.0 / NULLIF(SUM(total), 0), 1),
                  0
                ) AS "precision"
         FROM real_data_tag_precision
         WHERE tag_id=? AND ds IS NOT NULL AND ds != '' ${f.cond}
         GROUP BY ds ORDER BY ds ASC`),
        [tid, ...f.params]
      )
      return res.json(rows.map(r => ({
        date: r.date,
        precision: Number(r.precision) || 0,
        fp: Number(r.fp) || 0,
        tp: Number(r.tp) || 0,
        total: Number(r.total) || 0,
      })))
    }

    // 日维度：从样本明细表按 arrive_time 聚合（精度聚合表的 arrive_time 存的是上传日期，不可靠）
    const f = buildTrendFilters(req)
    const timeCond = []
    const timeParams = []
    if (start) { timeCond.push("DATE(REPLACE(NULLIF(arrive_time, ''), '/', '-')) >= ?"); timeParams.push(start) }
    if (end) { timeCond.push("DATE(REPLACE(NULLIF(arrive_time, ''), '/', '-')) <= ?"); timeParams.push(end) }
    const sampleRows = await query(
      rewriteDataTables(req, `SELECT DATE(REPLACE(NULLIF(arrive_time, ''), '/', '-')) AS date,
              COUNT(*) AS total,
              SUM(CASE WHEN is_fp = 1 THEN 1 ELSE 0 END) AS fp
       FROM real_data_samples
       WHERE tag_id=? AND arrive_time IS NOT NULL AND LENGTH(TRIM(arrive_time)) >= 8 ${f.cond} ${timeCond.length ? 'AND ' + timeCond.join(' AND ') : ''}
       GROUP BY DATE(REPLACE(NULLIF(arrive_time, ''), '/', '-'))
       ORDER BY date ASC`),
      [tid, ...f.params, ...timeParams]
    )

    return res.json(sampleRows.map(r => {
      const total = Number(r.total) || 0
      const fp = Number(r.fp) || 0
      const tp = total - fp
      const precision = total > 0 ? Number((tp / total * 100).toFixed(1)) : 0
      return { date: r.date, precision, fp, tp, total }
    }))
  } catch (e) { next(e) }
})

// ★性能优化 T6.2: 单标签聚合接口（仅返回该标签的聚合行，不含样本明细）
// 前端 TagDetailView 不再拉全量 tag list 再 .find()
router.get('/:id', requireLogin, async (req, res, next) => {
  try {
    // 方案 A：时间窗口命中（子集）→ 从样本明细实时聚合
    if (await useSampleAggregation(req)) {
      const { where, params } = sampleTimeWhere(req)
      // ★ 标签 ID 解析（871+ → 1001+），避免按标签查空
      const tid = await sampleTagIdOf(req.params.id)
      const rows = await query(
        rewriteDataTables(req, `SELECT tag_id AS id, MAX(tag_name) AS name,
        COUNT(*) AS total, SUM(is_fp) AS fp,
        COALESCE(ROUND((COUNT(*) - SUM(is_fp)) * 100.0 / COUNT(*), 1), 0) AS "precision",
        (COUNT(*) - SUM(is_fp)) AS tp, COUNT(*) AS sampleCount
       FROM real_data_samples WHERE tag_id=? ${where.replace(/^WHERE /, 'AND ')} GROUP BY tag_id`),
        [tid, ...params]
      )
      if (!rows.length) return res.json({ id: req.params.id, name: '', precision: 0, total: 0, fp: 0, sampleTotal: 0 })
      const r = rows[0]
      r.sampleTotal = Number(r.total) || 0
      r.fp = Number(r.fp) || 0
      r.tp = Number(r.tp) || 0
      r.precision = Number(r.precision) || 0
      r.name = r.name || ''
      // 样本明细表的 tag_name 可能为空 → 回退精度聚合表取标签名（仅取名字，不影响窗口聚合数值）
      if (!r.name) {
        try {
          const nm = await query(rewriteDataTables(req, `SELECT MAX(tag_name) AS name FROM real_data_tag_precision WHERE tag_id=?`), [tid])
          if (nm.length && nm[0].name) r.name = nm[0].name
        } catch { /* 取名字失败不影响数值返回 */ }
      }
      return res.json(r)
    }
    // 默认（无窗口 / 覆盖全量）：沿用精度聚合表
    const tid2 = await sampleTagIdOf(req.params.id)
    const rows = await query(
      rewriteDataTables(req, `SELECT tag_id AS id, MAX(tag_name) AS name,
        SUM(total) AS total, SUM(fp) AS fp,
        COALESCE(ROUND(SUM(tp) * 100.0 / NULLIF(SUM(tp)+SUM(fp), 0), 1),
                 ROUND(SUM(precision_val*total)/NULLIF(SUM(total),0),1),
                 ROUND((SUM(total)-SUM(fp))/NULLIF(SUM(total),0)*100,1),0) AS "precision",
        SUM(tp) AS tp, SUM(fp_conf) AS fpConf, SUM(sample_count) AS sampleCount,
        MAX(first_level_industry_name) AS industryL1, MAX(second_level_industry_name) AS industryL2,
        MAX(element_type) AS elementType, MAX(element_type_name) AS elementTypeName
       FROM real_data_tag_precision WHERE tag_id=? GROUP BY tag_id`),
      [tid2]
    )
    if (!rows.length) return res.json({ id: req.params.id, name: '', precision: 0, total: 0, fp: 0, sampleTotal: 0 })
    const r = rows[0]
    r.sampleTotal = (Number(r.fp) || 0) + (Number(r.tp) || 0)
    return res.json(r)
  } catch (e) { next(e) }
})

// 导出选中 FP 素材为 Excel
// POST /:id/export/excel
// 请求体: { sampleIds: [...], start: "...", end: "..." }
// 返回: Excel 文件流
// 查询 real_data_tag_precision_samples（或回退到 real_data_samples），LEFT JOIN ai_evaluate_detail 补全4个字段
router.post('/:id/export/excel', requireLogin, async (req, res, next) => {
  try {
    // ★ 标签 ID 解析（871+ → 1001+），避免按标签查空
    const resId = await sampleTagIdOf(req.params.id)
    const { sampleIds, start, end } = req.body || {}
    if (!Array.isArray(sampleIds) || !sampleIds.length) {
      return res.status(400).json({ error: '请选择至少一条素材进行导出' })
    }

    // 查询 real_data_tag_precision_samples（优先）或 real_data_samples
    const timeClauses = []
    const timeParams = []
    // 用 DATE() 规范化 s.arrive_time（varchar 混存 '2026-07-15T00:00:00' 和 '2026-07-15'）
    if (start) { timeClauses.push('DATE(s.arrive_time) >= ?'); timeParams.push(start) }
    if (end) { timeClauses.push('DATE(s.arrive_time) <= ?'); timeParams.push(end) }
    const timeCond = timeClauses.length ? ' AND ' + timeClauses.join(' AND ') : ''

    // sampleIds 占位符
    const idPlaceholders = sampleIds.map(() => '?').join(',')
    const idParams = sampleIds.map(String)

    // 优先从精度样本表查询（含 ocr/asr/md5 来自 ai_evaluate_detail，分类/补充说明来自 material_category_relation）
    let rows = await query(
      rewriteDataTables(req, `SELECT s.sample_id AS id, s.element_type AS elementType, COALESCE(d.policy_ids, s.policy_ids) AS machineTag, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS humanTag,
       s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
s.uid AS uid, s.arrive_time AS arriveTime, s.class_num AS classNum, s.remark,
       s.media_url AS elementValue,
       COALESCE(s.ocr_content, d.ocr_content) AS ocrContent,
       COALESCE(s.asr_content, d.asr_content) AS asrContent,
       COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint, '') AS elementFingerprint,
       COALESCE(NULLIF(s.class_id, ''), d.class_id) AS classId, COALESCE(d.policy_ids, s.policy_ids) AS policyIds, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
       COALESCE(d.dc_id, '') AS dcId,
COALESCE(d.ops_advertiser_name, '') AS opsAdvertiserName,
       COALESCE(NULLIF(s.ai_evaluate_reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
       COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
       rel.category_id AS categoryId,
       rel.supplement AS supplement,
       cat.name AS categoryName
       FROM real_data_tag_precision_samples s
       LEFT JOIN ai_evaluate_detail d
         ON d.element_value = s.media_url OR (CASE WHEN instr(d.element_value,'?')>0 THEN substr(d.element_value,1,instr(d.element_value,'?')-1) ELSE d.element_value END) = (CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END)
       LEFT JOIN material_category_relation rel
         ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
       LEFT JOIN material_category cat
         ON cat.id = rel.category_id
       WHERE s.tag_id = ?
         AND s.is_fp = 1
         AND s.sample_id IN (${idPlaceholders})
         ${timeCond}
       ORDER BY s.id`),
      [resId, ...idParams, ...timeParams]
    )

    // 精度样本表为空 → 回退到 real_data_samples
    if (!rows.length) {
      rows = await query(
      rewriteDataTables(req, `SELECT s.sample_id AS id, s.element_type AS elementType, COALESCE(d.policy_ids, s.policy_ids) AS machineTag, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS humanTag,
         s.first_level_industry_name AS firstLevelIndustryName, s.second_level_industry_name AS secondLevelIndustryName,
s.uid AS uid, s.arrive_time AS arriveTime, s.class_num AS classNum, s.remark,
         s.media_url AS elementValue,
         COALESCE(s.ocr_content, d.ocr_content) AS ocrContent,
         COALESCE(s.asr_content, d.asr_content) AS asrContent,
         COALESCE(NULLIF(s.element_fingerprint, ''), d.element_fingerprint, '') AS elementFingerprint,
COALESCE(NULLIF(s.class_id, ''), d.class_id) AS classId, COALESCE(d.policy_ids, s.policy_ids) AS policyIds, COALESCE(d.ai_evaluate_policy_ids, s.ai_evaluate_policy_ids) AS aiEvaluatePolicyIds,
         COALESCE(NULLIF(s.dc_id, ''), d.dc_id, '') AS dcId,
COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS opsAdvertiserName,
         COALESCE(NULLIF(s.ai_evaluate_reviewer_name, ''), d.ai_evaluate_reviewer_name, '') AS reviewerName,
         COALESCE(NULLIF(s.ops_advertiser_name, ''), d.ops_advertiser_name, '') AS advertiserId,
         rel.category_id AS categoryId,
         rel.supplement AS supplement,
         cat.name AS categoryName
         FROM real_data_samples s
         LEFT JOIN ai_evaluate_detail d
           ON d.element_value = s.media_url OR (CASE WHEN instr(d.element_value,'?')>0 THEN substr(d.element_value,1,instr(d.element_value,'?')-1) ELSE d.element_value END) = (CASE WHEN instr(s.media_url,'?')>0 THEN substr(s.media_url,1,instr(s.media_url,'?')-1) ELSE s.media_url END)
         LEFT JOIN material_category_relation rel
           ON rel.tag_id = s.tag_id AND rel.sample_id = s.sample_id
         LEFT JOIN material_category cat
           ON cat.id = rel.category_id
         WHERE s.tag_id = ?
           AND s.is_fp = 1
           AND s.sample_id IN (${idPlaceholders})
           ${timeCond}
         ORDER BY s.id`),
        [resId, ...idParams, ...timeParams]
      )
    }

    // 兜底恢复：sample_id 不匹配时，用 sample_id 匹配旧标注
    if (rows.length) {
      const unannotated = rows.filter(r => !r.categoryId && r.id)
      if (unannotated.length) {
        const idList = unannotated.map(r => r.id).filter(Boolean)
        if (idList.length) {
          const idPh = idList.map(() => '?').join(',')
          try {
            const mediaRels = await query(
              `SELECT sample_id, category_id, supplement
               FROM material_category_relation
               WHERE tag_id=? AND sample_id IN (${idPh}) AND category_id > 0`,
              [resId, ...idList]
            )
            if (mediaRels.length) {
              const mediaMap = {}
              for (const m of mediaRels) mediaMap[m.sample_id] = m
              // 查分类名称
              const catIds = [...new Set(mediaRels.map(m => m.category_id))]
              if (catIds.length) {
                const catPh = catIds.map(() => '?').join(',')
                const catRows = await query(`SELECT id, name FROM material_category WHERE id IN (${catPh})`, catIds)
                const catNameMap = {}
                for (const c of catRows) catNameMap[c.id] = c.name
                for (const r of rows) {
                  if (!r.categoryId && r.id && mediaMap[r.id]) {
                    r.categoryId = mediaMap[r.id].category_id
                    r.supplement = mediaMap[r.id].supplement
                    r.categoryName = catNameMap[r.categoryId] || ''
                  }
                }
              }
            }
          } catch (_) { /* 兜底匹配失败不影响导出 */ }
        }
      }
    }

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
    rows = Array.from(_exportSeen.values())

    // 清洗数据
    for (const r of rows) {
      r.elementTypeName = mapElementType(r.elementType)
      if (r.machineTag) r.machineTag = String(r.machineTag).replace(/[\[\]]/g, '')
      if (r.humanTag) r.humanTag = String(r.humanTag).replace(/[\[\]]/g, '')
    }

    return generateExcel(res, rows, req.params.id)
  } catch (e) { next(e) }
})

// 生成 Excel 文件并返回（13列，素材特征分类导出专用）
async function generateExcel(res, rows, tagId) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('素材特征分类导出', {
    properties: { defaultColWidth: 18 },
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  // 表头（按用户要求的16列）
  const headers = [
    '到达时间',
    'AMS一级行业名称(开户行业)',
    'AMS二级行业名称(开户行业)',
    '审核元素类型',
    '审核标签ID',
    'AI评测人审标签',
    '审核人',
    '创意ID(DCID)',
    '客户主体名称(OPS)',
    '审核元素值',
    '审核物理指纹(md5)',
    'ocr_text',
    'asr_text',
    'class_num',
    '分类',
    '补充说明',
  ]
  const headerRow = ws.addRow(headers)
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F7CFF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
  })
  ws.getRow(1).height = 28

  // 数据行
  for (const r of rows) {
    ws.addRow([
      r.arriveTime || '',
      r.firstLevelIndustryName || '',
      r.secondLevelIndustryName || '',
      r.elementTypeName || '',
      r.machineTag || '',
      r.humanTag || '',
      r.reviewerName || '',
      r.dcId || '',
      r.opsAdvertiserName || '',
      r.elementValue || '',
      r.elementFingerprint || '',
      r.ocrContent || '',
      r.asrContent || '',
      r.classNum ?? '',
      r.categoryName || '',
      r.supplement || r.remark || '',
    ])
  }

  // 自适应列宽（简单估算）
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
  res.setHeader('Content-Disposition', `attachment; filename="tag-${tagId}-fp-export.xlsx"`)

  const buffer = await wb.xlsx.writeBuffer()
  res.send(Buffer.from(buffer))
}

// ★性能优化 T6.1: 手动重建 ai_evaluate_detail_url_idx 索引表（管理员触发）
// 部署本优化后必须手动调一次回填已有的 ai_evaluate_detail 数据
router.post('/rebuild-url-index', requireLogin, async (req, res, next) => {
  try {
    // 确保索引表存在
    await query(`CREATE TABLE IF NOT EXISTS ai_evaluate_detail_url_idx (
      element_value_norm TEXT NOT NULL,
      element_value TEXT,
      element_fingerprint TEXT,
      policy_ids TEXT,
      ai_evaluate_policy_ids TEXT,
      dc_id TEXT,
      class_id TEXT,
      ops_advertiser_name TEXT,
      ai_evaluate_reviewer_name TEXT,
      uid TEXT,
      UNIQUE(element_value_norm)
    )`)
    await query(`CREATE INDEX IF NOT EXISTS idx_url_idx_norm ON ai_evaluate_detail_url_idx(element_value_norm)`)

    await query(
      `INSERT OR REPLACE INTO ai_evaluate_detail_url_idx
        (element_value_norm, element_value, element_fingerprint, policy_ids, ai_evaluate_policy_ids, dc_id, class_id, ops_advertiser_name, ai_evaluate_reviewer_name, uid)
      SELECT
        CASE WHEN instr(element_value,'?')>0 THEN substr(element_value,1,instr(element_value,'?')-1) ELSE element_value END AS element_value_norm,
        element_value,
        MAX(NULLIF(element_fingerprint,'')),
        MAX(CASE WHEN policy_ids<>'[]' AND policy_ids<>'' THEN policy_ids END),
        MAX(CASE WHEN ai_evaluate_policy_ids<>'[]' AND ai_evaluate_policy_ids<>'' THEN ai_evaluate_policy_ids END),
        MAX(dc_id), MAX(class_id),
        MAX(NULLIF(ops_advertiser_name,'')),
        MAX(NULLIF(ai_evaluate_reviewer_name,'')),
        MAX(NULLIF(uid,''))
      FROM ai_evaluate_detail
      GROUP BY element_value_norm, element_value`
    )
    return res.json({ ok: true, message: '索引表已重建' })
  } catch (e) { next(e) }
})

export default router