// Adata 数据导入脚本
// 用途：把从 Adata（ads_base_element_ai_evaluate_d）导出的 CSV 灌入 ai_evaluate_detail 表
//
// 使用方式：
//   node src/scripts/importAdata.js <导出文件路径> [--truncate] [--ds=区间]
//   支持 .json（数组）或 .csv（首行表头）
//
// 字段映射：脚本会把导出文件的列名按 FIELD_MAP 映射到表字段。
// FIELD_MAP 已按真实 16 列中文表头配置；列名匹配大小写/全半角括号/BOM 均做了归一化。

import fs from 'fs'
import path from 'path'
import { pool } from '../db/pool.js'

// 数据库字段 → 可能的导出列名（按真实 CSV 表头）
const FIELD_MAP = {
  arrive_time_raw: ['到达时间', 'arrive_time'],
  evaluation_target_type: ['评测目标类型', 'evaluation_target_type'],
  evaluation_target_type_name: ['评测目标类型(翻译后)', 'evaluation_target_type_name'],
  first_level_industry_name: ['AMS一级行业名称(开户行业)', 'first_level_industry_name'],
  second_level_industry_name: ['AMS二级行业名称(开户行业)', 'second_level_industry_name'],
  element_type: ['审核元素类型', 'element_type'],
  element_type_name: ['审核元素类型(翻译后)', 'element_type_name'],
  policy_ids: ['审核标签ID', 'policy_ids'],
  ai_evaluate_policy_ids: ['AI评测人审标签', 'ai_evaluate_policy_ids'],
  element_value: ['审核元素值', 'element_value'],
  ocr_content: ['OCR内容', 'ocr_content'],
  asr_content: ['ASR内容', 'asr_content'],
  dc_id: ['创意ID(DCID)', 'dc_id', 'dcid'],
  uid: ['广告主ID', 'uid'],
  uid_name: ['广告主ID(翻译后)', 'uid_name'],
  ops_advertiser_name: ['客户主体名称(OPS)', 'ops_advertiser_name'],
  model_version: ['模型版本', 'model_version'],
  ai_evaluate_reviewer_name: ['审核人', 'ai_evaluate_reviewer_name'],
  element_fingerprint: ['审核物理指纹（md5）', '审核物理指纹(md5)', 'element_fingerprint'],
  class_num: ['分类', 'class_num', 'classnum', '聚类类型', '聚类编号'],
  class_id: ['class_id', 'classid', 'classId', '聚类ID'],
}

// 列名归一化：去 BOM、去空白、全角括号转半角、转小写
function norm(s) {
  return String(s || '')
    .replace(/^\uFEFF/, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function pick(row, keys) {
  const lower = {}
  for (const k of Object.keys(row)) lower[norm(k)] = row[k]
  for (const k of keys) { const v = lower[norm(k)]; if (v !== undefined) return v }
  return ''
}

// 解析到达时间：支持 2026/06/16、2026-06-16、20260616 → { date: 'YYYY-MM-DD', ds: 'YYYYMMDD' }
function parseArriveTime(raw) {
  const s = String(raw || '').trim()
  if (!s) return { date: null, ds: '' }
  const m = s.match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/)
  if (!m) return { date: null, ds: '' }
  const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0')
  return { date: `${y}-${mo}-${d}`, ds: `${y}${mo}${d}` }
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    const obj = {}
    headers.forEach((h, i) => { obj[h] = cells[i] ?? '' })
    return obj
  })
}

function splitCsvLine(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++ } else inQ = !inQ }
    else if (c === ',' && !inQ) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

