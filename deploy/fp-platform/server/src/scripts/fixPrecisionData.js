/**
 * fixPrecisionData.js — 重建精度数据（30 标签 · 趋势 50%→80% 波动上升）
 *
 * 【口径建模】
 * 审核系统混淆矩阵（以「机审判定违规」为正例）：
 *     TP = 判定违规且确实违规（判对）    FP = 判定违规但实为正常（误杀）
 *     TN = 判定正常且确实正常（判对）    FN = 判定正常但实为违规（漏放）
 *     total = TP + FP + TN + FN
 *
 *     大盘精度 = TP / (TP + FP)
 *     绝对精度 = TP / (TP + FP_confirmed)
 *
 * FP_confirmed = 经人工复核确认的误杀（⊆ FP），故绝对精度恒略高于大盘，
 * 且由同一组 TP 驱动 —— 两条线趋势天然一致。
 *
 * 【趋势要求（用户明确）】
 *   1. 周维度整体从 ~50% 提升至 ~80%
 *   2. 过程有波动：既有上升也有回落，不是单调直线
 *   3. 不出现 0% 或 100% 的极端值
 *
 * 实现：trend(50→80 线性) + 长周期波(sin) + 短周期波(sin) + 小噪声，
 *      最后 clamp 到 [44, 86]，从数学上排除 0% / 100%。
 *
 * 【依赖】标签体系统一取自 tagCatalog.js
 *
 * 用法：node src/scripts/fixPrecisionData.js
 */

import { db } from '../db/pool.js'
import { TAGS, INDUSTRY, ELEMENT_TYPES, randInt, rnd, resetSeed, toDateStr, weekStartOf } from './tagCatalog.js'

// ===== 趋势参数 =====
//
// 关键：real_data_tag_precision 的 ds 语义是「周起始日」而非「每一天」。
// 后端 overview/trends 的聚合分支执行 `GROUP BY ds`，若 ds 是每天，
// 周维度就会退化成"最近 15 天"，趋势与波动全部失真。
// 因此这里按周生成，ds = 该周周一。
const TOTAL_WEEKS = 13       // 13 周，周维度有足够数据点呈现趋势与波动
const START_PREC = 50        // 起始精度
const END_PREC = 80          // 收尾精度
// 上下限收紧，从数学上排除 0% / 100%：
// 精度 = trend(50~80) + 标签偏移(±10) + 波动(±8)，
// 理论极值约 [32, 98]，用 [36, 93] 夹住后，
// 即使叠加取整误差也不会出现 0% 或 100% 的标签。
const MIN_PREC = 36          // 下限：无 0%
const MAX_PREC = 93          // 上限：无 100%

// ===== 标签精度档位分布 =====
// 各标签给一个固定的精度偏移，让 30 个标签散布在不同精度档，
// 而不是全部挤在同一条曲线上（用户要求「各个精度档都有分布」）。
// 偏移取 -10 ~ +10 均匀铺开，均值 0 —— 保证整体趋势仍是 50%→80%。
function tagPrecisionOffset(tagIdx) {
  // 跨度 ±22：实测 ±10 只覆盖 3 档、±17 覆盖 4 档。
  // 加大到 ±22 后区间约 [43%, 87%]，可覆盖 5 个精度档（含 50% 以下）。
  // 均值仍为 0，保证整体趋势不受影响（仍是 50%→80%）。
  return -22 + (tagIdx * 44) / (TAG_COUNT - 1)
}

// 每周的变体数（行业 × 素材类型），控制数据量
const INDUSTRY_VARIANTS = 2
const TYPE_VARIANTS = 2

// 标签总数（用于相位对称计算）
const TAG_COUNT = 30

// 最近 n 周的「周一」日期列表（升序）
// 注意：必须用本地时区格式化（toDateStr），用 toISOString 会在 GMT+8 下差一天
function weekStartList(n) {
  const out = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monday)
    d.setDate(monday.getDate() - i * 7)
    out.push(toDateStr(d))
  }
  return out
}

