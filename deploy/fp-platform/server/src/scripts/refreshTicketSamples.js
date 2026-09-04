/**
 * refreshTicketSamples.js — 用最新样本表刷新工单的「已关联素材」
 *
 * 为什么需要这一步：
 * seedMockData 在流水线前段执行，其工单素材取自【当时的】样本表；
 * 而样本表随后被 expandSamples 全量重建（新文案 + 新媒体地址）。
 * 若不刷新，工单里展示的还是旧域名（demo-media.example.com）的失效链接。
 *
 * 本脚本必须放在 rebuildAllData 流水线【最后】执行：
 *   - 按 tag_id 从 real_data_samples 随机取 6~12 条真实素材
 *   - media_url 直接使用样本表最新值（picsum 图片 / Google 公共示例视频）
 *   - 保留工单上已有的打标状态（needTag），不覆盖人工操作
 *
 * 用法：node src/scripts/refreshTicketSamples.js
 */

import { db } from '../db/pool.js'

function run() {
  console.log('==> 刷新工单关联素材（对齐最新样本表）...')

  const tickets = db.prepare(`SELECT id, tag_id, samples_data FROM tickets`).all()
  if (!tickets.length) {
    console.warn('    ⚠️ 无工单，跳过')
    return
  }

  const pickSamples = db.prepare(`
    SELECT sample_id, element_type, is_video, media_url, ocr_content, asr_content,
           element_fingerprint, dc_id, ops_advertiser_name, ai_evaluate_reviewer_name,
           policy_ids, ai_evaluate_policy_ids,
           first_level_industry_name, second_level_industry_name
    FROM real_data_samples WHERE tag_id = ? ORDER BY RANDOM() LIMIT ?
  `)
  const update = db.prepare(`UPDATE tickets SET samples_data = ?, sample_count = ? WHERE id = ?`)

  let n = 0, sampleTotal = 0
  const tx = db.transaction(() => {
    for (const t of tickets) {
      // 保留原打标状态（按 sampleId 对齐）
      let prev = []
      try { prev = JSON.parse(t.samples_data || '[]') } catch { prev = [] }
      const needTagMap = new Map(prev.map((s) => [s.sampleId, s.needTag || '']))

      const cnt = Math.min(prev.length || 0, 12) || 6 + (t.id.charCodeAt(t.id.length - 1) % 7)
      const rows = pickSamples.all(t.tag_id || 1001, cnt)
      if (!rows.length) continue

      const samplesData = rows.map((r) => ({
        sampleId: r.sample_id,
        elementType: r.element_type,
        isVideo: Number(r.is_video) === 1,
        mediaUrl: r.media_url || '',
        ocrContent: r.ocr_content || '',
        asrContent: r.asr_content || '',
        elementFingerprint: r.element_fingerprint || '',
        dcId: r.dc_id || '',
        advertiserId: r.ops_advertiser_name || '',
        uid: r.uid || `adv_${1000 + (n % 9000)}`,
        reviewerName: r.ai_evaluate_reviewer_name || '',
        machineTag: r.policy_ids || '',
        humanTag: r.ai_evaluate_policy_ids || '',
        // 打标三态：'' 未选 / 'need' 需要 / 'no' 无需
        needTag: needTagMap.get(r.sample_id) || '',
        industryL1: r.first_level_industry_name || '',
        industryL2: r.second_level_industry_name || '',
      }))

      update.run(JSON.stringify(samplesData), samplesData.length, t.id)
      n++
      sampleTotal += samplesData.length
    }
  })
  tx()

  console.log(`    已刷新 ${n} 个工单、共 ${sampleTotal} 条素材`)

  // 清空「精度样本明细表」：它由 tags.js 在首次访问时 lazy 填充（从样本表导入 FP 明细）。
  // 若不清空，里面会残留 rebuild 之前的旧媒体地址（demo-media.example.com，无法访问）。
  // 清空后下次访问自动重新填充 = 与最新样本表保持一致。
  try {
    const c = db.prepare(`DELETE FROM real_data_tag_precision_samples`).run()
    console.log(`    已清空 real_data_tag_precision_samples（${c.changes} 条，访问时自动重灌）`)
  } catch { /* 表可能尚未创建 */ }
}

run()
