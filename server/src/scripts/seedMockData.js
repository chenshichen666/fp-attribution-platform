/**
 * seedMockData.js — 为外网 Demo 模式生成完整的 mock 业务数据
 *
 * 根据实际 SQLite 表结构生成数据，覆盖核心业务表。
 *
 * 用法：node src/scripts/seedMockData.js
 * 注意：先运行 node src/db/init.js 确保表已创建
 */

import { db } from '../db/pool.js'
// 标签体系统一取自 tagCatalog.js（30 标签口径），避免各脚本各写一份导致不一致
import {
  TAGS, INDUSTRY, ELEMENT_TYPES as ELEMENT_TYPE_PAIRS, CATEGORIES, RESULT_TYPES,
  USERS, USER_NAMES, randInt, pick, resetSeed,
} from './tagCatalog.js'

// ============ 工具函数 ============
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function dateStr(daysAgo = 0) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
function dateOnly(daysAgo = 0) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

// ============ 枚举值 ============
const TAG_NAMES = TAGS.map(([, n]) => n)
const TAG_IDS = TAGS.map(([id]) => id)
const INDUSTRIES_L1 = [...new Set(INDUSTRY.map(([a]) => a))]
const INDUSTRIES_L2 = [...new Set(INDUSTRY.map(([, b]) => b))]
const ELEMENT_TYPES = ELEMENT_TYPE_PAIRS.map(([t]) => t)
const ELEMENT_TYPE_NAMES = ELEMENT_TYPE_PAIRS.map(([, n]) => n)
const TICKET_STATUSES = ['submitted', 'accepted', 'processing', 'concluded', 'closed']
const URGENCIES = [1, 2, 3]
const DS_VALUES = Array.from({ length: 14 }, (_, i) => dateOnly(i))

// 辅助：获取表的实际列名列表
function getColumns(table) {
  return db.pragma(`table_info("${table}")`).map(c => c.name)
}

// 辅助：安全插入 — 只插入表中实际存在的列
function safeInsert(table, data) {
  const cols = getColumns(table)
  const filteredKeys = Object.keys(data).filter(k => cols.includes(k))
  if (!filteredKeys.length) return
  const placeholders = filteredKeys.map(() => '?').join(',')
  const sql = `INSERT OR IGNORE INTO "${table}" (${filteredKeys.map(k => `"${k}"`).join(',')}) VALUES (${placeholders})`
  const values = filteredKeys.map(k => data[k])
  db.prepare(sql).run(...values)
}

console.log('==> 开始生成 mock 业务数据...')

// ============ 幂等清空 ============
// 本脚本负责的表全部先清空再生成。
// 否则 INSERT OR IGNORE 会因主键冲突静默失败——表象是"重新生成了数据"，
// 实际还是旧数据（曾导致：时间线每单累积到 16~54 个节点、工单素材永远为空）。
const SEED_TABLES = [
  'ticket_timeline', 'tickets', 'sediments', 'data_import_history',
  'cluster_data', 'ai_evaluate_detail', 'real_data_tag_precision',
  'real_data_samples', 'real_data_tags',
]
for (const t of SEED_TABLES) {
  try {
    const n = db.prepare(`DELETE FROM "${t}"`).run()
    console.log(`    已清空 ${t}（${n.changes} 条）`)
  } catch { /* 表可能尚未创建，init 阶段会建 */ }
}

// ============ real_data_tags ============
// 实际列: id, tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason
console.log('  → 审核标签 (real_data_tags)')
let tagCount = 0
for (let i = 0; i < TAG_NAMES.length; i++) {
  const total = rand(200, 5000)
  const fp = rand(5, Math.floor(total * 0.3))
  const precisionVal = ((total - fp) / total).toFixed(4)
  safeInsert('real_data_tags', {
    tag_id: TAG_IDS[i],
    tag_name: TAG_NAMES[i],
    total,
    fp,
    precision_val: Number(precisionVal),
    rank_no: i + 1,
    remark: '',
    fp_reason: '',
  })
  tagCount++
}
console.log(`    已插入 ${tagCount} 条标签记录`)

