import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  waitForConnections: true, connectionLimit: 2,
})

async function main() {
  const q = async (sql, p = []) => (await pool.query(sql, p))[0]

  // 1. 精度表整体聚合（当前 AnalysisView KPI 来源）
  const pa = await q(`SELECT SUM(total) s_total, SUM(fp) s_fp, SUM(tp) s_tp, COUNT(*) n FROM real_data_tag_precision`)
  console.log('=== 精度表 real_data_tag_precision 整体聚合 ===')
  console.log(`tags=${pa[0].n} sumTotal=${pa[0].s_total} sumFp=${pa[0].s_fp} sumTp=${pa[0].s_tp}`)
  console.log(`=精度 ${pa[0].s_tp && pa[0].s_total ? (pa[0].s_tp/pa[0].s_total*100).toFixed(1) : 'NA'}%  FP率 ${(pa[0].s_fp/pa[0].s_total*100).toFixed(1)}%`)

  // 2. 样本表明细量 + tag 覆盖
  const sa = await q(`SELECT COUNT(*) c, COUNT(DISTINCT tag_id) d FROM real_data_samples`)
  console.log('\n=== real_data_samples ===')
  console.log(`rows=${sa[0].c} distinctTags=${sa[0].d}`)

  // 3. tag 重叠
  const ov = await q(`
    SELECT
      (SELECT COUNT(*) FROM (SELECT DISTINCT tag_id FROM real_data_tag_precision) a) AS pTags,
      (SELECT COUNT(*) FROM (SELECT DISTINCT tag_id FROM real_data_samples) b) AS sTags,
      (SELECT COUNT(*) FROM (SELECT DISTINCT tag_id FROM real_data_tag_precision) a
         WHERE a.tag_id IN (SELECT DISTINCT tag_id FROM real_data_samples)) AS overlap
  `)
  console.log('\n=== tag 覆盖重叠 ===')
  console.log(ov[0])

  // 4. 样本表在截图窗口 2026-07-28..2026-08-01 的聚合
  const w = await q(`SELECT COUNT(*) total, SUM(is_fp) fp, SUM(CASE WHEN is_fp=0 THEN 1 ELSE 0 END) tp
                    FROM real_data_samples WHERE DATE(arrive_time) BETWEEN '2026-07-28' AND '2026-08-01'`)
  console.log('\n=== 样本表 窗口 07-28..08-01 ===')
  console.log(`total=${w[0].total} fp=${w[0].fp} tp=${w[0].tp} 精度=${(w[0].tp/w[0].total*100).toFixed(1)}%`)

  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
