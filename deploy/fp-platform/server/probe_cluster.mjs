import mysql from 'mysql2/promise'
const DB = { host: process.env.DB_HOST, port: 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5, dateStrings: true })
async function show(t, sql) {
  try {
    const [rows] = await pool.query(sql)
    console.log('\n=== ' + t + ' ===')
    if (!rows || !rows.length) { console.log('(空)'); return }
    const cols = Object.keys(rows[0])
    console.log(cols.join(' | '))
    rows.slice(0, 25).forEach(r => console.log(cols.map(c => String(r[c] ?? 'NULL')).slice(0, 12).join(' | ')))
    console.log('行数:', rows.length)
  } catch (e) { console.log('\n=== ' + t + ' === 错误: ' + e.message) }
}

await show('sample_library_fine_label 结构', 'DESCRIBE sample_library_fine_label')
await show('sample_library_fine_label 样例', 'SELECT * FROM sample_library_fine_label LIMIT 2')
await show('sample_library_fine_label 按cluster_id', 'SELECT cluster_id, COUNT(*) c FROM sample_library_fine_label GROUP BY cluster_id ORDER BY c DESC LIMIT 15')
await show('sample_library_fine_label 按fine_labels', 'SELECT fine_labels, COUNT(*) c FROM sample_library_fine_label GROUP BY fine_labels ORDER BY c DESC LIMIT 15')

// 标签 15027 在样本表是否有数据
await show('标签15027样本', "SELECT COUNT(*) c, MIN(arrive_time) mn, MAX(arrive_time) mx FROM real_data_samples WHERE tag_id=15027")
await show('标签15027精度表', "SELECT COUNT(*) c FROM real_data_tag_precision WHERE tag_id=15027")
await show('样本表tag分布', "SELECT COUNT(DISTINCT tag_id) c FROM real_data_samples")
await show('样本表FP分布', "SELECT is_fp, COUNT(*) c FROM real_data_samples GROUP BY is_fp")

await pool.end()
