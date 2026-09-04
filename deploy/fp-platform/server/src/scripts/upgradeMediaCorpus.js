/**
 * upgradeMediaCorpus.js — 为 AI 评测明细补充合规素材文案
 *
 * 【职责边界】
 * 样本明细表 real_data_samples 的文案已由 expandSamples.js 统一生成（含聚类簇结构），
 * 这里只负责 ai_evaluate_detail（AI 评测明细）的文本字段，避免两处重复生成打架。
 *
 * 【合规约束】
 * 分析对象是「误杀」= 正常素材被误判为违规，因此素材文案必须是**合规的正常商业内容**，
 * 不得写入色情引流、赌博诈骗、违禁品、虚假疗效等违规诱导话术。
 * 文案统一取自 tagCatalog.js 的 CREATIVE_LIBRARY。
 *
 * 【依赖】标签体系统一取自 tagCatalog.js（30 标签）
 *
 * 幂等：可重复运行。
 *
 * 用法：node src/scripts/upgradeMediaCorpus.js
 */

import { db } from '../db/pool.js'
import {
  TAGS, CREATIVE_LIBRARY, ELEMENT_TYPES, INDUSTRY,
  TARGET_CLUSTERS, clustersForTag,
  randInt, pick, resetSeed,
} from './tagCatalog.js'

// 簇文本生成：与 expandSamples 保持同一套逻辑（基础文案 + 簇前缀 + 簇内扰动），
// 保证「AI 评测明细」与「样本明细」中同一簇 ID 的文本一致，检索时不会串味。
const CLUSTER_PREFIX = [
  '', '限时！', '【官方】', '热推·', '🔥', '独家·', '重磅！',
  '新品·', '会员·', '专享·', '爆款·', '特惠·', '直供·',
  '甄选·', '人气·', '推荐·', '热门·',
]
const CLUSTER_TAIL = ['', ' 现货发售', ' 详情进店', ' 欢迎选购', ' 支持退换']

function makeClusterText(phrase, ci, k) {
  const p = CLUSTER_PREFIX[ci % CLUSTER_PREFIX.length]
  const t = CLUSTER_TAIL[k % CLUSTER_TAIL.length]
  return `${p}${phrase}${t}`.trim()
}

function run() {
  resetSeed(20260903)
  console.log('==> 开始升级 AI 评测明细语料...')

  let details = []
  try {
    details = db.prepare(`
      SELECT id, element_type, element_type_name, evaluation_target_type_name
      FROM ai_evaluate_detail ORDER BY id
    `).all()
  } catch (e) {
    console.error('  读取 ai_evaluate_detail 失败:', e.message)
    return
  }

  if (!details.length) {
    console.warn('  ⚠️  ai_evaluate_detail 为空，跳过')
    return
  }

  const updateDetail = db.prepare(`
    UPDATE ai_evaluate_detail
    SET ocr_content = ?, asr_content = ?, class_id = ?, class_num = ?,
        first_level_industry_name = ?, second_level_industry_name = ?,
        element_type = ?, element_type_name = ?
    WHERE id = ?
  `)

  let count = 0
  const tx = db.transaction(() => {
    for (let idx = 0; idx < details.length; idx++) {
      const d = details[idx]
      // 轮转分配标签，保证 30 个标签都有覆盖
      const tagIdx = idx % TAGS.length
      const [tagId, tagName, defInd1, defInd2] = TAGS[tagIdx]
      const creatives = CREATIVE_LIBRARY[tagName] || ['通用商品宣传素材']
      // 簇数与命名与样本表（expandSamples）保持一致：
      // 本表用 c_a_ 前缀时，/overview/clusters 与 KPI 的簇数会出现两套口径。
      const nClusters = clustersForTag(tagIdx)
      const clusterIdx = Math.floor(idx / TAGS.length) % nClusters
      const phrase = creatives[clusterIdx % creatives.length]
      const classId = `c_${tagId}_${String(clusterIdx + 1).padStart(2, '0')}`
      const variant = makeClusterText(phrase, clusterIdx, idx)

      const typeName = d.element_type_name || d.evaluation_target_type_name || ''
      const isVideo = /视频|video/i.test(typeName) || /VIDEO/i.test(String(d.element_type || ''))
      const [elType, elTypeName] = isVideo ? ELEMENT_TYPES[1] : ELEMENT_TYPES[0]
      // 一半用标签自带行业，一半轮转
      const [ind1, ind2] = (idx % 2 === 0)
        ? [defInd1, defInd2]
        : pick(INDUSTRY)

      updateDetail.run(
        isVideo ? '' : variant,
        isVideo ? variant : '',
        classId, clusterIdx,
        ind1, ind2,
        elType, elTypeName,
        d.id
      )
      count++
    }
  })
  tx()
  console.log(`    已升级 ${count} 条 AI 评测明细文本`)

  const stat = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN ocr_content != '' THEN 1 ELSE 0 END) has_ocr,
      SUM(CASE WHEN asr_content != '' THEN 1 ELSE 0 END) has_asr,
      COUNT(DISTINCT class_id) clusters
    FROM ai_evaluate_detail
  `).get()
  console.log('\n==> 完成')
  console.log(`    总条数  : ${stat.total}`)
  console.log(`    含 OCR  : ${stat.has_ocr}`)
  console.log(`    含 ASR  : ${stat.has_asr}`)
  console.log(`    聚类簇  : ${stat.clusters}`)
}

run()
