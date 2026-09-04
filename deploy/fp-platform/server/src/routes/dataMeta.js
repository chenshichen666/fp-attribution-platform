import { Router, raw as expressRaw } from 'express'
import { query, pool } from '../db/pool.js'
import { requireLogin, requireRole, audit } from '../middleware/auth.js'
import { getServiceUrl } from '../trag/manager.js'
import { isLocalMode } from '../trag/upstream.js'
import { normDate, safeMaxDateGlobal } from '../utils/timeNorm.js'

// 使用 Node 20 内置原生 fetch（全局），不再依赖 node-fetch
const fetch = globalThis.fetch

const router = Router()

/**
 * 异步触发 TRAG 缓存预热（不阻塞主流程，静默失败）
 * @param {Array} samples - 样本数组，每个样本含 mediaUrl/ocrContent/asrContent/elementFingerprint 等字段
 */
function triggerWarmup(samples) {
  // 上游模式：正式 TRAG API 无预热接口，且检索为实时向量检索，无需预热
  if (!isLocalMode()) return
  if (!Array.isArray(samples) || !samples.length) return
  const tragUrl = getServiceUrl()
  if (!tragUrl) {
    console.log('[Warmup] TRAG 服务不可用，跳过预热')
    return
  }
  // 最多预热 200 条样本（避免时间过长）
  const batch = samples.slice(0, 200)
  fetch(`${tragUrl}/trag/warmup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ samples: batch, limit: 10, threshold: 0 }),
    signal: AbortSignal.timeout(600000), // 10 分钟超时
  }).then(async r => {
    const data = await r.json()
    console.log(`[Warmup] 预热请求完成:`, data.message || data)
  }).catch(e => {
    console.log(`[Warmup] 预热请求失败（非致命）:`, e.message)
  })
}

/**
 * 异步清空 TRAG 缓存（发布新数据后旧缓存已不可信）
 */
function triggerClearCache() {
  // 上游模式：正式 TRAG API 无清缓存接口；MySQL 侧 trag_cache 在检索时自动覆盖写入，无需清空
  if (!isLocalMode()) return
  const tragUrl = getServiceUrl()
  if (!tragUrl) {
    console.log('[CacheClear] TRAG 服务不可用，跳过清缓存')
    return
  }
  fetch(`${tragUrl}/trag/clear-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000),
  }).then(async r => {
    const data = await r.json()
    console.log(`[CacheClear] 清空缓存完成:`, data.message || data)
  }).catch(e => {
    console.log(`[CacheClear] 清空缓存失败（非致命）:`, e.message)
  })
}

// ==================== 数据集类型常量 ====================
const DS_AI_EVAL = 'ai-eval'
const DS_TAG_PRECISION = 'tag-precision'
const DS_ALL = 'all'

function normalizeDataset(ds) {
  const s = String(ds || DS_ALL).trim().toLowerCase()
  if (s === DS_AI_EVAL || s === DS_TAG_PRECISION) return s
  return DS_ALL
}

// 数据集 → 涉及的表（草稿/正式/备份）映射 + 字段列表（两个数据集表结构不同，必须区分）
const TABLE_MAP = {
  [DS_AI_EVAL]: {
    prodTags: 'real_data_tags',
    prodSamples: 'real_data_samples',
    backupTags: 'publish_backup_real_data_tags',
    backupSamples: 'publish_backup_real_data_samples',
    metaKey: 'data_updated_at_ai_eval',
    fieldStatusKey: 'field_link_status_ai_eval',
    datasetName: 'AI评测明细数据',
    // real_data_tags 字段（不含 id）
    tagsColumns: ['tag_id', 'tag_name', 'total', 'fp', 'precision_val', 'rank_no', 'remark', 'fp_reason'],
    // real_data_samples 字段（不含 id）
    samplesColumns: ['tag_id', 'tag_name', 'sample_id', 'element_fingerprint', 'dc_id', 'element_type', 'is_video',
      'policy_ids', 'ai_evaluate_policy_ids', 'first_level_industry_name', 'second_level_industry_name', 'media_url', 'ocr_content', 'asr_content',
      'class_num', 'class_id', 'uid', 'ops_advertiser_name', 'ai_evaluate_reviewer_name', 'arrive_time', 'ds', 'is_fp', 'fp_reason', 'remark'],
  },
  [DS_TAG_PRECISION]: {
    prodTags: 'real_data_tag_precision',
    prodSamples: 'real_data_tag_precision_samples',
    backupTags: 'publish_backup_real_data_tag_precision',
    backupSamples: 'publish_backup_real_data_tag_precision_samples',
    metaKey: 'data_updated_at_tag_precision',
    fieldStatusKey: 'field_link_status_tag_precision',
    datasetName: 'AI评测分析表（策略_标签）',
    // real_data_tag_precision 字段（不含 id，无 rank_no）
    tagsColumns: ['tag_id', 'tag_name', 'total', 'fp', 'precision_val', 'tp', 'fp_conf', 'tn', 'fn',
      'sample_count', 'first_level_industry_name', 'second_level_industry_name', 'element_type', 'element_type_name',
      'arrive_time', 'ds', 'model_version', 'element_fingerprint', 'remark', 'fp_reason'],
    // real_data_tag_precision_samples 字段（不含 id，有 reviewer_name，有 dc_id/ops_advertiser_name/element_fingerprint/ai_evaluate_reviewer_name）
    samplesColumns: ['tag_id', 'tag_name', 'sample_id', 'element_type', 'is_video',
      'policy_ids', 'ai_evaluate_policy_ids', 'first_level_industry_name', 'second_level_industry_name', 'media_url', 'ocr_content', 'asr_content',
      'uid', 'arrive_time', 'ds', 'is_fp', 'fp_reason', 'remark', 'class_num', 'class_id',
      'reviewer_name', 'dc_id', 'ops_advertiser_name', 'element_fingerprint', 'ai_evaluate_reviewer_name'],
  },
}

// 取服务器【本地时区】当前时间，格式化为 'YYYY-MM-DD HH:mm:ss'
// 直接用 new Date() 交给 mysql2 会按 UTC 序列化，东八区下可能跨日导致日期不对
function nowLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 通用：从指定表查询最晚 arrive_time（字符串日期）
async function getLatestArrive(tableName) {
  try {
    const rows = await query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${tableName}"`)
    const v = rows.length && rows[0].latest_arrive ? String(rows[0].latest_arrive) : ''
    return v.slice(0, 10)
  } catch {
    return ''
  }
}

// 通用：从指定表查询数据量
async function getTableCounts(tableName) {
  try {
    const rows = await query(`SELECT COUNT(*) AS cnt FROM "${tableName}"`)
    return rows.length ? Number(rows[0].cnt) : 0
  } catch {
    return 0
  }
}

// 通用：读取 data_meta 的元信息
async function readMeta(key) {
  const rows = await query('SELECT * FROM data_meta WHERE "key"=?', [key])
  if (rows.length) return rows[0]
  return null
}

// 通用：写入 data_meta
async function writeMeta(conn, key, value, by, at) {
  await conn.execute(
    `INSERT INTO data_meta ("key", value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT("key") DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [key, value || '', by, at]
  )
}

// 通用：清空正式表 + 正式元信息
async function clearProd(conn, ds) {
  const cfg = TABLE_MAP[ds]
  // cluster 的 prodTags 和 prodSamples 指向同一张表，去重避免重复执行
  const tables = [...new Set([cfg.prodTags, cfg.prodSamples])]
  for (const tbl of tables) {
    await conn.execute(`DELETE FROM "${tbl}"`)
  }
  await conn.execute('DELETE FROM data_meta WHERE "key"=?', [cfg.metaKey])
}

// 通用：TRUNCATE 清空正式表（上传全量替换专用）
// TRUNCATE 为 DDL：隐式提交、不逐行加锁、立即释放空间，速度远快于 DELETE，
// 避免大批量导入时"DELETE 全表长时间持锁 → 其他请求 Lock wait timeout"。
// 注意：必须在事务外调用（会隐式提交）；上传中途失败后表为空，符合全量替换语义。
async function truncateProd(conn, ds) {
  const cfg = TABLE_MAP[ds]
  const tables = [...new Set([cfg.prodTags, cfg.prodSamples])]
  for (const tbl of tables) {
    await conn.query(`TRUNCATE TABLE "${tbl}"`)
  }
  await conn.query('DELETE FROM data_meta WHERE "key"=?', [cfg.metaKey])
}

// 通用：备份当前正式表到 publish_backup_*（带 version_id）
async function backupProdToPublish(conn, ds, versionId) {
  const cfg = TABLE_MAP[ds]
  const tagsCols = cfg.tagsColumns
  const samplesCols = cfg.samplesColumns
  const tagsSelectList = tagsCols.join(', ')
  const samplesSelectList = samplesCols.join(', ')
  // cluster 的 prodTags/prodSamples 和 backupTags/backupSamples 分别指向同一张表，去重避免重复插入
  if (cfg.prodTags === cfg.prodSamples) {
    await conn.execute(
      `INSERT INTO "${cfg.backupTags}" (publish_version_id, ${tagsSelectList})
       SELECT ?, ${tagsSelectList} FROM "${cfg.prodTags}"`,
      [versionId]
    )
  } else {
    await conn.execute(
      `INSERT INTO "${cfg.backupTags}" (publish_version_id, ${tagsSelectList})
       SELECT ?, ${tagsSelectList} FROM "${cfg.prodTags}"`,
      [versionId]
    )
    await conn.execute(
      `INSERT INTO "${cfg.backupSamples}" (publish_version_id, ${samplesSelectList})
       SELECT ?, ${samplesSelectList} FROM "${cfg.prodSamples}"`,
      [versionId]
    )
  }
}

// 通用：从发布备份恢复数据到正式表（调用前需已清空正式表）
async function restoreBackupToProd(conn, ds, versionId) {
  const cfg = TABLE_MAP[ds]
  const tagsCols = cfg.tagsColumns
  const samplesCols = cfg.samplesColumns
  const tagsSelectList = tagsCols.join(', ')
  const samplesSelectList = samplesCols.join(', ')
  // cluster 的 prodTags/prodSamples 和 backupTags/backupSamples 分别指向同一张表，去重避免重复插入
  if (cfg.prodTags === cfg.prodSamples) {
    await conn.execute(
      `INSERT INTO "${cfg.prodTags}" (${tagsSelectList})
       SELECT ${tagsSelectList} FROM "${cfg.backupTags}" WHERE publish_version_id=?`,
      [versionId]
    )
  } else {
    await conn.execute(
      `INSERT INTO "${cfg.prodTags}" (${tagsSelectList})
       SELECT ${tagsSelectList} FROM "${cfg.backupTags}" WHERE publish_version_id=?`,
      [versionId]
    )
    await conn.execute(
      `INSERT INTO "${cfg.prodSamples}" (${samplesSelectList}) SELECT ${samplesSelectList} FROM "${cfg.backupSamples}" WHERE publish_version_id=?`,
      [versionId]
    )
  }
}

// 通用：写入导入历史
async function writeImportHistory(conn, fileName, datasetName, sampleCount, tagCount, precisionVal, fpCount, by, status, errorMessage) {
  await conn.execute(
    `INSERT INTO data_import_history (file_name, dataset_name, sample_count, tag_count, precision_val, fp_count, status, error_message, imported_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [fileName || '', datasetName, sampleCount || 0, tagCount || 0, precisionVal || 0, fpCount || 0, status || 'success', (errorMessage || '').slice(0, 1024), by || '']
  )
}

// ==================== 获取数据状态 ====================
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const aiEval = await buildProdMeta(DS_AI_EVAL)
    const tagPrecision = await buildProdMeta(DS_TAG_PRECISION)

    res.json({ aiEval, tagPrecision })
  } catch (e) { next(e) }
})

