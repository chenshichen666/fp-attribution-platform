/**
 * 补齐工单链路 mock 数据：concluded（待采纳）/ done（已完结）状态
 *
 * 目的：让「总览 → 误杀Case分析 → 问题提需 → 结论沉淀」整链路可跑通
 * - concluded：处理人已给出专家结论，等待提需人采纳
 * - done：提需人已采纳并确认问题分类/结果类型（可入库结论沉淀）
 *
 * 素材从 real_data_samples 取真实样本（含 media_url / ocr / asr / 广告主等字段），
 * 保证工单详情「已关联素材」表格各列都有数据。
 */
import { rawQuery } from '../src/db/pool.js'

// 确定性随机，保证结果可复现
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260902)

const CATEGORY = ['POLICY', 'MODEL', 'DATA', 'REVIEW', 'OTHER']
const RESULT_TYPE = ['real_fp', 'machine_right']
const CONCLUSIONS = [
  '经核实，该批素材属于正常广告内容，机审策略阈值过严导致误杀，建议放宽阈值并补充白名单。',
  '素材中人物着装未过分暴露，不属于低俗内容，判定为机审误杀，已反馈策略侧调整。',
  '经人工复核，该标签在此类素材上命中率偏低，建议优化模型特征或拆分标签口径。',
  '素材涉及医疗功效宣传但具备资质证明，属于合规投放，建议补充资质豁免逻辑。',
  '经确认，机审判定正确，素材确实存在违规，非误杀；建议保留当前策略。',
  '该批素材为行业通用素材，历史多次审核通过，判定为误杀，建议加入信任名单。',
]

