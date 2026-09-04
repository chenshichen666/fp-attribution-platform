import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 2,
})

async function main() {
  const conn = await pool.getConnection()
  try {
    const tables = [
      'draft_real_data_tags',
      'draft_real_data_samples',
      'draft_real_data_tag_precision',
      'draft_real_data_tag_precision_samples',
      'draft_data_meta',
      'draft_cluster_data',
    ]
    for (const tbl of tables) {
      try {
        await conn.execute(`DROP TABLE IF EXISTS \`${tbl}\``)
        console.log(`DROPPED: ${tbl}`)
      } catch (e) {
        console.log(`SKIP ${tbl}: ${e.message}`)
      }
    }
    console.log('Done.')
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch(console.error)
