import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config({ path: './server/.env' })

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 2
})

async function main() {
  // 1. 确认 AI评测明细表的真实业务时间范围
  const [rsMax] = await pool.query(`SELECT MAX(arrive_time) AS mx FROM real_data_samples`)
  const businessDate = rsMax[0].mx
  console.log('AI评测明细表 real_data_samples MAX(arrive_time) =', businessDate)
  console.log('将作为策略标签表的 arrive_time 修正值')
  console.log()

  // 2. 查看策略标签表当前错误的 arrive_time
  const [before] = await pool.query(`SELECT DISTINCT arrive_time FROM real_data_tag_precision`)
  console.log('修复前 real_data_tag_precision 的 arrive_time 值:', before.map(r => String(r.arrive_time)))

  // 3. 修正策略标签正式表：arrive_time = 业务时间（7-18）
  const [upd1] = await pool.query(`UPDATE real_data_tag_precision SET arrive_time=? WHERE arrive_time IS NULL OR DATE(arrive_time) > ?`, [businessDate, businessDate])
  console.log(`已修正 real_data_tag_precision ${upd1.affectedRows} 行 → arrive_time = ${businessDate}`)

  // 4. 修正策略标签草稿表
  try {
    const [upd2] = await pool.query(`UPDATE draft_real_data_tag_precision SET arrive_time=? WHERE arrive_time IS NULL OR DATE(arrive_time) > ?`, [businessDate, businessDate])
    console.log(`已修正 draft_real_data_tag_precision ${upd2.affectedRows} 行 → arrive_time = ${businessDate}`)
  } catch(e) { console.log('草稿表跳过:', e.message) }

  // 5. 验证修复后
  const [after] = await pool.query(`SELECT DISTINCT arrive_time FROM real_data_tag_precision`)
  console.log('修复后 real_data_tag_precision 的 arrive_time 值:', after.map(r => String(r.arrive_time)))
  console.log()

  // 6. 修正 data_meta 中 data_updated_at_tag_precision 的 updated_at（这个语义是上传时间，保留7-20是对的，不改）
  console.log('注：data_meta.updated_at 语义为上传操作时间(7-20)，保留不变')
  console.log('注：buildProdMeta 会优先取 MAX(arrive_time)，现已修正为 7-18')

  await pool.end()
}
main().catch(e => { console.error(e); process.exit(1) })
