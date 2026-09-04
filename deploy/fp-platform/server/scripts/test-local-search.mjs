/**
 * 本地检索引擎冒烟测试
 * 验证：文本类 / 指纹类 / 视觉类 三种任务是否都能召回有层次的近邻
 */

import { localSearch } from '../src/trag/localEngine.js'

async function test(name, params) {
  console.log(`\n===== ${name} =====`)
  console.log(`  task=${params.task}  query="${String(params.query).slice(0, 40)}"`)
  try {
    const t0 = Date.now()
    const r = await localSearch(params)
    const ms = Date.now() - t0
    console.log(`  引擎: ${r.engineNote}`)
    console.log(`  耗时: ${ms}ms  召回: ${r.total} 条`)
    for (const it of r.results.slice(0, 5)) {
      const txt = (it.ocr_content || it.asr_content || it.element_value || '').slice(0, 34)
      console.log(`    ${String(it.score).padEnd(7)} [${it.class_id}] ${txt}`)
    }
    if (!r.results.length) console.log('    ⚠️  无召回')
  } catch (e) {
    console.log(`  ❌ 失败: ${e.message}`)
  }
}

// 1. 文本类：用一句真实话术去检索，应召回同簇素材
await test('文本检索 · 图片OCR', {
  task: 'image_ocr',
  query: '深夜福利 美女主播在线热舞 免费观看 点击进入房间',
  limit: 5,
})

// 2. 文本类 · 视频 ASR
await test('文本检索 · 视频ASR', {
  task: 'video_asr',
  query: '稳赚不赔 日入过万 内部渠道',
  limit: 5,
})

// 3. 文本类 · 用部分关键词（模拟用户手输）
await test('文本检索 · 关键词片段', {
  task: 'text_text',
  query: '限时特惠 抢完即止',
  limit: 5,
})

// 4. 指纹类：取一条真实指纹去检索
const { db } = await import('../src/db/pool.js')
const fpRow = db.prepare(`SELECT element_fingerprint FROM real_data_samples WHERE element_fingerprint != '' LIMIT 1`).get()
await test('指纹检索 · video_video', {
  task: 'video_video',
  query: fpRow?.element_fingerprint || 'fp_1001_0_12345',
  limit: 5,
})

// 5. 视觉类：用一条真实 media_url 去检索
const urlRow = db.prepare(`SELECT media_url FROM real_data_samples WHERE media_url != '' LIMIT 1`).get()
await test('视觉检索 · 图片→图片', {
  task: 'image_image_shangshu',
  query: urlRow?.media_url || '',
  limit: 5,
})

// 6. 带过滤条件
await test('文本检索 · 带标签过滤', {
  task: 'image_ocr',
  query: '限时特惠 原价999现价99 仅限今日',
  limit: 5,
  tags: ['1004'],
})

console.log('\n===== 测试结束 =====')