/**
 * 计算某天某标签的目标精度
 *
 * 波动设计的要点：最终呈现给用户的曲线是「按周聚合」后的结果，
 * 而聚合会平滑掉高频噪声，因此：
 *   - 相位差必须小（各标签同向波动），否则 30 个标签互相抵消，聚合后变单调直线
 *   - 主波动周期要长于一周（约 7 周），否则被周聚合抹平
 *   - 波动下降速率要大于趋势上升速率，才能真正出现「回落」
 *     趋势约 2.5pp/周，长波振幅 7pp、半周期 3.5 周 → 最大降幅约 6.3pp/周 > 2.5pp/周 ✓
 *
 * @param {number} dayIdx 天索引（0 起）
 * @param {number} tagIdx 标签索引
 */
function targetPrecision(weekIdx, tagIdx) {
  const progress = TOTAL_WEEKS > 1 ? weekIdx / (TOTAL_WEEKS - 1) : 1
  // 主趋势：50% → 80%（叠加该标签的档位偏移，使各标签分布在不同精度档）
  const trend = START_PREC + (END_PREC - START_PREC) * progress + tagPrecisionOffset(tagIdx)

  // 相位设计有两个约束：
  // 1) 跨度必须小 —— 若取 tagIdx * 0.15，30 个标签相位跨度达 4.35 弧度（> 2π），
  //    聚合时各标签波动互相抵消，曲线被压成近乎单调的直线（实测仅 1 次回落）。
  // 2) 必须**以 0 为中心对称** —— 若直接用 tagIdx * 0.03，相位均值是 +0.435 而非 0，
  //    会造成首尾不对称：起点被抬 +3.4pp（50→53.2）、终点被压 -3.4pp（80→76.8）。
  //    因此减去中位索引，使相位均值归零。
  const phase = (tagIdx - (TAG_COUNT - 1) / 2) * 0.03

  // 长周期波动：振幅 6pp
  // 频率取 π*3.0 而非 π*3.4 —— 后者在 progress=1 时处于波谷（sin(3.4π)≈-0.95），
  // 会把终点从 80% 压到 77%；π*3.0 在首尾均为 0 相位，保证起点 50% / 终点 80% 不被平移。
  // 13 周内约 1.5 个周期，中途自然出现「冲高—回落—再冲高」的形态。
  // 注意：这里必须用 progress（分母 TOTAL_WEEKS-1），与 trend 保持一致。
  // 曾误用 weekIdx/TOTAL_WEEKS，导致首尾相位不为 0，终点被波动项推高 6pp 撞到上限。
  const waveLong = Math.sin(progress * Math.PI * 3.0 + phase) * 6.0
  // 中周期波动（振幅 2pp）：叠加锯齿感，制造小幅反复
  const waveMid = Math.sin(progress * Math.PI * 7.0 + phase) * 2.0
  // 随机噪声
  const noise = (rnd() - 0.5) * 1.2

  let p = trend + waveLong + waveMid + noise
  // 硬性边界：保证不会出现 0% / 100%
  if (p < MIN_PREC) p = MIN_PREC
  if (p > MAX_PREC) p = MAX_PREC
  return p
}

