import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  waitForConnections: true, connectionLimit: 2,
})

async function main() {
  const q = async (sql, p = []) => (await pool.query(sql, p))[0]

  console.log('=== real_data_tag_precision_samples ===')
  const cnt1 = await q(`SELECT COUNT(*) c FROM real_data_tag_precision_samples`)
  console.log('rows =', cnt1[0].c)
  if (cnt1[0].c > 0) {
    const d = await q(`SELECT arrive_time, is_fp, COUNT(*) c FROM real_data_tag_precision_samples GROUP BY arrive_time, is_fp ORDER BY arrive_time DESC LIMIT 30`)
    console.log(d.map(r => `at=${r.arrive_time} is_fp=${r.is_fp} c=${r.c}`).join('\n'))
  }

  console.log('\n=== real_data_samples (业务明细) ===')
  const cnt2 = await q(`SELECT COUNT(*) c FROM real_data_samples`)
  console.log('rows =', cnt2[0].c)
  if (cnt2[0].c > 0) {
    const d = await q(`SELECT arrive_time, is_fp, COUNT(*) c FROM real_data_samples GROUP BY arrive_time, is_fp ORDER BY arrive_time DESC LIMIT 30`)
    console.log(d.map(r => `at=${r.arrive_time} is_fp=${r.is_fp} c=${r.c}`).join('\n'))
  }

  console.log('\n=== real_data_tag_precision_samples: 同 tag 多 arrive_time 是否存在 ===')
  const multi = await q(`SELECT tag_id, COUNT(DISTINCT arrive_time) d FROM real_data_tag_precision_samples GROUP BY tag_id HAVING d > 1 ORDER BY d DESC LIMIT 10`)
  console.log(multi.map(r => `tag=${r.tag_id} distinctArrive=${r.d}`).join('\n') || '(无)')

  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