// ============ real_data_samples ============
// 实际列: id, tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video,
//   policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name,
//   media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name,
//   ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason, remark
console.log('  → 样本数据 (real_data_samples)')
let sampleTotal = 0
const sampleTransaction = db.transaction(() => {
  for (let i = 0; i < TAG_NAMES.length; i++) {
    for (let k = 0; k < 20; k++) {
      const elIdx = rand(0, 2)
      const isVideo = elIdx === 1 ? 1 : 0
      const mediaUrl = isVideo
        ? `https://demo-media.example.com/video/sample_${TAG_IDS[i]}_${k}.mp4`
        : `https://demo-media.example.com/img/sample_${TAG_IDS[i]}_${k}.jpg`
      safeInsert('real_data_samples', {
        tag_id: TAG_IDS[i],
        tag_name: TAG_NAMES[i],
        sample_id: `S-${TAG_IDS[i]}-${k + 1}`,
        element_fingerprint: `fp_${TAG_IDS[i]}_${k}_${rand(10000, 99999)}`,
        dc_id: `DC-${rand(1000, 9999)}`,
        element_type: ELEMENT_TYPES[elIdx],
        is_video: isVideo,
        policy_ids: String(TAG_IDS[i]),
        ai_evaluate_policy_ids: String(TAG_IDS[i]),
        first_level_industry_name: pick(INDUSTRIES_L1),
        second_level_industry_name: pick(INDUSTRIES_L2),
        media_url: mediaUrl,
        ocr_content: !isVideo ? `OCR示例文本_${TAG_NAMES[i]}_${k}` : '',
        asr_content: isVideo ? `ASR示例文本_${TAG_NAMES[i]}_${k}` : '',
        class_num: rand(0, 5),
        class_id: `c_${rand(100, 999)}`,
        uid: `uid_${rand(10000, 99999)}`,
        ops_advertiser_name: `广告主_${rand(1, 50)}`,
        ai_evaluate_reviewer_name: pick(USER_NAMES),
        arrive_time: dateStr(rand(0, 30)),
        ds: pick(DS_VALUES),
        is_fp: Math.random() < 0.3 ? 1 : 0,
        fp_reason: '',
        remark: '',
      })
      sampleTotal++
    }
  }
})
sampleTransaction()
console.log(`    已插入 ${sampleTotal} 条样本记录`)

// ============ real_data_tag_precision ============
// 实际列: id, tag_id, tag_name, total, fp, precision_val, tp, fp_conf, tn, fn,
//   sample_count, first_level_industry_name, second_level_industry_name, element_type,
//   element_type_name, arrive_time, ds, model_version, element_fingerprint, remark,
//   fp_reason, review_model_precision_prime
console.log('  → 标签准确率 (real_data_tag_precision)')
let precisionTotal = 0
for (let i = 0; i < TAG_NAMES.length; i++) {
  for (let j = 0; j < 3; j++) {
    const total = rand(100, 2000)
    const fp = rand(5, Math.floor(total * 0.2))
    const precisionVal = ((total - fp) / total).toFixed(4)
    safeInsert('real_data_tag_precision', {
      tag_id: TAG_IDS[i],
      tag_name: TAG_NAMES[i],
      total,
      fp,
      precision_val: Number(precisionVal),
      tp: rand(20, 100),
      fp_conf: rand(1, 10),
      tn: rand(50, 200),
      fn: rand(1, 15),
      sample_count: total,
      first_level_industry_name: pick(INDUSTRIES_L1),
      second_level_industry_name: pick(INDUSTRIES_L2),
      element_type: ELEMENT_TYPES[j],
      element_type_name: ELEMENT_TYPE_NAMES[j],
      arrive_time: dateStr(rand(0, 14)),
      ds: pick(DS_VALUES),
      model_version: 'v2.1',
      element_fingerprint: '',
      remark: '',
      fp_reason: '',
      review_model_precision_prime: Number(((total - fp + rand(-5, 5)) / total).toFixed(4)),
    })
    precisionTotal++
  }
}
console.log(`    已插入 ${precisionTotal} 条准确率记录`)

// ============ tickets + ticket_timeline ============
// tickets 实际列已匹配
// ticket_timeline 实际列: id, ticket_id, action, op, t
console.log('  → 工单 (tickets + ticket_timeline)')
const insertTimeline = db.prepare('INSERT INTO ticket_timeline (ticket_id, action, op, t) VALUES (?,?,?,?)')