async function main() {
  console.log('=== 开始补齐工单链路 mock 数据 ===')

  // 取 50 个真实标签（与精度表一致）
  const tags = await rawQuery(
    `SELECT tag_id, tag_name FROM real_data_tag_precision GROUP BY tag_id, tag_name ORDER BY tag_id LIMIT 50`
  )
  if (!tags.length) { console.error('精度表无标签，中止'); process.exit(1) }
  console.log(`取到 ${tags.length} 个标签`)

  // 定向取样：只取 tag_id 在精度表 50 个标签内的样本（每个标签取若干条）
  // 避免随机 LIMIT 抽样与精度表标签无交集导致工单关联不到素材
  const tagIdList = tags.map(t => t.tag_id)
  const samples = await rawQuery(
    `SELECT sample_id, tag_id, media_url, element_type, ocr_content, asr_content,
            policy_ids, ai_evaluate_policy_ids, reviewer_name, dc_id, uid,
            ops_advertiser_name, element_fingerprint, first_level_industry_name,
            second_level_industry_name, ai_evaluate_reviewer_name, arrive_time
     FROM (
       SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.tag_id ORDER BY s.id) AS rn
       FROM real_data_samples s
       WHERE s.media_url IS NOT NULL AND s.media_url != ''
         AND s.tag_id IN (${tagIdList.map(() => '?').join(',')})
     ) x WHERE rn <= 8`,
    tagIdList
  )
  console.log(`取到 ${samples.length} 条真实样本（覆盖精度表 50 个标签）`)

  // 按 tag_id 分组样本
  const byTag = {}
  for (const s of samples) {
    if (!byTag[s.tag_id]) byTag[s.tag_id] = []
    byTag[s.tag_id].push(s)
  }

  // 构造 samples_data（工单已关联素材，字段与前端 materialList 归一化解法对齐）
  function buildSamplesData(tagId, n) {
    const pool = byTag[tagId] || []
    if (!pool.length) return []
    const out = []
    for (let i = 0; i < Math.min(n, pool.length); i++) {
      const s = pool[i % pool.length]
      out.push({
        id: s.sample_id || `S-${tagId}-${i}`,
        type: s.element_type || '图片',
        isVideo: /视频|VIDEO/i.test(s.element_type || '') ? 1 : 0,
        mediaUrl: s.media_url || '',
        ocr: s.ocr_content || '',
        asr: s.asr_content || '',
        elementFingerprint: s.element_fingerprint || '',
        dcId: s.dc_id || '',
        policyIds: s.policy_ids || '',
        aiEvaluatePolicyIds: s.ai_evaluate_policy_ids || '',
        reviewerName: s.reviewer_name || s.ai_evaluate_reviewer_name || '',
        advertiserId: s.uid || '',
        opsAdvertiserName: s.ops_advertiser_name || '',
        aiEvaluateReviewerName: s.ai_evaluate_reviewer_name || '',
        firstLevelIndustryName: s.first_level_industry_name || '',
        secondLevelIndustryName: s.second_level_industry_name || '',
        arriveTime: s.arrive_time || '',
        isFp: i % 3 === 0 ? 1 : 0,
        _needTag: i % 2 === 0 ? true : false,
        _remark: i % 2 === 0 ? '经复核判定为误杀，建议调整策略' : '素材合规，维持原判',
      })
    }
    return out
  }

  // 生成工单：4 条 concluded（待采纳）+ 4 条 done（已完结）
  const plans = []
  for (let i = 0; i < 4; i++) plans.push({ status: 'concluded' })
  for (let i = 0; i < 4; i++) plans.push({ status: 'done' })

  const now = new Date('2026-09-02T10:00:00')
  let created = 0
  const startIdx = 100 // 避免与现有 TK00xx 冲突

  // 只保留有可用样本的标签，确保每条工单都能关联到真实素材
  const tagsWithSamples = []
  for (const t of tags) {
    if ((byTag[t.tag_id] || []).length) tagsWithSamples.push(t)
  }
  if (!tagsWithSamples.length) { console.error('没有标签带样本，中止'); process.exit(1) }
  console.log(`其中 ${tagsWithSamples.length} 个标签有样本`)

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]
    // 从有样本的标签中轮询取，保证每个工单都能关联到素材
    const tag = tagsWithSamples[i % tagsWithSamples.length]
    const tagId = tag.tag_id
    const tagName = tag.tag_name || `标签${tagId}`
    const n = 3 + Math.floor(rnd() * 4) // 3~6 条素材
    const sd = buildSamplesData(tagId, n)
    if (!sd.length) { console.log(`标签 ${tagId} 无样本，跳过`); continue }

    const id = `TK${String(startIdx + i)}`
    const concl = CONCLUSIONS[i % CONCLUSIONS.length]
    const cat = CATEGORY[i % CATEGORY.length]
    const rt = RESULT_TYPE[i % RESULT_TYPE.length]
    const daysAgo = 10 - i
    const createdAt = new Date(now.getTime() - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ')

    // 先删同 id（幂等）
    await rawQuery('DELETE FROM tickets WHERE id = ?', [id])
    await rawQuery(
      `INSERT INTO tickets
        (id, title, tag, tag_id, element_type, first_level_industry_name, second_level_industry_name,
         urgency, status, submitter, handler, sample_count, descr, conclusion, handle_reason, need_tag,
         category, category_note, created_at, updated_at, is_demo, conclusion_images, is_qualified,
         handle_remark, result_type, samples_data, notify_users, dc_id, ops_advertiser_name,
         element_fingerprint, ai_evaluate_reviewer_name, cc_users, parent_ticket_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        `${tagName}误杀问题-${i + 1}`,
        tagName,
        tagId,
        sd[0].type || '图片',
        sd[0].firstLevelIndustryName || '未分类',
        sd[0].secondLevelIndustryName || '其他',
        i % 3 === 0 ? 1 : 2,               // urgency: 1=高 2=中 3=低（int 类型）
        p.status,
        'admin',                       // submitter
        'admin',                       // handler
        sd.length,
        `发现「${tagName}」标签下存在批量误杀，涉及多个广告主，样本量 ${sd.length} 条，请协助核查处理。`,
        concl,
        '机审策略阈值过严/模型特征偏差',
        i % 2 === 0 ? 1 : 0,
        p.status === 'done' ? cat : '',
        p.status === 'done' ? '已确认问题分类' : '',
        createdAt,
        createdAt,
        1,                                 // is_demo
        '[]',
        i % 2 === 0 ? 1 : 0,
        '处理备注：已同步策略侧跟进',
        p.status === 'done' ? rt : '',
        JSON.stringify(sd),
        JSON.stringify(['admin']),
        sd[0].dcId || '',
        sd[0].opsAdvertiserName || '',
        sd[0].elementFingerprint || '',
        sd[0].reviewerName || '',
        '[]',
        '',
      ]
    )
    created++
  }
  console.log(`已写入 ${created} 条工单`)

  // 校验状态分布
  const st = await rawQuery('SELECT status, COUNT(*) c FROM tickets GROUP BY status ORDER BY c DESC')
  console.log('\n=== 工单状态分布 ===')
  console.log(st.map(r => `${r.status}: ${r.c}`).join('  '))

  // 校验各状态工单的素材完整性
  const chk = await rawQuery(
    `SELECT id, status, sample_count, LENGTH(samples_data) sdlen,
            LENGTH(conclusion) clen FROM tickets WHERE id LIKE 'TK1%' ORDER BY id`
  )
  console.log('\n=== 新工单素材/结论校验 ===')
  chk.forEach(r => {
    console.log(`${r.id} ${r.status} 样本${r.sample_count}条 samples_data长度${r.sdlen} 结论长度${r.clen}`)
  })

  console.log('\n=== 完成 ===')
  process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