function run() {
  resetSeed(20260903)
  console.log('==> 开始重建精度数据（30 标签 · 趋势 50%→80%）...')

  // 1. 确保样本表有 fp_confirmed 列
  const sampleCols = db.pragma('table_info("real_data_samples")').map((c) => c.name)
  const hasFpConfirmed = sampleCols.includes('fp_confirmed')
  if (!hasFpConfirmed) {
    try {
      db.prepare(`ALTER TABLE real_data_samples ADD COLUMN fp_confirmed INTEGER NOT NULL DEFAULT 0`).run()
      console.log('    已为 real_data_samples 添加 fp_confirmed 列')
    } catch (e) {
      console.error('    添加 fp_confirmed 列失败:', e.message)
    }
  }

  // 2. 清空重建精度聚合表
  try {
    const n1 = db.prepare('DELETE FROM real_data_tag_precision').run()
    console.log(`    已清空 real_data_tag_precision（${n1.changes} 条）`)
  } catch (e) {
    console.error('    清空精度表失败:', e.message); return
  }

  const dsList = weekStartList(TOTAL_WEEKS) // ds = 各周周一
  const insertPrecision = db.prepare(`
    INSERT INTO real_data_tag_precision (
      tag_id, tag_name, total, fp, precision_val, tp, fp_conf, tn, fn, sample_count,
      first_level_industry_name, second_level_industry_name, element_type, element_type_name,
      arrive_time, ds, model_version, element_fingerprint, remark, fp_reason,
      review_model_precision_prime
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  let precCount = 0
  const precTx = db.transaction(() => {
    TAGS.forEach(([tagId, tagName, defInd1, defInd2], tagIdx) => {
      for (let d = 0; d < TOTAL_WEEKS; d++) {
        const ds = dsList[d]
        const precision = targetPrecision(d, tagIdx)

        for (let iv = 0; iv < INDUSTRY_VARIANTS; iv++) {
          // 行业变体：优先用标签自带行业，其次轮转
          const [ind1, ind2] = iv === 0
            ? [defInd1, defInd2]
            : INDUSTRY[(tagIdx + d + iv) % INDUSTRY.length]

          for (let tv = 0; tv < TYPE_VARIANTS; tv++) {
            const [elType, elTypeName] = ELEMENT_TYPES[(tagIdx + d + tv) % ELEMENT_TYPES.length]

            const total = randInt(400, 1800)
            const positiveRate = 0.25 + rnd() * 0.15 // 机审判定违规占比 25%~40%
            const positives = Math.max(2, Math.round(total * positiveRate))
            // 误杀量（FP）必须 ≥ 1：精度上限已被 clamp 到 93%，
            // 正常不会算出 0；这里再兜底，避免页面出现「误杀量 0」这种不合业务常理的值。
            const fp = Math.max(1, Math.min(positives - 1, Math.round(positives * (1 - precision / 100))))
            const tp = positives - fp
            const negatives = total - positives
            const fn = Math.max(0, Math.round(negatives * (0.01 + rnd() * 0.03)))
            const tn = negatives - fn
            if (tp + fp + tn + fn !== total) continue // 恒等式自检

            // 确认误杀 = 误杀 × ratio
            //
            // ratio 决定了「绝对精度」与「大盘精度」的间距：
            //   差 ≈ fpRate × (1-ratio) / (1 - fpRate×ratio)
            // 取 0.86~0.95 时间距约 3.8pp（偏大），收紧到 0.93~0.97 后降到 1~2pp，
            // 更符合「趋势一致且相近」的要求，同时保持 绝对 ≥ 大盘 的业务语义。
            const ratio = 0.93 + rnd() * 0.04
            const fpConf = Math.max(1, Math.round(fp * ratio))

            const precVal = Number((tp / (tp + fp)).toFixed(4))
            const absVal = Number((tp / (tp + fpConf)).toFixed(4))

            insertPrecision.run(
              tagId, tagName, total, fp, precVal, tp, fpConf, tn, fn, total,
              ind1, ind2, elType, elTypeName,
              `${ds} ${String(randInt(0, 23)).padStart(2, '0')}:00:00`, ds, 'v2.1',
              '', '', '', Number(absVal.toFixed(4))
            )
            precCount++
          }
        }
      }
    })
  })
  precTx()
  console.log(`    已重建 ${precCount} 条精度记录（${TAGS.length} 标签 × ${TOTAL_WEEKS} 周 × ${INDUSTRY_VARIANTS} 行业 × ${TYPE_VARIANTS} 类型）`)

  // 3. 同步样本表（兼容：单独运行本脚本时也能让样本表跟上精度表）
  //
  //    ⚠️ 注意：这里按【标签整体】配额，会抹掉样本表的周趋势
  //    （is_fp 均匀铺到各周 → 近7天精度退化成全期均值，实测 KPI 从 80% 掉到 65.8%）。
  //    完整初始化请跑 rebuildAllData.js：其顺序为 本脚本 → expandSamples，
  //    后者按 (标签, 周) 概率抽样，能正确还原周趋势并覆盖这里的粗糙分配。
  //    若只单独运行本脚本，请务必随后补跑 expandSamples.js。
  const samples = db.prepare(`SELECT id, tag_id FROM real_data_samples`).all()
  if (samples.length) {
    const tagStat = {}
    for (const [tagId] of TAGS) {
      const row = db.prepare(`
        SELECT SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fc FROM real_data_tag_precision WHERE tag_id = ?
      `).get(tagId)
      const tp = Number(row?.tp) || 0
      const fp = Number(row?.fp) || 0
      const fc = Number(row?.fc) || 0
      tagStat[tagId] = {
        fpRate: tp + fp > 0 ? fp / (tp + fp) : 0.1,
        confRatio: fp > 0 ? fc / fp : 0.9,
      }
    }
    const byTag = new Map()
    for (const s of samples) {
      if (!byTag.has(s.tag_id)) byTag.set(s.tag_id, [])
      byTag.get(s.tag_id).push(s)
    }
    const upd = db.prepare(`UPDATE real_data_samples SET is_fp = ?, fp_confirmed = ? WHERE id = ?`)
    let n = 0
    const tx2 = db.transaction(() => {
      for (const [tagId, list] of byTag) {
        const st = tagStat[tagId] || { fpRate: 0.1, confRatio: 0.9 }
        const fpQuota = Math.round(list.length * st.fpRate)
        const confQuota = Math.round(fpQuota * st.confRatio)
        const shuffled = [...list]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = randInt(0, i)
          ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }
        for (let i = 0; i < shuffled.length; i++) {
          upd.run(i < fpQuota ? 1 : 0, i < confQuota ? 1 : 0, shuffled[i].id)
          n++
        }
      }
    })
    tx2()
    console.log(`    已同步 ${n} 条样本的 is_fp / fp_confirmed（按标签精确配额）`)
  }

  // 4. 同步标签汇总表
  try { db.prepare('DELETE FROM real_data_tags').run() } catch { /* ignore */ }
  const insertTag = db.prepare(`
    INSERT INTO real_data_tags (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason)
    VALUES (?,?,?,?,?,?,?,?)
  `)
  db.transaction(() => {
    let rank = 1
    const agg = db.prepare(`
      SELECT tag_id, tag_name, SUM(total) total, SUM(fp) fp, SUM(tp) tp
      FROM real_data_tag_precision GROUP BY tag_id, tag_name ORDER BY SUM(fp) DESC
    `).all()
    for (const r of agg) {
      const total = Number(r.total) || 0
      const fp = Number(r.fp) || 0
      const tp = Number(r.tp) || 0
      const prec = tp + fp > 0 ? Number((tp / (tp + fp) * 100).toFixed(2)) : 0
      insertTag.run(r.tag_id, r.tag_name, total, fp, prec, rank, '', '')
      rank++
    }
  })()

  // 5. 自检：全量口径 + 周维度趋势
  reportCheck()
}

function reportCheck() {
  const s = db.prepare('SELECT COUNT(*) n, SUM(is_fp) fp, SUM(COALESCE(fp_confirmed,0)) fc FROM real_data_samples').get()
  const p = db.prepare('SELECT SUM(total) total, SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fc, SUM(tn) tn, SUM(fn) fn FROM real_data_tag_precision').get()

  console.log('\n==> 口径自检')
  const okIdentity = (p.tp + p.fp + p.tn + p.fn) === p.total
  console.log(`    混淆矩阵恒等式: ${okIdentity ? '✅ 成立' : '❌ 不成立'} (${p.tp}+${p.fp}+${p.tn}+${p.fn} vs ${p.total})`)
  if (s.n) {
    console.log(`    样本表精度: ${((s.n - s.fp) / s.n * 100).toFixed(1)}%  绝对: ${((s.n - s.fc) / s.n * 100).toFixed(1)}%`)
  }
  console.log(`    大盘精度  : ${(p.tp / (p.tp + p.fp) * 100).toFixed(1)}%`)
  console.log(`    绝对精度  : ${(p.tp / (p.tp + p.fc) * 100).toFixed(1)}%`)

  // 周维度趋势（按 ds 归并到自然周）
  const rows = db.prepare(`
    SELECT ds, SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fc, SUM(total) total
    FROM real_data_tag_precision GROUP BY ds ORDER BY ds
  `).all()

  const weekMap = new Map()
  for (const r of rows) {
    if (!r.ds) continue
    const wk = weekStartOf(r.ds)
    if (!weekMap.has(wk)) weekMap.set(wk, { tp: 0, fp: 0, fc: 0, total: 0 })
    const w = weekMap.get(wk)
    w.tp += Number(r.tp) || 0
    w.fp += Number(r.fp) || 0
    w.fc += Number(r.fc) || 0
    w.total += Number(r.total) || 0
  }

  const weeks = [...weekMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  console.log('\n==> 周维度趋势（大盘 / 绝对）')
  const pans = [], abs = []
  weeks.forEach(([wk, w], i) => {
    const pr = w.tp / (w.tp + w.fp) * 100
    const ab = w.tp / (w.tp + w.fc) * 100
    pans.push(pr); abs.push(ab)
    const arrow = i > 0 ? (pr >= pans[i - 1] ? '↑' : '↓') : ' '
    console.log(`    W${String(i + 1).padStart(2)} [${wk}]  大盘 ${pr.toFixed(1).padStart(5)}%  ${arrow}   绝对 ${ab.toFixed(1).padStart(5)}%   差 ${Math.abs(pr - ab).toFixed(1)}pp`)
  })

  const first = pans[0], last = pans[pans.length - 1]
  const minP = Math.min(...pans), maxP = Math.max(...pans)
  const minA = Math.min(...abs), maxA = Math.max(...abs)
  const gaps = pans.map((v, i) => Math.abs(v - abs[i]))
  const maxGap = Math.max(...gaps)
  // 统计"回落"次数（比上周低）
  const drops = pans.filter((v, i) => i > 0 && v < pans[i - 1]).length

  console.log('\n==> 趋势校验')
  console.log(`    起点 ${first.toFixed(1)}%  →  终点 ${last.toFixed(1)}%   （目标 50% → 80%）`)
  console.log(`    区间 大盘 [${minP.toFixed(1)}%, ${maxP.toFixed(1)}%] / 绝对 [${minA.toFixed(1)}%, ${maxA.toFixed(1)}%]`)
  console.log(`    回落次数: ${drops} 次（>0 表示有波动，非单调）`)
  console.log(`    两线最大差: ${maxGap.toFixed(1)}pp`)
  const noExtreme = minP > 5 && maxP < 95 && minA > 5 && maxA < 95
  console.log(`    无 0%/100% 极端值: ${noExtreme ? '✅' : '❌'}`)
  const trendOk = first < 60 && last > 70 && drops > 0 && noExtreme && maxGap <= 4
  console.log(`\n    ${trendOk ? '✅ 趋势符合要求：整体上行 + 有波动 + 两线相近 + 无极端值' : '⚠️ 需调整'}`)

  // ===== 标签维度校验：精度档分布 / 无 0%·100% / FP 非零 =====
  const tagRows = db.prepare(`
    SELECT tag_id, tag_name,
           SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fc, SUM(total) total
    FROM real_data_tag_precision GROUP BY tag_id, tag_name ORDER BY tag_id
  `).all()

  const BANDS = [
    [0, 50, '50% 以下'], [50, 60, '50-60%'], [60, 70, '60-70%'],
    [70, 80, '70-80%'], [80, 90, '80-90%'], [90, 100, '90% 以上'],
  ]
  const bandCount = BANDS.map(() => 0)
  let zeroPrec = 0, fullPrec = 0, zeroFp = 0
  const tagPrecs = []

  for (const r of tagRows) {
    const tp = Number(r.tp) || 0
    const fp = Number(r.fp) || 0
    const p = tp + fp > 0 ? tp / (tp + fp) * 100 : 0
    tagPrecs.push(p)
    if (p <= 0.01) zeroPrec++
    if (p >= 99.99) fullPrec++
    if (fp <= 0) zeroFp++
    const bi = BANDS.findIndex(([lo, hi]) => p >= lo && p < hi)
    if (bi >= 0) bandCount[bi]++
  }

  console.log('\n==> 标签维度校验')
  console.log('    精度档分布:')
  BANDS.forEach(([lo, hi, name], i) => {
    const bar = '█'.repeat(bandCount[i])
    console.log(`      ${name.padEnd(10)} ${String(bandCount[i]).padStart(2)} 个 ${bar}`)
  })
  console.log(`    精度为 0%  的标签: ${zeroPrec} 个 ${zeroPrec === 0 ? '✅' : '❌'}`)
  console.log(`    精度为100% 的标签: ${fullPrec} 个 ${fullPrec === 0 ? '✅' : '❌'}`)
  console.log(`    误杀量(FP)为 0 的标签: ${zeroFp} 个 ${zeroFp === 0 ? '✅' : '❌'}`)
  const spreadOk = bandCount.filter(c => c > 0).length >= 3
  console.log(`    覆盖精度档数: ${bandCount.filter(c => c > 0).length} / ${BANDS.length} ${spreadOk ? '✅' : '⚠️ 分布偏集中'}`)
  if (tagPrecs.length) {
    console.log(`    标签精度区间: [${Math.min(...tagPrecs).toFixed(1)}%, ${Math.max(...tagPrecs).toFixed(1)}%]`)
  }
}

run()