let ticketTotal = 0
// 取真实素材填充工单的 samples_data（前端「已关联素材」表格的数据源）
// 图片用 picsum（seed 稳定），视频用 Google 公共示例桶 —— 均为公共 CC0 资源，无隐私内容
const TICKET_VIDEOS = ['ForBiggerBlazes','ForBiggerEscapes','ForBiggerFun','ForBiggerJoyrides','ForBiggerMeltdowns']
const pickRealSamples = db.prepare(`
  SELECT sample_id, element_type, is_video, media_url, ocr_content, asr_content,
         element_fingerprint, dc_id, ops_advertiser_name, ai_evaluate_reviewer_name,
         first_level_industry_name, second_level_industry_name
  FROM real_data_samples WHERE tag_id = ? ORDER BY RANDOM() LIMIT ?
`)
const ticketTransaction = db.transaction(() => {
  for (let t = 0; t < 25; t++) {
    const ticketId = `TKT-${2025 + t}`
    const tagIdx = rand(0, TAG_NAMES.length - 1)
    const tagId = TAG_IDS[tagIdx]
    const status = pick(TICKET_STATUSES)
    const submitter = pick(USERS)
    const handler = status === 'submitted' ? '' : pick(USERS.filter(u => u !== submitter))
    const daysAgo = rand(0, 30)
    const category = status === 'concluded' || status === 'closed' ? pick(CATEGORIES) : ''
    const resultType = status === 'concluded' || status === 'closed' ? pick(RESULT_TYPES) : ''
    const conclusion = status === 'concluded' || status === 'closed'
      ? `经分析，该标签 ${TAG_NAMES[tagIdx]} 在 ${pick(INDUSTRIES_L1)} 行业存在${pick(['规则过严', '模型偏差', '特征不足'])}问题，建议${pick(['调整阈值', '补充训练样本', '修正规则逻辑'])}。`
      : ''

    // ---- 关联素材：从样本表取该标签的真实素材 6~12 条 ----
    const sampleN = rand(6, 12)
    const realSamples = pickRealSamples.all(tagId, sampleN)
    const samplesData = realSamples.map((r, i) => {
      const isVideo = Number(r.is_video) === 1
      const mediaUrl = r.media_url || (isVideo
        ? `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/${TICKET_VIDEOS[i % TICKET_VIDEOS.length]}.mp4`
        : `https://picsum.photos/seed/${tagId}-t${t}-${i}/400/300`)
      return {
        sampleId: r.sample_id,
        elementType: r.element_type,
        isVideo,
        mediaUrl,
        ocrContent: r.ocr_content || '',
        asrContent: r.asr_content || '',
        elementFingerprint: r.element_fingerprint || '',
        dcId: r.dc_id || '',
        advertiserId: r.ops_advertiser_name || '',
        uid: `adv_${randInt(1000, 9999)}`,
        reviewerName: r.ai_evaluate_reviewer_name || '',
        machineTag: r.policy_ids || String(tagId),
        humanTag: r.ai_evaluate_policy_ids || '',
        needTag: '',        // 打标状态：'' 未选 / 'need' 需要 / 'no' 无需（三态切换）
        industryL1: r.first_level_industry_name || '',
        industryL2: r.second_level_industry_name || '',
      }
    })
    const sampleCount = samplesData.length

    safeInsert('tickets', {
      id: ticketId,
      title: `${TAG_NAMES[tagIdx]}误杀分析-${pick(INDUSTRIES_L1)}`,
      tag: TAG_NAMES[tagIdx],
      tag_id: tagId,
      element_type: pick(ELEMENT_TYPES),
      first_level_industry_name: pick(INDUSTRIES_L1),
      second_level_industry_name: pick(INDUSTRIES_L2),
      urgency: pick(URGENCIES),
      status,
      submitter,
      handler,
      sample_count: sampleCount,
      samples_data: JSON.stringify(samplesData),
      descr: `${pick(INDUSTRIES_L1)}行业反馈${TAG_NAMES[tagIdx]}标签误杀率偏高，需分析原因。`,
      conclusion,
      handle_reason: status !== 'submitted' ? '该工单涉及核心标签，优先处理' : '',
      category,
      category_note: category ? `${category}相关说明` : '',
      result_type: resultType,
      is_demo: 1,
      created_at: dateStr(daysAgo),
      updated_at: dateStr(Math.max(0, daysAgo - rand(0, 3))),
    })

    // ---- 时间线：精简为 提交 → 受理 → 结束（用户要求，不要过多节点）----
    // submitted：仅「提交」；accepted/processing：提交+受理；concluded/closed：提交+受理+结束
    insertTimeline.run(ticketId, '提交工单', submitter, dateStr(daysAgo))
    if (status !== 'submitted') {
      insertTimeline.run(ticketId, '受理工单', handler, dateStr(Math.max(0, daysAgo - 1)))
    }
    if (status === 'concluded' || status === 'closed') {
      insertTimeline.run(ticketId, status === 'closed' ? '关闭工单' : '提交结论', handler, dateStr(Math.max(0, daysAgo - 2)))
    }
    ticketTotal++
  }
})
ticketTransaction()
console.log(`    已插入 ${ticketTotal} 条工单记录`)

