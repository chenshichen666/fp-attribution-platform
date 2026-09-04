/**
 * rebuildAllData.js — 一键重建全部业务数据（30 标签 / 60 聚类簇 / 趋势 50%→80%）
 *
 * 【为什么需要固定顺序】
 * 各脚本之间存在数据依赖，顺序错了会得到互相矛盾的口径：
 *   1. seedMockData      生成基础骨架（工单/时间线/AI评测/聚类/导入历史）
 *   2. fixPrecisionData  重建精度表（决定各「标签×日期」的误杀率）
 *                        ↓ 依赖：无（精度表由本脚本全量重建）
 *   3. expandSamples     重建样本明细（文案 + 聚类簇 + 误杀标记）
 *                        ↓ 依赖：精度表（按 tag×ds 的误杀率抽样）
 *   4. upgradeMediaCorpus 升级 AI 评测明细文案
 *                        ↓ 依赖：seedMockData 已生成 ai_evaluate_detail
 *   5. upgradeSedimentCorpus 重建结论沉淀库
 *
 * 【幂等】可重复运行，每次都是全量重建。
 *
 * 用法：node src/scripts/rebuildAllData.js
 */

import { runMigrations } from '../db/init.js'

const STEPS = [
  { name: '初始化表结构', file: null, fn: runMigrations },
  { name: '基础业务骨架', file: 'seedMockData.js' },
  { name: '精度数据（趋势 50%→80%）', file: 'fixPrecisionData.js' },
  { name: '样本明细（30 标签 / 500 簇）', file: 'expandSamples.js' },
  { name: 'AI 评测明细文案', file: 'upgradeMediaCorpus.js' },
  { name: '结论沉淀库', file: 'upgradeSedimentCorpus.js' },
  // 必须最后跑：工单「已关联素材」引用样本表最新数据（新文案 + 可访问的图片/视频）
  { name: '刷新工单关联素材', file: 'refreshTicketSamples.js' },
]

async function main() {
  console.log('════════ 开始重建全部业务数据 ════════\n')

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]
    console.log(`\n───── [${i + 1}/${STEPS.length}] ${step.name} ─────`)
    try {
      if (step.fn) {
        await step.fn()
        console.log('     ✅ 完成')
      } else {
        await import(`./${step.file}`)
        console.log('     ✅ 完成')
      }
    } catch (e) {
      console.error(`     ❌ 失败: ${e.message}`)
      console.error(e.stack?.split('\n').slice(0, 3).join('\n'))
      process.exitCode = 1
      return
    }
  }

  console.log('\n════════ 数据重建完成 ════════')
}

main()