async function buildProdMeta(ds) {
  const cfg = TABLE_MAP[ds]
  let metaRows = await query('SELECT * FROM data_meta WHERE "key"=?', [cfg.metaKey])
  if (!metaRows.length) {
    metaRows = await query("SELECT * FROM data_meta WHERE \"key\"='data_updated_at'")
  }
  const dataTable = ds === DS_AI_EVAL ? cfg.prodSamples : cfg.prodTags
  const dataRows = await query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${dataTable}"`)
  const latestArrive = dataRows.length && dataRows[0].latest_arrive ? String(dataRows[0].latest_arrive) : ''
  const hasData = (await getTableCounts(dataTable)) > 0
  if (!metaRows.length && !hasData) {
    return { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
  }
  // 如果实际数据表已空，不管 metaRows 有没有 fallback 数据都返回空
  if (!hasData) {
    return { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
  }
  // 顶部「数据更新时间」= 数据里最近的业务时间（北京时间口径，YYYY-MM-DD），
  // 而非文件上传当天（避免「今天上传、数据实际更早」时被误显示为今天）。
  // 改用 JS 侧归一化求最大值：arrive_time 是 varchar，直接 MAX() 走字典序会算错。
  const { date: dataDate } = await safeMaxDateGlobal(dataTable)
  // 仅当表里确实解析不出业务时间时，回退到元信息里的上传时间
  // 注意：此前写成 `latestArrive || nowLocal()`（空表→显示今天），属错误回退，已修正
  const metaUpdatedAt = metaRows.length ? normDate(metaRows[0].updated_at) : ''
  // 「数据更新至」锚定为北京时间今天（YYYY-MM-DD）：mock 演示数据要求展示为今天。
  // 用 en-CA 的 Asia/Shanghai 时区格式化，直接取当地日期，避免 UTC+8 手动偏移在跨天后算出明天。
  // 且仅在数据确实有业务日期（非空表）时才锚定，空表依旧返回空，不用今天冒充。
  let todayCST = ''
  try {
    todayCST = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
  } catch {
    todayCST = normDate(new Date(Date.now() + 8 * 3600000).toISOString())
  }
  const displayUpdatedAt = dataDate ? todayCST : (metaUpdatedAt || '')
  return {
    updatedAt: displayUpdatedAt,
    updatedBy: metaRows.length ? metaRows[0].updated_by : '',
    fileName: metaRows.length ? metaRows[0].value : '',
    isDraft: false,
    draftCount: 0,
  }
}

// ==================== 发布历史（用于回滚选择） ====================
router.get('/publish-history', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT id, version, operator, published_at, source, note FROM publish_version ORDER BY published_at DESC LIMIT 20')
    res.json(rows.map(r => ({
      id: r.id,
      version: r.version,
      operator: r.operator,
      publishedAt: r.published_at ? String(r.published_at).slice(0, 19).replace('T', ' ') : '',
      source: r.source,
      note: r.note || '',
    })))
  } catch (e) { next(e) }
})

// ==================== 发布（创建当前线上数据快照，供回滚） ====================
// 草稿表机制已下线，上传即写正式表并立即生效；
// 此处「发布」仅登记一次发布版本快照（备份当前正式表到 publish_backup_*），
// 与「回滚上一版」配套，保留发布/回滚备份能力。
router.post('/publish', requireRole('admin'), async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.beginTransaction()

    // 判断当前正式表是否有数据可备份
    const aiEvalCount = await getTableCounts(TABLE_MAP[DS_AI_EVAL].prodTags)
    const tpCount = await getTableCounts(TABLE_MAP[DS_TAG_PRECISION].prodTags)
    if (!aiEvalCount && !tpCount) {
      await conn.rollback()
      conn.release()
      return res.status(400).json({ error: '当前正式表无数据，无法发布' })
    }

    const now = new Date()
    const [versionResult] = await conn.execute(
      'INSERT INTO publish_version (version, operator, published_at, source, note) VALUES (?,?,?,?,?)',
      [DS_ALL, by, now, 'draft', '发布当前线上数据（草稿表机制已下线）']
    )
    const versionId = versionResult.insertId

    if (aiEvalCount) await backupProdToPublish(conn, DS_AI_EVAL, versionId)
    if (tpCount) await backupProdToPublish(conn, DS_TAG_PRECISION, versionId)

    await conn.commit()
    await audit(req, '发布数据', `version=${versionId}`)
    setTimeout(() => { triggerClearCache() }, 1000)
    res.json({ ok: true, versionId, message: '已登记发布版本，可随时回滚' })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    next(e)
  } finally {
    conn.release()
  }
})

// ==================== 回滚到上一版 ====================
router.post('/publish/rollback', requireRole('admin'), async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    const { versionId } = req.body || {}
    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.beginTransaction()

    let targetVersionId = versionId
    if (!targetVersionId) {
      // 默认回滚到最新一次非 rollback 来源的版本
      const rows = await conn.execute(
        "SELECT id, version FROM publish_version WHERE source='draft' ORDER BY published_at DESC LIMIT 1"
      )
      if (!rows.length) {
        conn.release()
        return res.status(400).json({ error: '没有可回滚的版本' })
      }
      targetVersionId = rows[0].id
    }

    const [versionRows] = await conn.execute('SELECT * FROM publish_version WHERE id=?', [targetVersionId])
    if (!versionRows.length) {
      conn.release()
      return res.status(400).json({ error: '回滚版本不存在' })
    }
    const version = versionRows[0]

    // 判断该版本备份了哪些数据集
    const aiEvalBackupCount = (await conn.execute(
      'SELECT COUNT(*) AS cnt FROM publish_backup_real_data_tags WHERE publish_version_id=?',
      [targetVersionId]
    ))[0][0].cnt
    const tpBackupCount = (await conn.execute(
      'SELECT COUNT(*) AS cnt FROM publish_backup_real_data_tag_precision WHERE publish_version_id=?',
      [targetVersionId]
    ))[0][0].cnt

    if (!aiEvalBackupCount && !tpBackupCount) {
      conn.release()
      return res.status(400).json({ error: '该版本无备份数据，无法回滚' })
    }

    const now = new Date()
    // 创建回滚版本记录
    const [rollbackVersionResult] = await conn.execute(
      'INSERT INTO publish_version (version, operator, published_at, source, note) VALUES (?,?,?,?,?)',
      [version.version || DS_ALL, by, now, 'rollback', `回滚到版本 ${targetVersionId}`]
    )
    const rollbackVersionId = rollbackVersionResult.insertId

    // 备份当前正式数据到回滚版本（支持反回滚）
    if (aiEvalBackupCount) await backupProdToPublish(conn, DS_AI_EVAL, rollbackVersionId)
    if (tpBackupCount) await backupProdToPublish(conn, DS_TAG_PRECISION, rollbackVersionId)

    // 清空正式表并恢复备份
    if (aiEvalBackupCount) {
      await clearProd(conn, DS_AI_EVAL)
      await restoreBackupToProd(conn, DS_AI_EVAL, targetVersionId)
      await writeMeta(conn, TABLE_MAP[DS_AI_EVAL].metaKey, `回滚到版本${targetVersionId}`, by, now)
    }
    if (tpBackupCount) {
      await clearProd(conn, DS_TAG_PRECISION)
      await restoreBackupToProd(conn, DS_TAG_PRECISION, targetVersionId)
      await writeMeta(conn, TABLE_MAP[DS_TAG_PRECISION].metaKey, `回滚到版本${targetVersionId}`, by, now)
    }

    await conn.commit()
    await audit(req, '回滚数据', `version=${targetVersionId}`)

    setTimeout(() => {
      triggerClearCache()
    }, 1000)

    res.json({ ok: true, versionId: rollbackVersionId, message: `已成功回滚到版本 ${targetVersionId}` })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    next(e)
  } finally {
    conn.release()
  }
})