// ============ sediments（结论沉淀） ============
// 实际列: id, ticket_id, title, type, category, result_type, tag_id, tag_name, tags, industry,
//   industry_l1, industry_l2, submitter, handler, adopted_at, samples, descr, feature,
//   conclusion, fp_reason, related_materials, handle_info, ...
console.log('  → 结论沉淀 (sediments)')
let sedimentTotal = 0
const sedimentTransaction = db.transaction(() => {
  for (let s = 0; s < 15; s++) {
    const tagIdx = rand(0, TAG_NAMES.length - 1)
    const cat = pick(CATEGORIES)
    safeInsert('sediments', {
      ticket_id: `TKT-${2025 + s}`,
      title: `${TAG_NAMES[tagIdx]}-${cat}沉淀报告`,
      type: pick(['fp_analysis', 'rule_review', 'model_review']),
      category: cat,
      result_type: pick(RESULT_TYPES),
      tag_id: TAG_IDS[tagIdx],
      tag_name: TAG_NAMES[tagIdx],
      tags: TAG_NAMES[tagIdx],
      industry: pick(INDUSTRIES_L1),
      industry_l1: pick(INDUSTRIES_L1),
      industry_l2: pick(INDUSTRIES_L2),
      submitter: pick(USERS),
      handler: pick(USERS),
      adopted_at: dateStr(rand(0, 20)),
      samples: '[]',
      descr: `${pick(INDUSTRIES_L1)}行业${TAG_NAMES[tagIdx]}标签误杀问题分析`,
      feature: `${cat}特征描述`,
      conclusion: `分析发现 ${TAG_NAMES[tagIdx]} 标签存在${cat}情况，${pick(['已调整规则阈值', '已补充负样本', '已更新模型特征'])}，误杀率预计下降${rand(5, 30)}%。`,
      fp_reason: cat,
      related_materials: '[]',
      handle_info: '',
      created_at: dateStr(rand(0, 30)),
    })
    sedimentTotal++
  }
})
sedimentTransaction()
console.log(`    已插入 ${sedimentTotal} 条沉淀记录`)

// ============ ai_evaluate_detail ============
// 实际列: id, evaluation_target_type, evaluation_target_type_name, first_level_industry_name,
//   second_level_industry_name, element_type, element_type_name, policy_ids, ai_evaluate_policy_ids,
//   element_value, ocr_content, asr_content, class_num, class_id, dc_id, uid, uid_name,
//   ops_advertiser_name, model_version, ai_evaluate_reviewer_name, element_fingerprint, arrive_time, ds
console.log('  → AI 评测明细 (ai_evaluate_detail)')
let aiDetailTotal = 0
const aiDetailTransaction = db.transaction(() => {
  for (let i = 0; i < TAG_NAMES.length; i++) {
    for (let j = 0; j < 15; j++) {
      const elIdx = rand(0, 2)
      const isVideo = elIdx === 1
      const mediaUrl = isVideo
        ? `https://demo-media.example.com/video/eval_${TAG_IDS[i]}_${j}.mp4`
        : `https://demo-media.example.com/img/eval_${TAG_IDS[i]}_${j}.jpg`
      safeInsert('ai_evaluate_detail', {
        evaluation_target_type: ELEMENT_TYPES[elIdx],
        evaluation_target_type_name: ELEMENT_TYPE_NAMES[elIdx],
        first_level_industry_name: pick(INDUSTRIES_L1),
        second_level_industry_name: pick(INDUSTRIES_L2),
        element_type: ELEMENT_TYPES[elIdx],
        element_type_name: ELEMENT_TYPE_NAMES[elIdx],
        policy_ids: String(TAG_IDS[i]),
        ai_evaluate_policy_ids: String(TAG_IDS[i]),
        element_value: mediaUrl,
        ocr_content: !isVideo ? `OCR示例_${TAG_NAMES[i]}_${j}` : '',
        asr_content: isVideo ? `ASR示例_${TAG_NAMES[i]}_${j}` : '',
        class_num: rand(0, 5),
        class_id: `c_${rand(100, 999)}`,
        dc_id: `DC-${rand(1000, 9999)}`,
        uid: `uid_${rand(10000, 99999)}`,
        uid_name: pick(USER_NAMES),
        ops_advertiser_name: `广告主_${rand(1, 50)}`,
        model_version: 'v2.1',
        ai_evaluate_reviewer_name: pick(USER_NAMES),
        element_fingerprint: `fp_eval_${TAG_IDS[i]}_${j}_${rand(10000, 99999)}`,
        arrive_time: dateStr(rand(0, 30)),
        ds: pick(DS_VALUES),
      })
      aiDetailTotal++
    }
  }
})
aiDetailTransaction()
console.log(`    已插入 ${aiDetailTotal} 条 AI 评测明细`)

