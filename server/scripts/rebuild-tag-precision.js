/**
 * 重建 real_data_tag_precision 周维度精度数据（mock）
 *
 * 目标：
 * 1. 使用真实 tag_id（从 real_data_tags 取 50 个），而非虚拟 1-50
 * 2. 周维度趋势改为 15 周（W1~W15），W1=50%，前三周 <=65%
 * 3. 趋势有上有下（治理后上涨，偶尔下降），非单调上升
 * 4. 50 个标签精度分级分布：异常 / 低 / 一般 / 高 都要有
 * 5. 每个标签精度必须在 (0, 100) 开区间，不能是 0% 或 100%
 */
import { rawQuery } from '../src/db/pool.js'

// ── 确定性伪随机（保证多次生成结果一致） ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260902)

// ── 15 周的日期（每周一） ──
const WEEKS = []
{
  // 结束周固定在 2026-08-31（周一），往前推 14 周
  let d = new Date('2026-08-31T00:00:00')
  for (let i = 0; i < 15; i++) WEEKS.push(d.toISOString().slice(0, 10)), d = new Date(d.getTime() - 7 * 86400000)
  WEEKS.reverse()
}

// ── 大盘基准精度曲线（15周）：W1=50，前三周<=65，之后治理上升但有回落 ──
// 体现"低 → 治理后上涨 → 有时下降"的自然波动
const BASE_CURVE = [
  50.0, // W1  起点 50%
  55.0, // W2  <=65
  62.0, // W3  <=65
  67.5, // W4
  75.0, // W5
  71.5, // W6  回落
  78.0, // W7
  82.0, // W8
  79.5, // W9  回落
  85.0, // W10
  88.0, // W11
  86.0, // W12 回落
  90.0, // W13
  89.0, // W14 回落
  92.0, // W15
]

// ── 50 个标签的精度档位规划 ──
// tier: abnormal(异常 <=60) / low(低 61-74) / mid(一般 75-85) / high(高 >85)
// 每个标签直接指定「W15 终值」的绝对精度区间（不依赖大盘），确保各档精准落位
// 起点统一较低（治理前普遍差），终值按档位分布 → 形成"低 → 治理后上涨"趋势
function buildTierPlan(n) {
  const plan = []
  // 分级配比：异常 8 / 低 14 / 一般 16 / 高 12 = 50（四档齐全）
  const dist = [
    ...Array(8).fill('abnormal'),
    ...Array(14).fill('low'),
    ...Array(16).fill('mid'),
    ...Array(12).fill('high'),
  ]
  // 各档位 W15 终值的绝对精度区间（直接指定，保证分档明确）
  const finalRange = {
    abnormal: [40, 58],   // 异常：<=60
    low: [63, 73],        // 低：61-74
    mid: [77, 84],        // 一般：75-85
    high: [88, 96],       // 高：>85
  }
  // 起点（W1）与终值（W15）都按档位设定（W1 强制 50%，见 seriesFor）：
  // 起点略低于终值（体现"治理前差、治理后上涨"），但差距适中，
  // 保证「15周聚合精度」也落在目标档位（否则会被早期低值拖低导致高档消失）
  const startRange = {
    abnormal: [30, 42],   // 聚合 <=60
    low: [52, 60],        // 聚合 61-74
    mid: [70, 76],        // 聚合 75-85
    high: [84, 90],       // 聚合 >85（提高起点，抵消中期回落对聚合值的拖累）
  }
  for (let i = 0; i < n; i++) {
    const tier = dist[i % dist.length]
    const [lo, hi] = finalRange[tier]
    const finalPrec = lo + rnd() * (hi - lo)
    const [slo, shi] = startRange[tier]
    const startPrec = slo + rnd() * (shi - slo)
    plan.push({ tier, startPrec, finalPrec })
  }
  return plan
}

// 按标签生成 15 周精度：从 startPrec 线性走向 finalPrec（前端折线为直线）
// 叠加小幅波动但保持整体上行，前三周受 <=65 约束
function seriesFor(p) {
  const out = []
  const finalPrec = p.finalPrec
  for (let w = 0; w < 15; w++) {
    const t = w / 14 // 0 ~ 1（W1 → W15）
    // 主趋势：起点 → 终点线性插值（前端折线为直线段）
    let v = p.startPrec + (finalPrec - p.startPrec) * t
    // 治理过程波动：中间周有小幅起伏，首尾收敛为 0（保证 W1/W15 精确落位）
    const amp = 3.0 * Math.sin(Math.PI * t)
    v += (rnd() - 0.5) * 2 * amp
    // 叠加一次中期回落（治理后偶发下降），幅度小且中间大
    if (w >= 5 && w <= 9) v -= (rnd() * 2.0)
    // 首周强制落位 50%（大盘 W1 基准，治理起点）
    if (w === 0) v = 50.0
    // 前三周上限约束：W2/W3 不得超过 65%
    if (w === 1) v = Math.min(v, 56.0)
    if (w === 2) v = Math.min(v, 62.0)
    if (w < 3) v = Math.min(v, 65)
    // 末周精确落位：W15 精确等于档位终值（分级判定依据）
    if (w === 14) v = finalPrec
    // clamp 开区间，杜绝 0% 和 100%
    v = Math.max(2.5, Math.min(97.5, v))
    out.push(Math.round(v * 10) / 10)
  }
  return out
}