// ==================== 上传接口 ====================

// 设置数据更新时间（已弃用，保留向后兼容）
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    res.json({ ok: true, warning: '该接口已弃用，请使用上传/发布流程' })
  } catch (e) { next(e) }
})

// 获取导入历史记录（所有登录用户均可读）
router.get('/history', requireLogin, async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM data_import_history ORDER BY imported_at DESC LIMIT 50')
    res.json(rows.map(r => ({
      id: r.id,
      fileName: r.file_name,
      datasetName: r.dataset_name,
      sampleCount: r.sample_count,
      tagCount: r.tag_count,
      precisionVal: Number(r.precision_val),
      fpCount: r.fp_count,
      status: r.status,
      errorMessage: r.error_message || '',
      importedBy: r.imported_by,
      importedAt: r.imported_at ? String(r.imported_at).slice(0, 19).replace('T', ' ') : '',
    })))
  } catch (e) { next(e) }
})

// 管理员上传解析后的完整数据 → 写入正式表
router.post('/upload', requireRole('admin'), async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { tags, samples, fileName } = req.body
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    if (!Array.isArray(tags) || !tags.length) {
      conn.release()
      return res.status(400).json({ error: '缺少标签数据' })
    }

    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.beginTransaction()

    const cfg = TABLE_MAP[DS_AI_EVAL]
    // 清空旧数据
    await clearProd(conn, DS_AI_EVAL)

    // 写入标签聚合
    for (const t of tags) {
      await conn.execute(
        `INSERT INTO "${cfg.prodTags}" (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason)
         VALUES (?,?,?,?,?,?,?,?)`,
        [t.id || 0, t.name || '', t.total || 0, t.fp || 0, t.precision || 0, t.rank || 0, t.remark || '', t.fpReason || '']
      )
    }

    // 写入样本明细
    if (Array.isArray(samples) && samples.length) {
      const BATCH = 2000
      for (let i = 0; i < samples.length; i += BATCH) {
        const batch = samples.slice(i, i + BATCH)
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
        const values = batch.flatMap(s => {
          const mt = String(s.machineTag || '').replace(/[\[\]]/g, '') || String(s.tagId || '')
          const ht = String(s.humanTag || '').replace(/[\[\]]/g, '')
          return [
            s.tagId || 0, s.tagName || '', s.id || '', s.elementFingerprint || s.fingerprint || '',
            s.dcId || '', s.type || '', s.isVideo ? 1 : (s.type === '视频' || s.elementType === 'ELEMENT_TYPE_VIDEO' || s.elementTypeName === '视频') ? 1 : 0,
            mt, ht, s.industryL1 || '', s.industryL2 || '',
            s.mediaUrl || '', s.ocrContent || '', s.asrContent || '', s.classNum || 0, s.classId || '', s.uid || '',
            s.opsAdvertiserName || '', s.reviewerName || '',
            s.arriveTime || '', s.ds || '', s.isFp ? 1 : 0, s.fpReason || '', s.remark || '',
          ]
        })
        await conn.execute(
        `INSERT INTO "${cfg.prodSamples}" (tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name, ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason, remark) VALUES ${placeholders}`,
          values
        )
      }
    }

    // 记录元信息
    const [sampleRows] = await conn.query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${cfg.prodSamples}"`)
    const latestArrive = sampleRows[0] && sampleRows[0].latest_arrive ? sampleRows[0].latest_arrive : new Date()
    // 修正：空数据不得拿「当前时间」冒充业务时间（曾导致顶部更新时间显示为今天）
    const metaUpdatedAt = normDate(latestArrive) || ''
    await writeMeta(conn, cfg.metaKey, fileName || '', by, metaUpdatedAt)

    // 写入导入历史
    const sampleCount = samples?.length || 0
    const precisionVal = tags.length ? Number((tags.reduce((s, t) => s + (t.precision || 0) * (t.total || 0), 0) / Math.max(1, tags.reduce((s, t) => s + (t.total || 0), 0))).toFixed(1)) : 0
    const fpCount = tags.reduce((s, t) => s + (t.fp || 0), 0)
    await writeImportHistory(conn, fileName || '', cfg.datasetName, sampleCount, tags.length, precisionVal, fpCount, by, 'success')

    await conn.commit()
    await audit(req, '上传数据', fileName || '')
    res.json({ ok: true, tagCount: tags.length, sampleCount, message: '数据已写入正式表，立即生效' })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore rollback error */ }
    next(e)
  } finally {
    conn.release()
  }
})

// ==================== 分批上传接口：写入草稿表 ====================
const _uploadSessions = new Map()
const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000
setInterval(async () => {
  const now = Date.now()
  for (const [id, session] of _uploadSessions.entries()) {
    if (now - session.createdAt > UPLOAD_SESSION_TTL_MS) {
      try { await session.conn.rollback() } catch { /* ignore */ }
      try { session.conn.release() } catch { /* ignore */ }
      _uploadSessions.delete(id)
      console.warn(`[upload-session] 会话 ${id} 超时未完成，已自动回滚释放`)
      writeFailedHistory(session.fileName, 'AI评测明细数据（草稿）', session.tagCount, 0, session.by, '上传会话超时（超20分钟未完成）')
    }
  }
}, 60 * 1000)

