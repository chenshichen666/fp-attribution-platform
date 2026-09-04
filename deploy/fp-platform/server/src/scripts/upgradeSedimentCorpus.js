/**
 * upgradeSedimentCorpus.js — 增强结论沉淀库语料，让「沉淀库搜索」具备真实检索价值
 *
 * 背景：初版 mock 的沉淀结论是模板串「分析发现 XX 标签存在 YY 情况，已更新模型特征，误杀率预计下降 N%」，
 *      可搜索的关键词极少，搜索命中率低、演示效果差。
 *
 * 本脚本重新生成沉淀记录，让每条包含有实质内容的四段式结论：
 *   问题定位 → 根因分析 → 修复方案 → 效果验证
 * 覆盖真实归因场景中的高频关键词（阈值、负样本、特征、OCR、ASR、聚类、白名单、策略等），
 * 使「结论沉淀库搜索」能按关键词召回成组的相关沉淀。
 *
 * 幂等：每次运行先清空再重建，可重复执行。
 *
 * 用法：node src/scripts/upgradeSedimentCorpus.js
 */

import { db } from '../db/pool.js'
// 标签体系与归因知识库统一取自 tagCatalog.js（30 标签口径）
import {
  TAGS, ROOT_CAUSES, FIX_PLANS, CATEGORIES, RESULT_TYPES,
  USERS, USER_NAMES, randInt, pick, resetSeed,
} from './tagCatalog.js'

// 每个问题类型：根因模板 + 方案模板，组合出多样且可检索的结论


// 标签与行业的组合（与 tagCatalog 的 30 标签保持一致）
const TAG_INDUSTRY = TAGS.map(([, name, ind1, ind2]) => [name, ind1, ind2])

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// ============ 主流程 ============
function run() {
  resetSeed(20260903)
  console.log('==> 开始重建结论沉淀库语料...')

  // 清空原有数据（保留表结构）
  try {
    const n = db.prepare('DELETE FROM sediments').run()
    console.log(`    已清空原有 ${n.changes} 条沉淀记录`)
  } catch (e) {
    console.error('  清空失败:', e.message)
    return
  }

  // 获取实际列名，避免插入不存在的列
  const cols = db.pragma('table_info("sediments")').map((c) => c.name)
  console.log(`    sediments 实际列: ${cols.join(', ')}`)

  const insert = db.prepare(`
    INSERT INTO sediments (
      ticket_id, title, type, category, result_type, tag_id, tag_name, tags,
      industry, industry_l1, industry_l2, submitter, handler, adopted_at,
      samples, descr, feature, conclusion, fp_reason, related_materials,
      handle_info, dc_id, ops_advertiser_name, element_fingerprint,
      ai_evaluate_reviewer_name, cc_users, parent_ticket_id, created_at, is_demo
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  let total = 0
  const tx = db.transaction(() => {
    // 每个标签 × 每个问题类型 = 1 条沉淀，共 10 × 6 = 60 条
    for (let ti = 0; ti < TAG_INDUSTRY.length; ti++) {
      const [tagName, ind1, ind2] = TAG_INDUSTRY[ti]
      const tagId = 1001 + ti

      for (let ci = 0; ci < CATEGORIES.length; ci++) {
        const category = CATEGORIES[ci]
        const cause = pick(ROOT_CAUSES[category])
        const plan = pick(FIX_PLANS[category])
        const rt = RESULT_TYPES[(ti + ci) % RESULT_TYPES.length]
        const submitter = USERS[(ti + ci) % USERS.length]
        const handler = USERS[(ti + ci + 1) % USERS.length]
        const drop = randInt(5, 40) // 误杀率下降百分点
        const sampleCnt = randInt(3, 28)
        const createdAt = daysAgo(randInt(1, 90))
        const adoptedAt = daysAgo(randInt(0, 60))

        // 四段式结论：问题定位 → 根因 → 方案 → 验证
        const conclusion = [
          `【问题定位】${tagName} 标签下 ${ind1}-${ind2} 行业素材被批量误判，抽检 ${sampleCnt} 条样本确认属实。`,
          `【根因分析】${cause}。`,
          `【修复方案】${plan}。`,
          `【效果验证】灰度一周后该类目误杀率下降约 ${drop}%，准确率回升至 ${(96 + randInt(0, 35) / 10).toFixed(1)}%，未引入新增漏放。`,
        ].join('\n')

        const descr = `${tagName} 标签在 ${ind1}·${ind2} 场景下的${category}问题归因，涉及 ${sampleCnt} 条素材，已定位根因并完成修复验证。`
        const feature = `${ind1}/${ind2}；素材类型占比 图片 ${randInt(30, 70)}% / 视频 ${randInt(20, 50)}%；主要命中策略 L_${15000 + tagId}_2026`
        const fpReason = cause
        const handleInfo = `${plan}。处理人：${handler}，复核人：${USER_NAMES[(ti + ci + 2) % USER_NAMES.length]}。`

        insert.run(
          `${1000 + ti * 100 + ci}`,                    // ticket_id
          `${tagName}·${category}·${ind2}归因结论`,       // title
          '误杀归因',                                     // type
          category,                                       // category
          rt,                                             // result_type
          String(tagId),                                  // tag_id
          tagName,                                        // tag_name
          JSON.stringify([tagName]),                      // tags
          ind2,                                           // industry
          ind1,                                           // industry_l1
          ind2,                                           // industry_l2
          submitter,                                      // submitter
          handler,                                        // handler
          adoptedAt,                                      // adopted_at
          JSON.stringify([`sample_${tagId}_${ci}_${i0(3)}`]), // samples
          descr,                                          // descr
          feature,                                        // feature
          conclusion,                                     // conclusion
          fpReason,                                       // fp_reason
          JSON.stringify([]),                             // related_materials
          handleInfo,                                     // handle_info
          `DC-${randInt(1000, 9999)}`,                       // dc_id
          `广告主_${randInt(1, 50)}`,                         // ops_advertiser_name
          `fp_${tagId}_${ci}_${randInt(10000, 99999)}`,      // element_fingerprint
          pick(USER_NAMES),                               // ai_evaluate_reviewer_name
          JSON.stringify([USERS[(ti + ci + 2) % 4]]),     // cc_users
          '',                                             // parent_ticket_id
          createdAt,                                      // created_at
          0                                               // is_demo
        )
        total++
      }
    }
  })
  tx()

  console.log(`    已生成 ${total} 条沉淀记录`)

  const stat = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT category) cats, COUNT(DISTINCT tag_name) tags FROM sediments').get()
  console.log('\n==> 沉淀库重建完成')
  console.log(`    总记录数: ${stat.c}`)
  console.log(`    问题类型: ${stat.cats} 类`)
  console.log(`    覆盖标签: ${stat.tags} 个`)

  // 抽样核对
  console.log('\n==> 抽样核对:')
  const demo = db.prepare('SELECT title, category, substr(conclusion,1,90) c FROM sediments LIMIT 2').all()
  for (const d of demo) {
    console.log(`    [${d.category}] ${d.title}`)
    console.log(`      ${d.c}...`)
  }
}

// 生成定长序号
function i0(n) { return String(randInt(0, 10 ** n - 1)).padStart(n, '0') }

run()
