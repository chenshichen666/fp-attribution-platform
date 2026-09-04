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

  console.log('=== real_data_tag_precision: arrive_time / ds 分布 ===')
  const dist = await q(`SELECT arrive_time, ds, COUNT(*) AS cnt FROM real_data_tag_precision GROUP BY arrive_time, ds ORDER BY arrive_time DESC, ds DESC`)
  console.log(dist.map(r => `arrive_time=${r.arrive_time} ds=${r.ds} cnt=${r.cnt}`).join('\n'))

  console.log('\n=== 不同 arrive_time 下的 tag_id / precision 是否不同（抽样前若干 tag） ===')
  const tags = await q(`SELECT DISTINCT tag_id FROM real_data_tag_precision ORDER BY tag_id LIMIT 8`)
  for (const { tag_id } of tags) {
    const rows = await q(`SELECT arrive_time, ds, total, tp, fp, precision FROM real_data_tag_precision WHERE tag_id=? ORDER BY arrive_time DESC`, [tag_id])
    console.log(`tag_id=${tag_id}:`, rows.map(r => `(at=${r.arrive_time} ds=${r.ds} p=${r.precision} tp=${r.tp} fp=${r.fp})`).join(' '))
  }

  console.log('\n=== 同一 ds 内多行占比（是否按日聚合） ===')
  const multiRows = await q(`SELECT ds, COUNT(*) AS rowCnt, COUNT(DISTINCT tag_id) AS tagCnt FROM real_data_tag_precision GROUP BY ds ORDER BY ds DESC`)
  console.log(multiRows.map(r => `ds=${r.ds} rows=${r.rowCnt} distinctTags=${r.tagCnt}`).join('\n'))

  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
