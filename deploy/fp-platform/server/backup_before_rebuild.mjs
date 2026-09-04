// 备份核心表到 *_bk_20260902
import mysql from 'mysql2/promise'

const DB = {
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
}
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5, dateStrings: true })

const tables = [
  'real_data_tag_precision', 'real_data_samples', 'real_data_tags',
  'sediments', 'cluster_features', 'cluster_data', 'material_category',
]

for (const t of tables) {
  const bk = `${t}_bk_20260902`
  try {
    await pool.query(`DROP TABLE IF EXISTS ${bk}`)
    await pool.query(`CREATE TABLE ${bk} AS SELECT * FROM ${t}`)
    const [[r]] = await pool.query(`SELECT COUNT(*) c FROM ${bk}`)
    console.log(`备份 ${t} -> ${bk}: ${r.c} 行`)
  } catch (e) {
    console.log(`备份 ${t} 失败: ${e.message}`)
  }
}
console.log('备份完成')
await pool.end()