async function writeFailedHistory(fileName, datasetName, tagCount, sampleCount, importedBy, errorMessage) {
  try {
    const conn = await pool.getConnection()
    await conn.execute(
      `INSERT INTO data_import_history (file_name, dataset_name, sample_count, tag_count, precision_val, fp_count, status, error_message, imported_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [fileName || '', datasetName, sampleCount, tagCount, 0, 0, 'failed', (errorMessage || '未知错误').slice(0, 1024), importedBy || '']
    )
    conn.release()
  } catch { /* 写入失败记录对主流程无影响 */ }
}

router.post('/upload-init', requireRole('admin'), async (req, res, next) => {
  let conn
  try {
    const { tags, fileName, meta } = req.body
    if (!Array.isArray(tags) || !tags.length) {
      return res.status(400).json({ error: '缺少标签数据' })
    }

    conn = await pool.getConnection()
    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.execute('SET SESSION innodb_lock_wait_timeout = 120')

    // 清理所有残留的活跃上传会话：旧会话 conn 持有未提交事务（行锁），
    // 会阻塞本次清空/插入导致 Lock wait timeout，先统一回滚释放
    for (const [id, old] of _uploadSessions.entries()) {
      try { await old.conn.rollback() } catch { /* ignore */ }
      try { old.conn.release() } catch { /* ignore */ }
      _uploadSessions.delete(id)
      console.warn(`[upload-session] 会话 ${id} 被新上传取代，已回滚释放`)
    }

    const cfg = TABLE_MAP[DS_AI_EVAL]
    // 清空旧数据：TRUNCATE 在事务外执行（隐式提交、不持行锁），避免 DELETE 全表长时间持锁
    await truncateProd(conn, DS_AI_EVAL)

    await conn.beginTransaction()

    // 写入标签聚合
    for (const t of tags) {
      await conn.execute(
        `INSERT INTO "${cfg.prodTags}" (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason)
         VALUES (?,?,?,?,?,?,?,?)`,
        [t.id || 0, t.name || '', t.total || 0, t.fp || 0, t.precision || 0, t.rank || 0, t.remark || '', t.fpReason || '']
      )
    }

    const uploadId = `u${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    _uploadSessions.set(uploadId, {
      conn, fileName: fileName || '', by, tagCount: tags.length, meta: meta || {}, sampleCount: 0, createdAt: Date.now(),
      cfg,
    })

    res.json({ ok: true, uploadId, tagCount: tags.length })
  } catch (e) {
    if (conn) { try { await conn.rollback() } catch {} conn.release() }
    next(e)
  }
})

router.post('/upload-batch', requireRole('admin'), async (req, res, next) => {
  const { uploadId, samples } = req.body
  const session = uploadId ? _uploadSessions.get(uploadId) : null
  if (!session) return res.status(400).json({ error: '上传会话不存在或已过期，请重新上传' })
  if (!Array.isArray(samples) || !samples.length) {
    return res.json({ ok: true, uploaded: session.sampleCount })
  }

  try {
    const { conn, cfg } = session
    const BATCH = 5000
    for (let i = 0; i < samples.length; i += BATCH) {
      const batch = samples.slice(i, i + BATCH)
      const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
      const values = batch.flatMap(s => {
        const mt = String(s.machineTag || '').replace(/[\[\]]/g, '') || String(s.tagId || '')
        const ht = String(s.humanTag || '').replace(/[\[\]]/g, '')
        return [
          s.tagId || 0, s.tagName || '', s.id || '', s.elementFingerprint || s.fingerprint || '',
          s.dcId || '', s.type || '', s.isVideo ? 1 : (s.type === '视频' || s.elementType === 'ELEMENT_TYPE_VIDEO' || s.elementTypeName === '视频') ? 1 : 0,
          mt, ht, s.industryL1 || '', s.industryL2 || '',
          s.mediaUrl || '', s.ocrContent || '', s.asrContent || '', s.classNum || 0, s.classId || '', s.uid || '',
          s.opsAdvertiserName || '', s.reviewerName || '',
          s.arriveTime || '', s.ds || '', s.isFp ? 1 : 0, s.fpReason || '', s.remark || '',
        ]
      })
      await conn.execute(
        `INSERT INTO "${cfg.prodSamples}" (tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name, ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason, remark) VALUES ${placeholders}`,
        values
      )
    }
    session.sampleCount += samples.length
    res.json({ ok: true, uploaded: session.sampleCount })
  } catch (e) {
    const backup = { fileName: session.fileName, tagCount: session.tagCount, sampleCount: session.sampleCount, by: session.by }
    try { await session.conn.rollback() } catch {}
    session.conn.release()
    _uploadSessions.delete(uploadId)
    writeFailedHistory(backup.fileName, 'AI评测明细数据', backup.tagCount, backup.sampleCount, backup.by, e.message || '批次上传失败')
    next(e)
  }
})

router.post('/upload-finalize', requireRole('admin'), async (req, res, next) => {
  const { uploadId } = req.body
  const session = uploadId ? _uploadSessions.get(uploadId) : null
  if (!session) return res.status(400).json({ error: '上传会话不存在或已过期' })

  try {
    const { conn, fileName, by, tagCount, meta, cfg } = session

    const [sampleRows] = await conn.query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${cfg.prodSamples}"`)
    const latestArrive = sampleRows[0] && sampleRows[0].latest_arrive ? sampleRows[0].latest_arrive : new Date()
    // 修正：空数据不得拿「当前时间」冒充业务时间（曾导致顶部更新时间显示为今天）
    const metaUpdatedAt = normDate(latestArrive) || ''
    await writeMeta(conn, cfg.metaKey, fileName || '', by, metaUpdatedAt)

    const sampleCount = session.sampleCount
    const precisionVal = tagCount && meta.total ? Number((meta.hit / meta.total * 100).toFixed(1)) : 0
    const fpCount = meta.fpCount || (meta.total ? meta.total - meta.hit : 0)
    await writeImportHistory(conn, fileName || '', cfg.datasetName, sampleCount, tagCount, precisionVal, fpCount, by, 'success')

    await conn.commit()
    conn.release()
    _uploadSessions.delete(uploadId)

    await audit(req, '上传数据(分批)', fileName || '')
    res.json({ ok: true, tagCount, sampleCount, message: '数据已写入正式表，立即生效' })
  } catch (e) {
    const backup = { fileName: session.fileName, tagCount: session.tagCount, sampleCount: session.sampleCount, by: session.by }
    try { await session.conn.rollback() } catch {}
    session.conn.release()
    _uploadSessions.delete(uploadId)
    writeFailedHistory(backup.fileName, 'AI评测明细数据', backup.tagCount, backup.sampleCount, backup.by, e.message || '提交事务失败')
    next(e)
  }
})

router.post('/upload-abort', requireRole('admin'), async (req, res, next) => {
  const { uploadId } = req.body
  const session = uploadId ? _uploadSessions.get(uploadId) : null
  if (!session) return res.json({ ok: true })
  try { await session.conn.rollback() } catch {}
  session.conn.release()
  _uploadSessions.delete(uploadId)
  res.json({ ok: true })
})

// ==================== AI评测分析表（策略_标签）数据集上传 → 写入正式表 ====================
router.post('/upload-precision', requireRole('admin'), async (req, res, next) => {
  const conn = await pool.getConnection()
  const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
  try {
    const { tags, samples, fileName } = req.body
    if (!Array.isArray(tags) || !tags.length) {
      conn.release()
      return res.status(400).json({ error: '缺少标签精度数据' })
    }

    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.execute('SET SESSION innodb_lock_wait_timeout = 120')

    const cfg = TABLE_MAP[DS_TAG_PRECISION]
    // TRUNCATE 在事务外执行（隐式提交、不持行锁），避免 DELETE 全表长时间持锁导致 Lock wait timeout
    await truncateProd(conn, DS_TAG_PRECISION)

    await conn.beginTransaction()

    // 写入标签精度数据
    for (const t of tags) {
      await conn.execute(
        `INSERT INTO "${cfg.prodTags}" (tag_id, tag_name, total, fp, precision_val, tp, fp_conf, tn, fn, sample_count, first_level_industry_name, second_level_industry_name, element_type, element_type_name, arrive_time, ds, model_version, element_fingerprint, remark, fp_reason, review_model_precision_prime)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [t.id || 0, t.name || '', t.total || 0, t.fp || 0, t.precision || 0,
         t.tp || 0, t.fpConf || 0, t.tn || 0, t.fn || 0, t.sampleCount || 0,
         t.industryL1 || '', t.industryL2 || '', t.elementType || '', t.elementTypeName || '',
         t.arriveTime || null, t.ds || '', t.modelVersion || '', t.elementFingerprint || '',
         t.remark || '', t.fpReason || '',
         (t.reviewModelPrecisionPrime === undefined || t.reviewModelPrecisionPrime === null || t.reviewModelPrecisionPrime === '') ? null : t.reviewModelPrecisionPrime]
      )
    }

    // 写入样本明细（可选）
    if (Array.isArray(samples) && samples.length) {
      const BATCH = 5000
      for (let i = 0; i < samples.length; i += BATCH) {
        const batch = samples.slice(i, i + BATCH)
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
        const values = batch.flatMap(s => {
          const mt = String(s.machineTag || '').replace(/[\[\]]/g, '') || String(s.tagId || '')
          const ht = String(s.humanTag || '').replace(/[\[\]]/g, '')
          return [
            s.tagId || 0, s.tagName || '', s.id || '', s.type || '', s.isVideo ? 1 : 0,
            mt, ht, s.industryL1 || '', s.industryL2 || '',
          s.mediaUrl || '', s.ocrContent || '', s.asrContent || '', s.classNum || 0, s.uid || '',
          s.arriveTime || '', s.ds || '', s.isFp ? 1 : 0, s.fpReason || '', s.remark || '',
          s.dcId || '', s.opsAdvertiserName || '', s.elementFingerprint || '', s.reviewerName || '',
        ]
        })
        await conn.execute(
          `INSERT INTO "${cfg.prodSamples}" (tag_id, tag_name, sample_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, uid, arrive_time, ds, is_fp, fp_reason, remark, dc_id, ops_advertiser_name, element_fingerprint, ai_evaluate_reviewer_name) VALUES ${placeholders}`,
          values
        )
      }
    }

    // 记录元信息：优先取数据中最晚 arrive_time（数据业务时间），为空时用上传操作时间
    const [tpRows] = await conn.query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${cfg.prodTags}"`)
    const latestArrive = tpRows[0] && tpRows[0].latest_arrive ? tpRows[0].latest_arrive : new Date()
    // 修正：空数据不得拿「当前时间」冒充业务时间（曾导致顶部更新时间显示为今天）
    const metaUpdatedAt = normDate(latestArrive) || ''
    await writeMeta(conn, cfg.metaKey, fileName || '', by, metaUpdatedAt)

    // 写入导入历史
    const sampleCount = (Array.isArray(samples) && samples.length) ? samples.length : tags.reduce((s, t) => s + (t.total || 0), 0)
    const precisionVal = tags.length ? Number((tags.reduce((s, t) => s + (t.precision || 0) * (t.total || 0), 0) / Math.max(1, tags.reduce((s, t) => s + (t.total || 0), 0))).toFixed(1)) : 0
    const fpCount = tags.reduce((s, t) => s + (t.fp || 0), 0)
    await writeImportHistory(conn, fileName || '', cfg.datasetName, sampleCount, tags.length, precisionVal, fpCount, by, 'success')

    await conn.commit()
    await audit(req, '上传策略标签精度数据', fileName || '')
    res.json({ ok: true, tagCount: tags.length, sampleCount, message: '数据已写入正式表，立即生效' })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore rollback error */ }
    writeFailedHistory(fileName || '', 'AI评测分析表（策略_标签）', (tags || []).length, (samples || []).length, by, e.message || '数据导入失败')
    next(e)
  } finally {
    conn.release()
  }
})

// 获取策略标签精度数据列表
router.get('/precision-tags', requireLogin, async (req, res, next) => {
  try {
    // 精度计算优先级：tp/(tp+fp) → precision_val → tp/total → 0
    // 这样即使历史数据 tp/fp 为0但上传时存了 precision_val，也能正确显示
    const rows = await query(`SELECT tag_id AS id, tag_name AS name, total, fp,
      COALESCE(
        ROUND(tp * 100.0 / NULLIF(tp + fp, 0), 1),
        ROUND(precision_val, 1),
        ROUND(tp * 100.0 / NULLIF(total, 0), 1),
        ROUND((total - fp) * 100.0 / NULLIF(total, 0), 1),
        0
      ) AS \`precision\`, tp, fp_conf AS fpConf, tn, fn, sample_count AS sampleCount, first_level_industry_name AS industryL1, second_level_industry_name AS industryL2, element_type AS elementType, element_type_name AS elementTypeName, arrive_time AS arriveTime, ds, model_version AS modelVersion, element_fingerprint AS elementFingerprint, remark, fp_reason AS fpReason,
      review_model_precision_prime AS reviewModelPrecisionPrime FROM real_data_tag_precision ORDER BY \`precision\` DESC`)
    return res.json(rows)
  } catch (e) { next(e) }
})

// 获取策略标签下的样本明细
router.get('/precision-tags/:id/samples', requireLogin, async (req, res, next) => {
  try {
    const rows = await query(`SELECT sample_id AS id, element_type AS type, is_video AS isVideo, policy_ids AS machineTag, ai_evaluate_policy_ids AS humanTag,
       first_level_industry_name AS industryL1, second_level_industry_name AS industryL2, media_url AS mediaUrl, ocr_content AS ocrContent,
       asr_content AS asrContent, uid, arrive_time AS arriveTime, ds, is_fp AS isFp, fp_reason AS fpReason, remark,
       COALESCE(NULLIF(dc_id, ''), '') AS dcId,
       COALESCE(NULLIF(ops_advertiser_name, ''), '') AS opsAdvertiserName,
       COALESCE(NULLIF(element_fingerprint, ''), '') AS elementFingerprint,
       COALESCE(NULLIF(reviewer_name, ''), NULLIF(ai_evaluate_reviewer_name, ''), '') AS reviewerName
       FROM real_data_tag_precision_samples WHERE tag_id=? ORDER BY id`,
      [req.params.id]
    )
    const _tagIdStr = `${req.params.id}`
    for (const r of rows) {
      if (r.machineTag) r.machineTag = String(r.machineTag).replace(/[\[\]]/g, '')
      if (r.humanTag) r.humanTag = String(r.humanTag).replace(/[\[\]]/g, '')
      if (!r.machineTag || String(r.machineTag).trim() === '') r.machineTag = _tagIdStr
    }
    return res.json(rows)
  } catch (e) { next(e) }
})

// ==================== 删除已上传数据（正式表 + 草稿表 同时清空） ====================
router.delete('/', requireRole('admin'), async (req, res, next) => {
  const conn = await pool.getConnection()
  const type = normalizeDataset(req.query.type)
  try {
    await conn.beginTransaction()

    const datasetNames = []

    if (type === DS_AI_EVAL || type === DS_ALL) {
      await conn.execute('DELETE FROM real_data_tags')
      await conn.execute('DELETE FROM real_data_samples')
      await conn.execute('DELETE FROM data_meta WHERE "key"=?', [TABLE_MAP[DS_AI_EVAL].metaKey])
      datasetNames.push(TABLE_MAP[DS_AI_EVAL].datasetName)
    }

    if (type === DS_TAG_PRECISION || type === DS_ALL) {
      await conn.execute('DELETE FROM real_data_tag_precision')
      await conn.execute('DELETE FROM real_data_tag_precision_samples')
      await conn.execute('DELETE FROM data_meta WHERE "key"=?', [TABLE_MAP[DS_TAG_PRECISION].metaKey])
      datasetNames.push(TABLE_MAP[DS_TAG_PRECISION].datasetName)
    }

    await conn.commit()

    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    const label = type === DS_ALL ? '全部数据' : datasetNames.join('、')
    await audit(req, '删除已上传数据', label)
    res.json({ ok: true, message: `${label}已清空`, type })
  } catch (e) {
    try { await conn.rollback() } catch { /* ignore */ }
    next(e)
  } finally {
    conn.release()
  }
})

// ==================== 字段关联状态持久化 ====================
router.get('/field-status', requireLogin, async (req, res, next) => {
  try {
    const ds = normalizeDataset(req.query.dataset)
    const key = ds === DS_TAG_PRECISION ? TABLE_MAP[DS_TAG_PRECISION].fieldStatusKey : TABLE_MAP[DS_AI_EVAL].fieldStatusKey
    let rows = await query('SELECT value FROM data_meta WHERE "key"=?', [key])
    if (!rows.length) {
      rows = await query("SELECT value FROM data_meta WHERE \"key\"='field_link_status'")
    }
    if (!rows.length) return res.json({ fieldStatus: {} })
    try {
      return res.json({ fieldStatus: JSON.parse(rows[0].value) })
    } catch {
      return res.json({ fieldStatus: {} })
    }
  } catch (e) { next(e) }
})

router.post('/field-status', requireRole('admin'), async (req, res, next) => {
  try {
    const { fieldStatus, dataset } = req.body
    const ds = normalizeDataset(dataset)
    const key = ds === DS_TAG_PRECISION ? TABLE_MAP[DS_TAG_PRECISION].fieldStatusKey : TABLE_MAP[DS_AI_EVAL].fieldStatusKey
    const json = JSON.stringify(fieldStatus || {})
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    await query(
      `INSERT INTO data_meta ("key", value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [key, json, by, new Date().toISOString()]
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ==================== 合并上传（文件直传，根治前端 OOM） ====================
// 2026-08-31 新增：前端只上传原始文件 → 后端解析 + 聚合 + 与正式表合并（增量追加，不再 TRUNCATE）
// 重复行（sample_key 已存在）不重复写入，避免反复上传同一文件导致数据翻倍。
// 旧数据永久保留，满足"上传新数据后与历史数据合并成整份"的需求。
// 传输方式：前端以 XMLHttpRequest 直接发送文件二进制流（content-type: application/octet-stream），
// 后端用 express.raw 接收 Buffer；dataset / fileName 等元信息走 query 参数（避免引入 multer 依赖）。
import ExcelJS from 'exceljs'

// 字段别名映射（与前端 DataManageView.vue 的 COL_ALIAS 保持一致）
const COL_ALIAS = {
  id: ['标签id', '标签ID', 'tagid', 'tag_id', 'id', '标签编号', 'policy_id', 'policyid'],
  name: ['标签名', '标签名称', 'name', 'tagname', 'tag_name', '名称', 'policy_name', 'policyname'],
  machine: ['policy_ids', '审核标签ID', '审核标签id', '机审标签ID', '机审标签id', '机审标签', '机器标签', '机审', 'machine', '机审policy', 'policyids', '机审id'],
  human: ['ai_evaluate_policy_ids', 'AI评测人审标签', 'ai评测人审标签', '评测人审标签', '人审标签ID', '人审标签id', '人审标签', 'ai_evaluate_policy_id', '人审', 'human', '复审标签', 'ai_policy_ids', 'aipolicy', '人审id'],
  industryL1: ['first_level_industry_name', 'ams一级行业', '一级行业', 'industry_l1', 'industryl1', 'ams_l1', '一级行业(ams)', '行业一级', 'AMS一级开户行业ID(短id)', 'AMS一级开户行业ID（短id）', 'AMS一级行业名称(开户行业)', 'AMS一级行业名称（开户行业）', 'AMS一级行业名称', 'AMS一级行业', 'ams一级行业名称', 'ams一级行业名称(开户行业)'],
  industryL2: ['second_level_industry_name', 'ams二级行业', '二级行业', 'industry_l2', 'industryl2', 'ams_l2', '二级行业(ams)', '行业二级', 'AMS二级开户行业ID(长id)', 'AMS二级开户行业ID（长id）', 'AMS二级行业名称(开户行业)', 'AMS二级行业名称（开户行业）', 'AMS二级行业名称', 'AMS二级行业', 'ams二级行业名称', 'ams二级行业名称(开户行业)'],
  elementType: ['element_type', '审核元素类型', '素材类型', '物料类型', '内容类型', '类型', 'elementtype'],
  elementTypeName: ['element_type_name', '元素类型名称', '审核元素类型（翻译后）', '审核元素类型(翻译后)', '审核元素类型翻译后', 'elementtypename', '元素类型', '审核元素类型/审核元素类型(翻译后)'],
  classNum: ['class_num', '聚类类型', 'classnum', '聚类', '聚类编号', 'cluster'],
  classId: ['class_id', 'classid', '聚类ID', '聚类id', 'cluster_id', 'clusterid'],
  mediaUrl: ['element_value', '审核元素值', '元素值', '媒体链接', '素材链接', 'media_url', 'mediaurl', '素材url', 'url', '链接'],
  ocrContent: ['ocr_text', 'ocr_test', 'ocr内容', 'ocr', 'ocr_content', 'ocrcontent', 'ocrtext', 'ocrtest', '文字内容', '文本内容'],
  asrContent: ['asr_text', 'asr_test', 'ars_text', 'ars_test', 'asr内容', 'asr', 'asr_content', 'asrcontent', 'asrtext', 'asrtest', 'ars', 'arscontent', '语音内容', '音频内容'],
  advertiser: ['ops_advertiser_name', '广告主', 'advertiser', 'ad_name', '广告主名称', '客户主体名称', '客户主体名称(ops)', '客户主体名称(OPS)'],
  arriveTime: ['arrive_time', '到达时间', 'arrivetime', '入库时间', '时间', '评测时间', '数据时间', '统计时间', '采样时间', '审核时间'],
  ds: ['ds', '日期分区', '日期', 'date', '数据日期', '统计日期', 'partition_date', 'partitiondate', '分区日期', '业务日期'],
  dc_id: ['dc_id', '创意id', '创意ID', 'dcid', '创意编号', '创意ID(DCID)'],
  uid: ['uid', '广告主id', '广告主ID', '广告主编号', '广告主uid'],
  modelVersion: ['model_version', '模型版本', '机审版本', '版本号', 'modelversion'],
  ai_evaluate_reviewer_name: ['ai_evaluate_reviewer_name', '审核人', '评测人', '人审人员', '审核人员'],
  elementFingerprint: ['element_fingerprint', '审核物理指纹', '物理指纹', '指纹', 'md5', '素材指纹', 'elementfingerprint', '审核物理指纹（md5）', '审核物理指纹(md5)'],
}

// 模糊关键词匹配兜底
const FUZZY_KEYWORDS = {
  machine: ['policy_ids', '机审', '审核标签', '机器标签', 'machine_tag', 'machine_label'],
  human: ['ai_evaluate', '人审', 'ai评测', '复审', 'human_tag', 'human_label', '评测人审'],
}

function _pickCol(row, keys, fuzzyKey) {
  const lower = {}
  for (const k of Object.keys(row)) lower[String(k).trim().toLowerCase()] = row[k]
  for (const a of keys) { const v = lower[a.toLowerCase()]; if (v !== undefined && v !== '') return v }
  if (fuzzyKey && FUZZY_KEYWORDS[fuzzyKey]) {
    for (const colName of Object.keys(lower)) {
      const cn = colName.toLowerCase()
      for (const kw of FUZZY_KEYWORDS[fuzzyKey]) {
        if (cn.includes(kw.toLowerCase())) { const v = lower[colName]; if (v !== undefined && v !== '') return v }
      }
    }
  }
  return ''
}

function _parseIds(s) {
  return String(s || '').replace(/["'[\]\s]/g, '').split(/[,，、;；|]/).filter(Boolean).map(Number).filter(n => !Number.isNaN(n))
}

function _formatArriveTime(val) {
  if (!val) return ''
  const s = String(val).trim()
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s.slice(0, 10)
  const num = Number(s)
  if (!isNaN(num) && num > 30000 && num < 100000) {
    const ms = (num - 25569) * 86400 * 1000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return s
}

// 归一化去重键：ai-eval 用 标签 + (物理指纹 > 元素值 > sample_id)；tag-precision 用 标签 + sample_id
function buildSampleKey(ds, tagId, sample) {
  if (ds === DS_TAG_PRECISION) {
    return `${tagId}|${sample.sampleId || ''}`
  }
  const fp = String(sample.elementFingerprint || '').trim()
  const url = String(sample.mediaUrl || '').trim()
  const sid = String(sample.sampleId || '').trim()
  return `${tagId}|${fp || url || sid}`
}

// 解析文件为行对象数组（复刻前端 extractFirstNonEmptySheetRows + parseDelimitedText）
async function parseFileToRows(buf, originalname) {
  const ext = '.' + (originalname.split('.').pop() || '').toLowerCase()
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  const diag = { columns: [], ext, sheetName: '' }
  if (ext === '.json') {
    const arr = JSON.parse(buf.toString('utf-8'))
    const list = Array.isArray(arr) ? arr : (arr.data || [])
    if (list.length && typeof list[0] === 'object' && list[0] !== null) diag.columns = Object.keys(list[0])
    return { rows: Array.isArray(list) ? list : [], diag }
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    const text = buf.toString('utf-8')
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    if (!lines.length) return []
    const delimiter = ext === '.tsv' ? '\t' : ','
    const header = lines[0].split(delimiter).map(h => h.trim())
    const rows = []
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim().length) continue
      const cells = lines[i].split(delimiter)
      const obj = {}
      header.forEach((h, idx) => { obj[h] = (cells[idx] != null ? cells[idx] : '').trim() })
      rows.push(obj)
    }
    diag.columns = header
    return { rows, diag }
  }
  // xlsx / xls
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  for (const ws of wb.worksheets) {
    // 先把整张表读成二维数组，再自动探测真正的表头行
    const grid = []
    ws.eachRow((row) => {
      const vals = row.values.slice(1).map(v => (v == null ? '' : String(v).trim()))
      grid.push(vals)
    })
    const probe = pickHeaderRow(grid)
    if (!probe) continue
    const header = probe.header
    const rows = []
    for (let i = probe.headerIndex + 1; i < grid.length; i++) {
      const vals = grid[i]
      if (!vals || !vals.some(v => v !== '')) continue
      const obj = {}
      header.forEach((h, idx) => { obj[h] = vals[idx] || '' })
      rows.push(obj)
    }
    if (rows.length) {
      diag.columns = header
      diag.sheetName = ws.name
      diag.headerIndex = probe.headerIndex
      diag.skippedRows = probe.headerIndex
      return { rows, diag }
    }
  }
  // 所有 sheet 都读不到数据：把首个 sheet 的前几行原样带回去，便于一眼定位
  const firstWs = wb.worksheets[0]
  if (firstWs) {
    const sample = []
    firstWs.eachRow((row, rowNumber) => {
      if (sample.length >= 5) return
      sample.push(row.values.slice(1).map(v => (v == null ? '' : String(v).trim())))
    })
    diag.sampleRows = sample
    diag.sheetName = firstWs.name
    diag.totalSheetRows = firstWs.rowCount
  }
  return { rows: [], diag }
}

// 自动探测真正的表头行：跳过文件顶部的标题行/说明行/空行
// 判定标准：某一行非空单元格数量最多、且其后仍有数据行 → 视为表头
function pickHeaderRow(grid) {
  if (!Array.isArray(grid) || !grid.length) return null
  const nonEmptyCount = (arr) => arr.filter(v => v !== '').length
  let best = null
  const limit = Math.min(grid.length, 30)
  for (let i = 0; i < limit; i++) {
    const vals = grid[i]
    if (!Array.isArray(vals)) continue
    const n = nonEmptyCount(vals)
    if (n < 2) continue
    // 表头行下面必须还有至少一行数据
    const hasData = grid.slice(i + 1).some(r => Array.isArray(r) && nonEmptyCount(r) >= 2)
    if (!hasData) continue
    if (!best || n > best.count) best = { headerIndex: i, count: n, header: vals }
  }
  return best
}

// ==================== 分片上传（绕过网关 body size 限制）====================
// 前端把大文件切成 ≤2MB 的分片依次上传，后端拼接为完整文件后复用 /upload-file 的解析+入库逻辑
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'

const _chunkUploads = new Map() // uploadId -> { filePath, dataset, fileName, user, createdAt }
const CHUNK_UPLOAD_TTL = 10 * 60 * 1000 // 10 分钟过期

// 定期清理过期的临时文件
setInterval(() => {
  const now = Date.now()
  for (const [id, info] of _chunkUploads) {
    if (now - info.createdAt > CHUNK_UPLOAD_TTL) {
      fsp.unlink(info.filePath).catch(() => {})
      _chunkUploads.delete(id)
    }
  }
}, 60_000)

// 初始化分片上传
router.post('/upload-chunk-init', requireRole('admin'), (req, res) => {
  const uploadId = crypto.randomUUID()
  const tmpDir = os.tmpdir()
  const filePath = `${tmpDir}/fp-upload-${uploadId}`
  const ds = req.query.dataset || req.body?.dataset || 'ai-eval'
  const fileName = decodeURIComponent(req.query.fileName || req.body?.fileName || '未命名文件')
  _chunkUploads.set(uploadId, {
    filePath,
    dataset: ds,
    fileName,
    user: req.currentUser?.name || req.currentUser?.eng || '管理员',
    createdAt: Date.now(),
  })
  res.json({ ok: true, uploadId })
})

// 接收单个分片（按顺序追加）
router.post('/upload-chunk',
  expressRaw({ type: 'application/octet-stream', limit: '4mb' }),
  requireRole('admin'),
  async (req, res) => {
    const uploadId = req.query.uploadId || req.headers['x-upload-id']
    const info = _chunkUploads.get(uploadId)
    if (!info) return res.status(400).json({ error: '无效的 uploadId，可能已过期' })
    if (!req.body || !req.body.length) return res.status(400).json({ error: '空分片' })
    try {
      await fsp.appendFile(info.filePath, req.body)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: '写入分片失败: ' + e.message })
    }
  }
)

// 完成分片上传 → 读取拼接文件 → 通过内部 HTTP 调用 /upload-file 完成解析+入库
router.post('/upload-chunk-finalize', requireRole('admin'), async (req, res) => {
  const uploadId = req.query.uploadId || req.body?.uploadId
  const info = _chunkUploads.get(uploadId)
  if (!info) return res.status(400).json({ error: '无效的 uploadId，可能已过期' })
  try {
    const fileBuffer = await fsp.readFile(info.filePath)
    if (!fileBuffer.length) return res.status(400).json({ error: '未收到文件数据' })

    // 清理临时文件和记录
    fsp.unlink(info.filePath).catch(() => {})
    _chunkUploads.delete(uploadId)

    // 通过本地 loopback HTTP 调用 /upload-file，完全复用已有逻辑，不做函数抽取
    const port = Number(process.env.PORT || 8787)
    const qs = new URLSearchParams({ dataset: info.dataset, fileName: encodeURIComponent(info.fileName) })
    // 转发认证头（identify 中间件使用 x-user-eng / x-user-name / x-user-team）
    const headers = {
      'Content-Type': 'application/octet-stream',
    }
    // 转发所有身份相关头
    for (const h of ['x-user-eng', 'x-user-name', 'x-user-team', 'x-debug-user', 'x-debug-role', 'cookie']) {
      if (req.headers[h]) headers[h] = req.headers[h]
    }

    const resp = await globalThis.fetch(`http://127.0.0.1:${port}/api/data-meta/upload-file?${qs.toString()}`, {
      method: 'POST',
      headers,
      body: fileBuffer,
    })
    const result = await resp.json().catch(() => null)
    res.status(resp.status).json(result || { error: `上游返回 HTTP ${resp.status}` })
  } catch (e) {
    console.error('[upload-chunk-finalize] error:', e)
    res.status(500).json({ error: e.message || '分片合并失败' })
  }
})