async function run() {
  const file = process.argv[2]
  const truncate = process.argv.includes('--truncate')
  const dsArg = (process.argv.find((a) => a.startsWith('--ds=')) || '').slice(5)
  const ds = dsArg || '20260616-20260629'
  if (!file) {
    console.error('用法: node src/scripts/importAdata.js <文件路径.json|.csv> [--truncate] [--ds=20260616-20260629]')
    process.exit(1)
  }
  const raw = fs.readFileSync(path.resolve(file), 'utf-8')
  const rows = file.endsWith('.json') ? JSON.parse(raw) : parseCSV(raw)
  console.log(`==> 解析到 ${rows.length} 行，ds=${ds}`)

  // 兜底：确保已存在的表也有 arrive_time 列（新环境由 schema 建好；旧表在此补列）
  try {
    await pool.query('ALTER TABLE ai_evaluate_detail ADD COLUMN arrive_time DATE NULL')
    await pool.query('ALTER TABLE ai_evaluate_detail ADD INDEX idx_arrive (arrive_time)')
    console.log('==> 已补充 arrive_time 列与索引')
  } catch (e) {
    if (!/Duplicate column|exists/i.test(String(e.message))) throw e
  }

  // 兜底：补充 OCR/ASR 内容列
  for (const col of ['ocr_content', 'asr_content']) {
    try {
      await pool.query(`ALTER TABLE ai_evaluate_detail ADD COLUMN ${col} TEXT`)
      console.log(`==> 已补充 ${col} 列`)
    } catch (e) {
      if (!/Duplicate column/i.test(String(e.message))) throw e
    }
  }

  if (truncate) {
    await pool.query('TRUNCATE TABLE ai_evaluate_detail')
    console.log('==> 已清空旧数据')
  }

  const COLS = [
    'evaluation_target_type', 'evaluation_target_type_name', 'first_level_industry_name',
    'second_level_industry_name', 'element_type', 'element_type_name', 'policy_ids',
    'ai_evaluate_policy_ids', 'element_value', 'ocr_content', 'asr_content',
    'dc_id', 'uid', 'uid_name', 'ops_advertiser_name', 'model_version',
    'ai_evaluate_reviewer_name', 'element_fingerprint', 'arrive_time', 'ds', 'class_num', 'class_id',
  ]

  let ok = 0
  const BATCH = 500
  let batch = []
  const flush = async () => {
    if (!batch.length) return
    const placeholders = batch.map(() => `(${COLS.map(() => '?').join(',')})`).join(',')
    const flat = batch.flat()
    await pool.query(
      `INSERT INTO ai_evaluate_detail (${COLS.join(',')}) VALUES ${placeholders}`, flat,
    )
    ok += batch.length
    batch = []
  }

  for (const row of rows) {
    const v = {}
    for (const [field, keys] of Object.entries(FIELD_MAP)) v[field] = pick(row, keys)
    const at = parseArriveTime(v.arrive_time_raw)
    batch.push([
      Number(v.evaluation_target_type) || 0, v.evaluation_target_type_name, v.first_level_industry_name,
      v.second_level_industry_name, v.element_type, v.element_type_name, v.policy_ids,
      v.ai_evaluate_policy_ids, v.element_value, v.ocr_content, v.asr_content,
      v.dc_id, v.uid, v.uid_name, v.ops_advertiser_name, v.model_version,
      v.ai_evaluate_reviewer_name, v.element_fingerprint, at.date, at.ds || ds,
      Number(v.class_num) || 0, String(v.class_id || ''),
    ])
    if (batch.length >= BATCH) await flush()
  }
  await flush()
  console.log(`==> 导入完成，成功 ${ok} 行 ✅`)

  // ★性能优化 T6.1: 重建 ai_evaluate_detail_url_idx 索引表（导入后自动回填）
  try {
    const [rebuildRes] = await pool.query(
      `INSERT INTO ai_evaluate_detail_url_idx
        (element_value_norm, element_value, element_fingerprint, policy_ids, ai_evaluate_policy_ids, dc_id, class_id, ops_advertiser_name, ai_evaluate_reviewer_name, uid)
      SELECT
        SUBSTRING_INDEX(element_value,'?',1) AS element_value_norm,
        element_value,
        MAX(NULLIF(element_fingerprint,'')),
        MAX(CASE WHEN policy_ids<>'[]' AND policy_ids<>'' THEN policy_ids END),
        MAX(CASE WHEN ai_evaluate_policy_ids<>'[]' AND ai_evaluate_policy_ids<>'' THEN ai_evaluate_policy_ids END),
        MAX(dc_id), MAX(class_id),
        MAX(NULLIF(ops_advertiser_name,'')),
        MAX(NULLIF(ai_evaluate_reviewer_name,'')),
        MAX(NULLIF(uid,''))
      FROM ai_evaluate_detail
      GROUP BY element_value_norm, element_value
      ON DUPLICATE KEY UPDATE
        element_fingerprint=VALUES(element_fingerprint),
        policy_ids=VALUES(policy_ids),
        ai_evaluate_policy_ids=VALUES(ai_evaluate_policy_ids),
        dc_id=VALUES(dc_id), class_id=VALUES(class_id),
        ops_advertiser_name=VALUES(ops_advertiser_name),
        ai_evaluate_reviewer_name=VALUES(ai_evaluate_reviewer_name),
        uid=VALUES(uid)`
    )
    console.log(`==> 索引表 ai_evaluate_detail_url_idx 已重建${rebuildRes?.affectedRows ? `，${rebuildRes.affectedRows} 行` : ''}`)
  } catch (e) {
    console.warn('==> 索引表重建失败（不影响导入）:', e.message)
  }

  process.exit(0)
}

run().catch((e) => { console.error('导入失败:', e); process.exit(1) })
```