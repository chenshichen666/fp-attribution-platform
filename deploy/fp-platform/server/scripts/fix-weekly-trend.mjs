/**
 * 修复周维度精度趋势（仅调整 mock 样本数据，不改业务逻辑）
 *
 * 目标：
 * 1. 样本数据收敛为「恰好 15 周」（删除多余的前 4 周 2026-04-27~05-18）
 *    → 因为趋势图取 slice(-15)，19周会导致 W1 落在 05-25（78.9%），违反约束
 * 2. W1 精度 = 50%，W2/W3 ≤ 65%
 * 3. 整体趋势：治理后上升，中间有回落，符合常理
 * 4. 各标签（tag）在 15 周内均有数据，精度分级齐全
 */
import { rawQuery } from '../src/db/pool.js'

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260902)

// 15 周（周一）：2026-05-25 ~ 2026-08-31
const WEEKS = []
{
  let d = new Date('2026-08-31T00:00:00')
  for (let i = 0; i < 15; i++) { WEEKS.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 7 * 86400000) }
  WEEKS.reverse()
}

// 大盘目标精度曲线（15周）：W1=50，前三周<=65，之后上升有回落
const TARGET = [50.0, 55.0, 62.0, 67.0, 71.0, 68.5, 75.0, 79.0, 76.5, 82.0, 85.0, 83.0, 87.0, 85.5, 88.0]

async function main() {
  console.log('=== 修复周维度趋势：收敛为15周 + W1=50% + 前三周<=65% ===')

  // 1. 删除前 4 周（2026-04-27 ~ 2026-05-18）的多余样本，使总周数 = 15
  const delRes = await rawQuery(
    `DELETE FROM real_data_samples WHERE arrive_time < '2026-05-25'`
  )
  console.log(`已删除 2026-05-25 之前的样本（多余周），影响行数: ${delRes.affectedRows || delRes.length || 'ok'}`)

  // 2. 校验剩余周数
  const wrows = await rawQuery(
    `SELECT DATE_FORMAT(DATE_SUB(DATE(arrive_time), INTERVAL WEEKDAY(DATE(arrive_time)) DAY),'%Y-%m-%d') wk,
      COUNT(*) n, SUM(is_fp) fp
     FROM real_data_samples WHERE arrive_time IS NOT NULL AND arrive_time!=''
     GROUP BY wk ORDER BY wk`
  )
  console.log(`剩余周数 = ${wrows.length}`)
  wrows.forEach((r, i) => {
    const prec = ((r.n - r.fp) / r.n * 100).toFixed(1)
    console.log(`  W${i + 1} ${r.wk} n=${r.n} fp=${r.fp} prec=${prec}%`)
  })

  // 3. 按周重设 is_fp，使每周精度命中目标曲线
  //    方法：每周需要 fp = n * (1 - target/100)，按当前 fp 差值随机翻转样本
  for (let i = 0; i < wrows.length; i++) {
    const wk = wrows[i].wk
    const n = Number(wrows[i].n)
    const targetPrec = TARGET[i] ?? TARGET[TARGET.length - 1]
    const wantFp = Math.round(n * (1 - targetPrec / 100))
    const curFp = Number(wrows[i].fp) || 0
    let diff = wantFp - curFp

    if (diff === 0) continue

    if (diff > 0) {
      // 需要更多 FP：把 TP(is_fp=0) 翻转为 FP(is_fp=1)
      const cands = await rawQuery(
        `SELECT id FROM real_data_samples
          WHERE DATE_FORMAT(DATE_SUB(DATE(arrive_time), INTERVAL WEEKDAY(DATE(arrive_time)) DAY),'%Y-%m-%d') = ?
            AND is_fp = 0 LIMIT ?`,
        [wk, diff]
      )
      for (const c of cands) {
        await rawQuery(`UPDATE real_data_samples SET is_fp = 1 WHERE id = ?`, [c.id])
      }
    } else {
      // 需要减少 FP：把 FP(is_fp=1) 翻转为 TP(is_fp=0)
      const cands = await rawQuery(
        `SELECT id FROM real_data_samples
          WHERE DATE_FORMAT(DATE_SUB(DATE(arrive_time), INTERVAL WEEKDAY(DATE(arrive_time)) DAY),'%Y-%m-%d') = ?
            AND is_fp = 1 LIMIT ?`,
        [wk, -diff]
      )
      for (const c of cands) {
        await rawQuery(`UPDATE real_data_samples SET is_fp = 0 WHERE id = ?`, [c.id])
      }
    }
    const chk = await rawQuery(
      `SELECT COUNT(*) n, SUM(is_fp) fp FROM real_data_samples
        WHERE DATE_FORMAT(DATE_SUB(DATE(arrive_time), INTERVAL WEEKDAY(DATE(arrive_time)) DAY),'%Y-%m-%d') = ?`,
      [wk]
    )
    const p = chk[0].n > 0 ? ((chk[0].n - chk[0].fp) / chk[0].n * 100).toFixed(1) : 0
    console.log(`  → W${i + 1} ${wk} 重设后 n=${chk[0].n} fp=${chk[0].fp} prec=${p}% (目标 ${targetPrec}%)`)
  }

  console.log('=== 完成 ===')
  process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