router.post('/upload-file',
  expressRaw({ type: 'application/octet-stream', limit: '1gb' }),
  requireRole('admin'),
  async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: '未收到文件' })
    const ds = normalizeDataset(req.query.dataset || DS_AI_EVAL)
    const cfg = TABLE_MAP[ds]
    const by = req.currentUser?.name || req.currentUser?.eng || '管理员'
    const fileName = decodeURIComponent(req.query.fileName || '未命名文件')

    console.log(`[upload-file] 开始解析文件 ${fileName} dataset=${ds}`)
    const { rows, diag } = await parseFileToRows(req.body, fileName)
    console.log(`[upload-file] 解析出 ${rows.length} 行（sheet=${diag.sheetName || '-'} ext=${diag.ext}），识别到 ${diag.columns.length} 个列名：`)
    if (diag.columns.length) console.log(`[upload-file] 列名原始值 = ${JSON.stringify(diag.columns.slice(0, 60))}`)
    if (!rows.length) {
      console.warn(`[upload-file] 未解析到任何数据行，文件=${fileName} ext=${diag.ext} sheet=${diag.sheetName || '-'} 总行数=${diag.totalSheetRows ?? '-'}`)
      if (diag.sampleRows && diag.sampleRows.length) {
        console.warn(`[upload-file] 文件前 ${diag.sampleRows.length} 行原样内容：`)
        diag.sampleRows.forEach((r, i) => console.warn(`  [第${i + 1}行] ${JSON.stringify(r)}`))
      }
      return res.status(400).json({
        error: '未解析到有效数据行',
        diag: {
          columns: diag.columns.slice(0, 60),
          sheetName: diag.sheetName,
          ext: diag.ext,
          parsedRows: 0,
          totalSheetRows: diag.totalSheetRows ?? 0,
          sampleRows: diag.sampleRows || [],
        },
      })
    }

    await conn.ping()
    await conn.execute('SET SESSION wait_timeout = 3600')
    await conn.execute('SET SESSION interactive_timeout = 3600')
    await conn.execute('SET SESSION innodb_lock_wait_timeout = 120')

    // 聚合标签计数（增量：已存在 tag 累加，不存在新增）
    const tagAgg = new Map()
    // 待插入样本（去重后）
    const samplesToInsert = []
    const archiveKeys = []
    // 行级解析诊断（供接口返回与日志定位「0/0」根因）
    let parseDiag = {
      columns: diag.columns.slice(0, 60),
      sheetName: diag.sheetName,
      ext: diag.ext,
      parsedRows: rows.length,
      skippedNoTag: 0,
      machineCol: '',
      humanCol: '',
      firstSkippedRow: null,
    }

    if (ds === DS_TAG_PRECISION) {
      // 策略_标签数据集：直接含精度，按行即标签粒度（无样本明细展开）
      for (const r of rows) {
        const id = Number(_pickCol(r, PRECISION_COL_ID)) || 0
        if (!id) continue
        const name = _pickCol(r, PRECISION_COL_NAME)
        const total = Number(_pickCol(r, PRECISION_COL_TOTAL)) || 0
        const fp = Number(_pickCol(r, PRECISION_COL_FP)) || 0
        const g = tagAgg.get(id) || { id, name, total: 0, fp: 0 }
        g.total += total; g.fp += fp; if (name && !g.name) g.name = name
        tagAgg.set(id, g)
        const key = buildSampleKey(ds, id, { sampleId: String(_pickCol(r, PRECISION_COL_SAMPLE_ID) || '') })
        archiveKeys.push(key)
        samplesToInsert.push({ tagId: id, name, raw: r })
      }
      let skippedNoId = rows.length - samplesToInsert.length
      console.log(`[upload-file] 行级诊断（tag-precision）：总行 ${rows.length}，因标签ID为空/非数字被跳过 ${skippedNoId} 行`)
      parseDiag.skippedNoTag = skippedNoId
      if (!samplesToInsert.length) {
        console.warn(`[upload-file] 所有行均因标签ID为空被跳过，终止导入`)
        return res.status(400).json({
          error: `未识别到有效标签ID：共 ${rows.length} 行，全部因「标签ID」列缺失或非数字而被跳过`,
          diag: parseDiag,
        })
      }
    } else {
      // AI评测明细：逐行按命中的机审标签展开 sample
      let skippedNoTag = 0
      let firstSkippedRow = null
      let machineColHit = ''
      let humanColHit = ''
      if (rows.length) {
        // 反查实际命中的列名，便于定位是列名没匹配还是值为空
        for (const cn of Object.keys(rows[0])) {
          const l = String(cn).trim().toLowerCase()
          if (!machineColHit && (COL_ALIAS.machine.some(a => a.toLowerCase() === l) || (FUZZY_KEYWORDS.machine || []).some(k => l.includes(k.toLowerCase())))) machineColHit = cn
          if (!humanColHit && (COL_ALIAS.human.some(a => a.toLowerCase() === l) || (FUZZY_KEYWORDS.human || []).some(k => l.includes(k.toLowerCase())))) humanColHit = cn
        }
      }
      for (const r of rows) {
        const m = _parseIds(_pickCol(r, COL_ALIAS.machine, 'machine'))
        const h = _parseIds(_pickCol(r, COL_ALIAS.human, 'human'))
        if (!m.length && !h.length) {
          skippedNoTag++
          if (!firstSkippedRow) {
            firstSkippedRow = {
              machineCol: machineColHit, machineVal: machineColHit ? String(r[machineColHit] ?? '').slice(0, 80) : '',
              humanCol: humanColHit, humanVal: humanColHit ? String(r[humanColHit] ?? '').slice(0, 80) : '',
            }
          }
          continue
        }
        const name = String(_pickCol(r, COL_ALIAS.name) || '').trim()
        const type = String(_pickCol(r, COL_ALIAS.elementType) || '未知').trim()
        const industryL1 = String(_pickCol(r, COL_ALIAS.industryL1) || '未知').trim()
        const industryL2 = String(_pickCol(r, COL_ALIAS.industryL2) || '未知').trim()
        const mediaUrl = String(_pickCol(r, COL_ALIAS.mediaUrl) || '').trim()
        const ocrContent = String(_pickCol(r, COL_ALIAS.ocrContent) || '').trim()
        const asrContent = String(_pickCol(r, COL_ALIAS.asrContent) || '').trim()
        const classNum = String(_pickCol(r, COL_ALIAS.classNum) || '').trim()
        const classId = String(_pickCol(r, COL_ALIAS.classId) || '').trim()
        const advertiser = String(_pickCol(r, COL_ALIAS.advertiser) || '').trim()
        const dcId = String(_pickCol(r, COL_ALIAS.dc_id) || '').trim()
        const opsAdvertiserName = String(_pickCol(r, COL_ALIAS.advertiser) || '').trim() || advertiser
        const reviewerName = String(_pickCol(r, COL_ALIAS.ai_evaluate_reviewer_name) || '').trim()
        const elementFingerprint = String(_pickCol(r, COL_ALIAS.elementFingerprint) || '').trim()
        let arriveTime = _formatArriveTime(_pickCol(r, COL_ALIAS.arriveTime))
        let dsVal = String(_pickCol(r, COL_ALIAS.ds) || '').trim()
        if (!dsVal && arriveTime) dsVal = arriveTime.replace(/[/]/g, '-').slice(0, 10)
        const mStr = m.join(',')
        const hStr = h.join(',')

        for (const tagId of m) {
          const ok = h.includes(tagId)
          const g = tagAgg.get(tagId) || { id: tagId, name, total: 0, fp: 0 }
          g.total++; if (!ok) g.fp++; if (name && !g.name) g.name = name
          tagAgg.set(tagId, g)

          const sample = {
            tagId, tagName: name, type, isVideo: type === '视频',
            machineTag: mStr, humanTag: hStr,
            industryL1, industryL2, mediaUrl, ocrContent, asrContent,
            classNum, classId, advertiser, dcId, opsAdvertiserName, reviewerName,
            elementFingerprint, arriveTime, ds: dsVal,
            isFp: !ok, fpReason: '', remark: '',
          }
          const key = buildSampleKey(ds, tagId, sample)
          archiveKeys.push(key)
          samplesToInsert.push(sample)
        }
      }

      console.log(`[upload-file] 行级诊断：总行 ${rows.length}，因机审/人审标签为空被跳过 ${skippedNoTag} 行，展开样本 ${samplesToInsert.length} 条`)
      console.log(`[upload-file] 命中列：机审列=${machineColHit || '未识别'}，人审列=${humanColHit || '未识别'}`)
      if (firstSkippedRow) console.log(`[upload-file] 首个被跳过行样例：${JSON.stringify(firstSkippedRow)}`)
      parseDiag = {
        columns: diag.columns.slice(0, 60),
        sheetName: diag.sheetName,
        ext: diag.ext,
        parsedRows: rows.length,
        skippedNoTag,
        machineCol: machineColHit,
        humanCol: humanColHit,
        firstSkippedRow,
      }
      if (!samplesToInsert.length) {
        console.warn(`[upload-file] 所有行均因标签为空被跳过，终止导入`)
        return res.status(400).json({
          error: `未识别到有效标签：共 ${rows.length} 行，全部因「机审标签」或「人审标签」列解析不出数字ID而被跳过`,
          diag: parseDiag,
        })
      }
    }

    // 批量判定哪些 sample_key 已存在（去重：已存在则跳过）
    const existingKeys = new Set()
    if (archiveKeys.length) {
      const CHUNK = 500
      for (let i = 0; i < archiveKeys.length; i += CHUNK) {
        const chunk = [...new Set(archiveKeys.slice(i, i + CHUNK))]
        if (!chunk.length) continue
        const placeholders = chunk.map(() => '(?,?)').join(',')
        const rows2 = await conn.query(
          `SELECT dataset, sample_key FROM uploaded_archive WHERE (dataset, sample_key) IN (${placeholders})`,
          chunk.flatMap(k => [ds, k])
        )
        for (const r of rows2[0]) existingKeys.add(r.sample_key)
      }
    }

    await conn.beginTransaction()

    // 写入标签聚合（增量：已存在 tag 则累加 total/fp，不存在则插入）
    let newTagCount = 0
    for (const g of tagAgg.values()) {
      const [exist] = await conn.execute(`SELECT id, total, fp FROM "${cfg.prodTags}" WHERE tag_id=?`, [g.id])
      if (exist.length) {
        await conn.execute(
          `UPDATE "${cfg.prodTags}" SET total=total+?, fp=fp+?, tag_name=COALESCE(NULLIF(?,''), tag_name) WHERE tag_id=?`,
          [g.total, g.fp, g.name, g.id]
        )
      } else {
        const precisionVal = g.total > 0 ? Number(((g.total - g.fp) / g.total * 100).toFixed(2)) : 0
        await conn.execute(
          `INSERT INTO "${cfg.prodTags}" (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason) VALUES (?,?,?,?,?,?,?,?)`,
          [g.id, g.name, g.total, g.fp, precisionVal, 0, '', '']
        )
        newTagCount++
      }
    }

    // 写入去重后的样本
    let insertedSamples = 0
    if (ds === DS_TAG_PRECISION) {
      // 策略_标签数据集：样本明细可选，按行写入（去重键 = tag|sampleId）
      const toWrite = samplesToInsert.filter(s => !existingKeys.has(buildSampleKey(ds, s.tagId, { sampleId: String(_pickCol(s.raw, PRECISION_COL_SAMPLE_ID) || '') })))
      for (const s of toWrite) {
        const r = s.raw
        const mt = String(_pickCol(r, PRECISION_COL_MACHINE) || '').replace(/[\[\]]/g, '')
        const ht = String(_pickCol(r, PRECISION_COL_HUMAN) || '').replace(/[\[\]]/g, '')
        await conn.execute(
          `INSERT INTO "${cfg.prodSamples}" (tag_id, tag_name, sample_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, uid, arrive_time, ds, is_fp, fp_reason, remark, dc_id, ops_advertiser_name, element_fingerprint, ai_evaluate_reviewer_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [s.tagId, s.name, _pickCol(r, PRECISION_COL_SAMPLE_ID) || '', _pickCol(r, PRECISION_COL_ELEMENT_TYPE) || '', 0, mt, ht,
           _pickCol(r, PRECISION_COL_INDUSTRY_L1) || '', _pickCol(r, PRECISION_COL_INDUSTRY_L2) || '', _pickCol(r, PRECISION_COL_MEDIA_URL) || '',
           _pickCol(r, PRECISION_COL_OCR) || '', _pickCol(r, PRECISION_COL_ASR) || '', Number(_pickCol(r, PRECISION_COL_CLASS_NUM)) || 0, _pickCol(r, PRECISION_COL_UID) || '',
           _formatArriveTime(_pickCol(r, PRECISION_COL_ARRIVE)), _pickCol(r, PRECISION_COL_DS) || '', _pickCol(r, PRECISION_COL_IS_FP) ? 1 : 0, _pickCol(r, PRECISION_COL_FP_REASON) || '',
           _pickCol(r, PRECISION_COL_REMARK) || '', _pickCol(r, PRECISION_COL_DC_ID) || '', _pickCol(r, PRECISION_COL_OPS) || '', _pickCol(r, PRECISION_COL_FP) || '',
           _pickCol(r, PRECISION_COL_REVIEWER) || '']
        )
        insertedSamples++
      }
    } else {
      const BATCH = 2000
      for (let i = 0; i < samplesToInsert.length; i += BATCH) {
        const batch = samplesToInsert.slice(i, i + BATCH)
        for (const s of batch) {
          const key = buildSampleKey(ds, s.tagId, s)
          if (existingKeys.has(key)) continue
          await conn.execute(
            `INSERT INTO "${cfg.prodSamples}" (tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video, policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name, ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [s.tagId, s.tagName || '', s.sampleId || `RL-${s.tagId}-${insertedSamples}`, s.elementFingerprint || '', s.dcId || '', s.type || '', s.isVideo ? 1 : 0,
             s.machineTag || '', s.humanTag || '', s.industryL1 || '', s.industryL2 || '', s.mediaUrl || '', s.ocrContent || '', s.asrContent || '',
             Number(s.classNum) || 0, s.classId || '', s.uid || '', s.opsAdvertiserName || '', s.reviewerName || '',
             s.arriveTime || '', s.ds || '', s.isFp ? 1 : 0, s.fpReason || '', s.remark || '']
          )
          insertedSamples++
        }
      }
    }

    // 归档去重指纹（仅插入本次新增的，已存在会被 IGNORE 跳过）
    const newKeys = [...new Set(archiveKeys.filter(k => !existingKeys.has(k)))]
    if (newKeys.length) {
      const CHUNK = 500
      for (let i = 0; i < newKeys.length; i += CHUNK) {
        const chunk = newKeys.slice(i, i + CHUNK)
        const placeholders = chunk.map(() => '(?,?)').join(',')
        await conn.query(
          `INSERT OR IGNORE INTO uploaded_archive (dataset, sample_key) VALUES ${placeholders}`,
          chunk.flatMap(k => [ds, k])
        )
      }
    }

    // 元信息：仍取数据中最晚 arrive_time，不覆盖旧数据的时间口径
    const dataTable = ds === DS_AI_EVAL ? cfg.prodSamples : cfg.prodTags
    const [arriveRows] = await conn.query(`SELECT MAX(arrive_time) AS latest_arrive FROM "${dataTable}"`)
    const latestArrive = arriveRows[0] && arriveRows[0].latest_arrive ? arriveRows[0].latest_arrive : new Date()
    // 修正：空数据不得拿「当前时间」冒充业务时间（曾导致顶部更新时间显示为今天）
    const metaUpdatedAt = normDate(latestArrive) || ''
    await writeMeta(conn, cfg.metaKey, fileName || '', by, metaUpdatedAt)

    // 导入历史
    const precisionVal = tagAgg.size ? Number(([...tagAgg.values()].reduce((s, t) => s + ((t.total - t.fp) / Math.max(1, t.total)) * t.total, 0) / Math.max(1, [...tagAgg.values()].reduce((s, t) => s + t.total, 0))).toFixed(1)) : 0
    await writeImportHistory(conn, fileName || '', cfg.datasetName, insertedSamples, tagAgg.size, precisionVal, [...tagAgg.values()].reduce((s, t) => s + t.fp, 0), by, 'success')

    await conn.commit()
    await audit(req, '合并上传数据(直传)', `${fileName || ''} 新增样本 ${insertedSamples}`)
    setTimeout(() => { triggerClearCache() }, 1000)
    res.json({
      ok: true,
      dataset: ds,
      parsedRows: rows.length,
      newTagCount,
      insertedSamples,
      skippedSamples: archiveKeys.length - insertedSamples,
      diag: parseDiag,
      message: `合并完成：新增 ${insertedSamples} 条样本，跳过重复 ${archiveKeys.length - insertedSamples} 条，旧数据已保留`,
    })
  } catch (e) {
    try { await conn.rollback() } catch {}
    writeFailedHistory(req.file?.originalname || '', '合并上传(直传)', 0, 0, req.currentUser?.name || req.currentUser?.eng || '管理员', e.message || '导入失败')
    next(e)
  } finally {
    conn.release()
  }
})