// ============ cluster_data ============
// 实际列: id, arrive_time, element_type, policy_ids, ai_evaluate_policy_ids,
//   element_value, element_fingerprint, class_id, created_at
console.log('  → 聚类数据 (cluster_data)')
let clusterTotal = 0
const clusterTransaction = db.transaction(() => {
  for (let i = 0; i < TAG_NAMES.length; i++) {
    const numClusters = rand(3, 8)
    for (let c = 0; c < numClusters; c++) {
      const classId = `c_${TAG_IDS[i]}_${c}`
      const clusterSize = rand(2, 6)
      for (let m = 0; m < clusterSize; m++) {
        const elIdx = rand(0, 1)
        const mediaUrl = elIdx === 1
          ? `https://demo-media.example.com/video/cluster_${TAG_IDS[i]}_${c}_${m}.mp4`
          : `https://demo-media.example.com/img/cluster_${TAG_IDS[i]}_${c}_${m}.jpg`
        safeInsert('cluster_data', {
          arrive_time: dateStr(rand(0, 30)),
          element_type: ELEMENT_TYPES[elIdx],
          policy_ids: String(TAG_IDS[i]),
          ai_evaluate_policy_ids: String(TAG_IDS[i]),
          element_value: mediaUrl,
          element_fingerprint: `fp_${TAG_IDS[i]}_${c}_${m}_${rand(10000, 99999)}`,
          class_id: classId,
          created_at: dateStr(rand(0, 14)),
        })
        clusterTotal++
      }
    }
  }
})
clusterTransaction()
console.log(`    已插入 ${clusterTotal} 条聚类数据`)

// ============ data_import_history ============
// 实际列: id, file_name, dataset_name, sample_count, tag_count, precision_val, fp_count, status, error_message, imported_by, imported_at
console.log('  → 数据导入历史 (data_import_history)')
for (let h = 0; h < 8; h++) {
  const tagIdx = rand(0, TAG_NAMES.length - 1)
  const sampleCount = rand(100, 5000)
  const fpCount = rand(5, Math.floor(sampleCount * 0.2))
  safeInsert('data_import_history', {
    file_name: `import_${dateOnly(rand(0, 14)).replace(/-/g, '')}_${h}.xlsx`,
    dataset_name: `${TAG_NAMES[tagIdx]}数据集`,
    sample_count: sampleCount,
    tag_count: rand(1, 5),
    precision_val: Number(((sampleCount - fpCount) / sampleCount).toFixed(4)),
    fp_count: fpCount,
    status: 'success',
    error_message: '',
    imported_by: pick(USERS),
    imported_at: dateStr(rand(0, 14)),
  })
}
console.log('    已插入 8 条导入历史')

console.log('\n==> Mock 业务数据生成完成 ✅')
console.log(`    总计: 标签 ${tagCount} | 样本 ${sampleTotal} | 准确率 ${precisionTotal} | 工单 ${ticketTotal} | 沉淀 ${sedimentTotal} | AI评测 ${aiDetailTotal} | 聚类 ${clusterTotal}`)
// 注意：不要在此调用 process.exit() —— 本脚本会被 rebuildAllData.js 编排调用，
//       主动退出会导致后续步骤全部无法执行。独立运行时 Node 会自然退出。