async function main() {
  console.log('=== 开始重建 real_data_tag_precision（15周 × 50标签）===')

  // 1. 取 50 个真实 tag（优先取样本量大、有名字的）
  const tagRows = await rawQuery(
    `SELECT tag_id, tag_name FROM real_data_tags
      WHERE tag_name IS NOT NULL AND tag_name != ''
      ORDER BY total DESC LIMIT 50`
  )
  if (tagRows.length < 50) {
    console.error(`real_data_tags 仅 ${tagRows.length} 个有效标签，不足 50，中止`)
    process.exit(1)
  }
  console.log(`取到 ${tagRows.length} 个真实标签`)

  // 2. 清空精度表（mock 模式下的正式表）
  await rawQuery('DELETE FROM real_data_tag_precision')
  console.log('已清空 real_data_tag_precision')

  const plan = buildTierPlan(50)
  const INDUSTRIES = ['医疗健康', '电商服务', '美妆个护', '数字传媒内容', '食品饮料', '通讯和IT服务', '游戏', '生活日用']
  const ELEMENT_TYPES = [
    ['ELEMENT_TYPE_IMAGE', '图片'],
    ['ELEMENT_TYPE_VIDEO', '视频'],
    ['ELEMENT_TYPE_TEXT', '文本'],
  ]

  // 3. 批量生成：50 标签 × 15 周 = 750 行
  const rows = []
  for (let i = 0; i < 50; i++) {
    const tag = tagRows[i]
    const p = plan[i]
    const series = seriesFor(p)
    for (let w = 0; w < 15; w++) {
      const ds = WEEKS[w]
      const prec = series[w]
      // 样本量：每周每标签 30~120，保证 fp>=100（异常档在末周需满足）
      const total = Math.round(30 + rnd() * 90)
      // fp = total * (1 - prec/100)，向上取整保证精度略低于理论值（避免 100%）
      let fp = Math.ceil(total * (1 - prec / 100))
      // 保证 fp 至少 1，total 至少 1（非 0% 非 100%）
      fp = Math.max(1, Math.min(total - 1, fp))
      const tp = total - fp
      const fpConf = Math.round(fp * (0.7 + rnd() * 0.3))
      const [et, etn] = ELEMENT_TYPES[i % ELEMENT_TYPES.length]
      rows.push([
        tag.tag_id,
        tag.tag_name,
        total,
        fp,
        prec,
        total, // sample_count
        INDUSTRIES[i % INDUSTRIES.length],
        '',
        et,
        etn,
        ds, // arrive_time
        ds, // ds
        'v2.3.0',
        '',
        '',
        '',
        tp,
        fpConf,
        0,
        0,
        Math.round(prec * 10) / 10, // review_model_precision_prime
      ])
    }
  }

  // 4. 分批插入
  const COLS = `tag_id,tag_name,total,fp,precision_val,sample_count,
    first_level_industry_name,second_level_industry_name,element_type,element_type_name,
    arrive_time,ds,model_version,element_fingerprint,remark,fp_reason,
    tp,fp_conf,tn,fn,review_model_precision_prime`
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const ph = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const flat = chunk.flat()
    await rawQuery(`INSERT INTO real_data_tag_precision (${COLS}) VALUES ${ph}`, flat)
  }
  console.log(`已插入 ${rows.length} 行（50 标签 × 15 周）`)

  // 5. 校验：大盘周趋势 + 标签分级分布
  const weeks = await rawQuery(
    `SELECT ds, SUM(tp) tp, SUM(fp) fp FROM real_data_tag_precision GROUP BY ds ORDER BY ds`
  )
  console.log('\n=== 大盘周精度趋势（15周）===')
  weeks.forEach((r, i) => {
    const tot = Number(r.tp) + Number(r.fp)
    const pr = tot > 0 ? (Number(r.tp) / tot * 100).toFixed(1) : 0
    console.log(`W${String(i + 1).padStart(2)} ${r.ds}  精度 ${pr}%`)
  })

  // 各标签最终精度（W15）与分级
  const tags = await rawQuery(
    `SELECT tag_id, tag_name,
       ROUND(SUM(tp)/NULLIF(SUM(tp)+SUM(fp),0)*100, 1) AS prec,
       SUM(tp)+SUM(fp) AS tot, SUM(fp) AS fp
     FROM real_data_tag_precision GROUP BY tag_id, tag_name ORDER BY prec ASC`
  )
  const tiers = { abnormal: 0, low: 0, mid: 0, high: 0 }
  tags.forEach(t => {
    const pr = Number(t.prec)
    if (pr <= 60) tiers.abnormal++
    else if (pr <= 74) tiers.low++
    else if (pr <= 85) tiers.mid++
    else tiers.high++
  })
  console.log('\n=== 标签精度分级分布（共 ' + tags.length + ' 个）===')
  console.log(`异常(<=60): ${tiers.abnormal}  低(61-74): ${tiers.low}  一般(75-85): ${tiers.mid}  高(>85): ${tiers.high}`)
  console.log('最低精度:', tags[0].prec, '%  最高精度:', tags[tags.length - 1].prec, '%')
  const zeroOrHundred = tags.filter(t => Number(t.prec) <= 0 || Number(t.prec) >= 100)
  console.log('0%/100% 的标签数:', zeroOrHundred.length, zeroOrHundred.length === 0 ? '✓' : '✗')

  console.log('\n=== 完成 ===')
  process.exit(0)
}

main().catch(e => {
  console.error('失败:', e.message)
  process.exit(1)
})