// 策略_标签数据集的上传解析列别名（仅 /upload-file 后端解析用）
const PRECISION_COL_ID = ['标签id', '标签ID', 'tagid', 'tag_id', 'id', '策略id', '策略ID', '审核标签id']
const PRECISION_COL_NAME = ['标签名', '标签名称', 'name', 'tagname', 'tag_name', '策略名', '策略名称', '审核标签名']
const PRECISION_COL_TOTAL = ['样本数', '样本总数', 'total', '总数', '样本量', 'sample_count', '审核元素数量', '元素数量']
const PRECISION_COL_FP = ['误杀数', '误杀', 'fp', '误报数', '误杀数量', 'false_positive', '假阳性数']
const PRECISION_COL_SAMPLE_ID = ['sample_id', '样本ID', '样本id', '明细id', '明细ID']
const PRECISION_COL_MACHINE = ['policy_ids', '审核标签ID', '机审标签ID', '机审标签', 'machine', '机审policy', 'policyids']
const PRECISION_COL_HUMAN = ['ai_evaluate_policy_ids', 'AI评测人审标签', '人审标签ID', '人审标签', 'human', 'ai_policy_ids', 'aipolicy']
const PRECISION_COL_INDUSTRY_L1 = ['first_level_industry_name', 'AMS一级行业名称(开户行业)', 'AMS一级行业', '一级行业', 'industry_l1']
const PRECISION_COL_INDUSTRY_L2 = ['second_level_industry_name', 'AMS二级行业名称(开户行业)', 'AMS二级行业', '二级行业', 'industry_l2']
const PRECISION_COL_ELEMENT_TYPE = ['element_type', '审核元素类型', '素材类型', '物料类型', '内容类型', '类型', 'elementtype']
const PRECISION_COL_MEDIA_URL = ['element_value', '审核元素值', '元素值', '媒体链接', '素材链接', 'media_url', 'url', '链接']
const PRECISION_COL_OCR = ['ocr_text', 'ocr内容', 'ocr', 'ocr_content', '文字内容', '文本内容']
const PRECISION_COL_ASR = ['asr_text', 'asr内容', 'asr', 'asr_content', '语音内容', '音频内容']
const PRECISION_COL_CLASS_NUM = ['class_num', '聚类类型', 'classnum', '聚类编号', 'cluster']
const PRECISION_COL_UID = ['uid', '广告主id', '广告主ID', '广告主编号', '广告主uid']
const PRECISION_COL_ARRIVE = ['到达时间', 'arrive_time', '入库时间', '时间', '评测时间', '数据时间', '统计时间', '采样时间', '审核时间']
const PRECISION_COL_DS = ['日期分区', 'ds', '日期', 'date', '数据日期', '统计日期', '分区日期', '业务日期']
const PRECISION_COL_IS_FP = ['is_fp', '是否误杀', '误杀标记', 'fp_flag']
const PRECISION_COL_FP_REASON = ['误杀原因', 'fp_reason', 'fpreason', '误报原因', '失败原因']
const PRECISION_COL_REMARK = ['备注', 'remark', '说明', '备注说明']
const PRECISION_COL_DC_ID = ['dc_id', '创意id', '创意ID', 'dcid', '创意编号', '创意ID(DCID)']
const PRECISION_COL_OPS = ['ops_advertiser_name', '广告主', 'advertiser', '广告主名称', '客户主体名称', '客户主体名称(ops)', '客户主体名称(OPS)']
const PRECISION_COL_REVIEWER = ['ai_evaluate_reviewer_name', '审核人', '评测人', '人审人员', '审核人员']

export default router