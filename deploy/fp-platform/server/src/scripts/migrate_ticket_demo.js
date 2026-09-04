// 一次性迁移：为 tickets 增加 is_demo 列，并把现有（演示种子）工单标记为演示数据。
// 正式账号列表查询会排除 is_demo=1，从而不再看到任何预置内容。
import { pool, query } from '../db/pool.js'

async function columnExists(table, column) {
  const rows = await query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  )
  return Number(rows[0].c) > 0
}

async function run() {
  if (!(await columnExists('tickets', 'is_demo'))) {
    console.log('==> 添加 tickets.is_demo 列...')
    await pool.query('ALTER TABLE tickets ADD COLUMN is_demo TINYINT(1) NOT NULL DEFAULT 0')
  } else {
    console.log('==> tickets.is_demo 已存在，跳过建列')
  }

  // 现有库中工单均来自演示种子，统一标记为演示数据（正式账号不可见）
  const r = await query('UPDATE tickets SET is_demo=1')
  console.log(`==> 已将现有工单标记为演示数据，受影响行数=${r.affectedRows}`)

  const left = await query('SELECT COUNT(*) AS c FROM tickets WHERE is_demo=0')
  console.log(`==> 当前正式（非演示）工单数=${left[0].c}`)

  console.log('==> 迁移完成 ✅')
  process.exit(0)
}

run().catch((e) => { console.error('迁移失败:', e); process.exit(1) })
