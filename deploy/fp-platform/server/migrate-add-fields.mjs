// 一次性迁移：给 real_data_samples / draft_real_data_samples / publish_backup_real_data_samples 加3个字段
// dc_id, ops_advertiser_name, ai_evaluate_reviewer_name
import mysql from 'mysql2/promise'

const POOL = mysql.createPool({
  host: process.env.DB_HOST,
  port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 5,
})

const TABLES = [
  'real_data_samples',
  'draft_real_data_samples',
  'publish_backup_real_data_samples',
]

const STMT = (t) => `ALTER TABLE \`${t}\`
  ADD COLUMN dc_id VARCHAR(64) NOT NULL DEFAULT '' AFTER element_fingerprint,
  ADD COLUMN ops_advertiser_name VARCHAR(255) NOT NULL DEFAULT '' AFTER uid,
  ADD COLUMN ai_evaluate_reviewer_name VARCHAR(512) NOT NULL DEFAULT '' AFTER ops_advertiser_name`

// 先查字段是否已存在，避免重复 ALTER 报错
async function hasCol(conn, table, col) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, col]
  )
  return rows.length > 0
}

const conn = await POOL.getConnection()
try {
  for (const t of TABLES) {
    const need = []
    for (const c of ['dc_id', 'ops_advertiser_name', 'ai_evaluate_reviewer_name']) {
      const exists = await hasCol(conn, t, c)
      if (!exists) need.push(c)
    }
    if (!need.length) {
      console.log(`[${t}] 3个字段已全部存在，跳过`)
      continue
    }
    // 只加缺失的字段
    const cols = []
    if (need.includes('dc_id')) cols.push(`ADD COLUMN dc_id VARCHAR(64) NOT NULL DEFAULT '' AFTER element_fingerprint`)
    if (need.includes('ops_advertiser_name')) cols.push(`ADD COLUMN ops_advertiser_name VARCHAR(255) NOT NULL DEFAULT '' AFTER uid`)
    if (need.includes('ai_evaluate_reviewer_name')) cols.push(`ADD COLUMN ai_evaluate_reviewer_name VARCHAR(512) NOT NULL DEFAULT '' AFTER ops_advertiser_name`)
    const sql = `ALTER TABLE \`${t}\` ${cols.join(', ')}`
    console.log(`[${t}] 执行: ${sql}`)
    await conn.query(sql)
    console.log(`[${t}] 完成`)
  }
  // 验证
  for (const t of TABLES) {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME IN ('dc_id','ops_advertiser_name','ai_evaluate_reviewer_name')`,
      [process.env.DB_NAME, t]
    )
    console.log(`\n[${t}] 验证字段:`)
    for (const r of rows) console.log(`  ${r.COLUMN_NAME} ${r.COLUMN_TYPE} default=${r.COLUMN_DEFAULT}`)
  }
  console.log('\n✅ 迁移全部完成')
} catch (e) {
  console.error('❌ 迁移失败:', e.message)
  process.exitCode = 1
} finally {
  conn.release()
  await POOL.end()
}
