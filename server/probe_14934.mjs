import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: 3306,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 2,
})

async function main() {
  const q = async (sql, p = []) => (await pool.query(sql, p))[0]
  const TID = '14934'

  console.log('=== 1) real_data_tag_precision: tag_id=14934 ===')
  const prec = await q(`SELECT tag_id, tag_name, arrive_time, ds, total, tp, fp, precision_val, sample_count FROM real_data_tag_precision WHERE tag_id=?`, [TID])
  console.log('rows:', prec.length)
  prec.slice(0, 30).forEach(r => console.log(`  at=${r.arrive_time} ds=${r.ds} total=${r.total} tp=${r.tp} fp=${r.fp} p=${r.precision_val} sc=${r.sample_count} name=${r.tag_name}`))

  console.log('\n=== 2) real_data_samples: tag_id=14934 总体 ===')
  const sTotal = await q(`SELECT COUNT(*) c, SUM(is_fp) fp, SUM(1-is_fp) tp, COUNT(arrive_time) withAt, SUM(CASE WHEN arrive_time IS NULL OR arrive_time='' THEN 1 ELSE 0 END) emptyAt FROM real_data_samples WHERE tag_id=?`, [TID])
  console.log(sTotal[0])

  console.log('\n=== 2b) real_data_samples: tag_id=14934 arrive_time 分布 ===')
  const sAt = await q(`SELECT DATE(arrive_time) d, COUNT(*) c, SUM(is_fp) fp FROM real_data_samples WHERE tag_id=? AND arrive_time IS NOT NULL AND arrive_time!='' GROUP BY d ORDER BY d`, [TID])
  sAt.slice(0, 40).forEach(r => console.log(`  ${r.d} total=${r.c} fp=${r.fp}`))
  console.log('  distinct days:', sAt.length)

  console.log('\n=== 3) real_data_tag_precision_samples: tag_id=14934 ===')
  const ps = await q(`SELECT COUNT(*) c, SUM(is_fp) fp, SUM(1-is_fp) tp FROM real_data_tag_precision_samples WHERE tag_id=?`, [TID])
  console.log('rows:', ps[0])
  const psAt = await q(`SELECT DATE(arrive_time) d, COUNT(*) c, SUM(is_fp) fp FROM real_data_tag_precision_samples WHERE tag_id=? AND arrive_time IS NOT NULL AND arrive_time!='' GROUP BY d ORDER BY d`, [TID])
  psAt.slice(0, 40).forEach(r => console.log(`  ${r.d} total=${r.c} fp=${r.fp}`))
  console.log('  distinct days:', psAt.length)

  console.log('\n=== 4) ai_evaluate_detail: 14934 相关（policy_ids / ai_evaluate_policy_ids 包含 14934） ===')
  const ae = await q(`SELECT COUNT(*) c FROM ai_evaluate_detail WHERE policy_ids LIKE '%14934%' OR ai_evaluate_policy_ids LIKE '%14934%'`)
  console.log('rows:', ae[0].c)

  console.log('\n=== 5) ai_evaluate_detail: 14934 的 arrive_time/ds 分布 ===')
  const aeAt = await q(`SELECT DATE(arrive_time) d, ds, COUNT(*) c FROM ai_evaluate_detail WHERE policy_ids LIKE '%14934%' OR ai_evaluate_policy_ids LIKE '%14934%' GROUP BY d, ds ORDER BY d LIMIT 30`)
  aeAt.forEach(r => console.log(`  ${r.d} ds=${r.ds} cnt=${r.c}`))

  console.log('\n=== 6) real_data_samples: 14934 标签名在 real_data_tags 中 ===')
  const tags = await q(`SELECT * FROM real_data_tags WHERE tag_id=?`, [TID])
  console.log('real_data_tags:', tags.length ? tags[0] : 'NOT FOUND')

  console.log('\n=== 7) 对比：其他标签在 real_data_samples 的 arrive_time 覆盖情况（前10） ===')
  const others = await q(`SELECT tag_id, COUNT(*) c, SUM(CASE WHEN arrive_time IS NULL OR arrive_time='' THEN 1 ELSE 0 END) emptyAt, COUNT(DISTINCT DATE(arrive_time)) days FROM real_data_samples GROUP BY tag_id ORDER BY c DESC LIMIT 10`)
  others.forEach(r => console.log(`  tag=${r.tag_id} total=${r.c} emptyAt=${r.emptyAt} days=${r.days}`))

  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
