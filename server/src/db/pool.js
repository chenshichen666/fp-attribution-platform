import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 先加载 server/.env，若不存在则回退到工作目录 .env
dotenv.config({ path: path.resolve(__dirname, '../../.env') })
dotenv.config() // 工作目录兜底

import Database from 'better-sqlite3'

export const config = {
  port: Number(process.env.PORT || 8787),
  superAdmin: (process.env.SUPER_ADMIN || 'admin').toLowerCase(),
  knotApiUrl: process.env.KNOT_API_URL || '',
}

// SQLite 数据库文件路径（默认在 server/data/fp_attribution.db）
const DB_PATH = process.env.SQLITE_PATH || path.resolve(__dirname, '../../data/fp_attribution.db')

// 确保 data 目录存在
import fs from 'node:fs'
const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// 创建 SQLite 数据库实例
const db = Database(DB_PATH)

// 启用 WAL 模式（更好的读写并发性能）
db.pragma('journal_mode = WAL')
// 启用外键约束
db.pragma('foreign_keys = ON')

// 导出原始 db 实例（供 init.js 等直接使用）
export { db }

// 标记数据库就绪（SQLite 始终可用）
let _dbReady = true
export function isDbReady() { return _dbReady }

/**
 * 兼容 mysql2 的 query 接口（参数化查询）
 * mysql2 使用 ? 占位符，SQLite 也支持 ? 占位符，无需转换
 * 返回值：
 *   SELECT → 行数组
 *   INSERT → [{ insertId, changes }]（模拟 mysql2 行为：返回包含 insertId 的对象）
 *   UPDATE/DELETE → [{ affectedRows, changes }]
 */
export async function query(sql, params = []) {
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH')) {
    const stmt = db.prepare(sql)
    return stmt.all(...params)
  } else {
    const stmt = db.prepare(sql)
    const result = stmt.run(...params)
    // 模拟 mysql2 返回格式
    return [{ insertId: result.lastInsertRowid, affectedRows: result.changes, changes: result.changes }]
  }
}

/**
 * rawQuery：与 query 相同（mysql2 中 rawQuery 使用 pool.query 而非 pool.execute）
 * 在 SQLite 中没有区别
 */
export async function rawQuery(sql, params = []) {
  return query(sql, params)
}

/**
 * ping：验证数据库可用性（SQLite 始终可用，直接返回）
 */
export async function ping() {
  db.prepare('SELECT 1').get()
}

/**
 * getPoolStatus：返回数据库状态信息
 */
export function getPoolStatus() {
  return {
    type: 'sqlite',
    path: DB_PATH,
    open: db.open,
    memory: db.memory,
  }
}

/**
 * 辅助：执行多条语句（用于建表等批量 DDL）
 */
export function execSQL(sql) {
  db.exec(sql)
}

/**
 * 兼容 mysql2 连接池接口：dataMeta.js / classifyUpload.js 等文件
 * 使用 pool.getConnection() → conn.execute() → conn.commit() 模式。
 * SQLite 是进程内同步数据库，无需真正的连接池；
 * 此 shim 将 conn.execute / conn.query / conn.beginTransaction / conn.commit / conn.rollback
 * 映射为 SQLite 对应操作，使上层路由代码无需大规模重写。
 */
export const pool = {
  async getConnection() {
    return {
      async ping() { /* no-op for SQLite */ },
      async execute(sql, params = []) {
        const trimmed = sql.trim().toUpperCase()
        // 跳过 MySQL-specific SET SESSION 语句
        if (trimmed.startsWith('SET SESSION') || trimmed.startsWith('SET ')) return [[], []]
        // 跳过 TRUNCATE（SQLite 不支持，用 DELETE FROM 替代）
        if (trimmed.startsWith('TRUNCATE')) {
          const tableName = sql.replace(/^TRUNCATE\s+TABLE\s+/i, '').replace(/[`"]/g, '').trim()
          db.prepare(`DELETE FROM "${tableName}"`).run()
          return [{ insertId: 0, affectedRows: 0, changes: 0 }, []]
        }
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH')) {
          const rows = db.prepare(sql).all(...params)
          return [rows, []]
        } else {
          const result = db.prepare(sql).run(...params)
          return [{ insertId: result.lastInsertRowid, affectedRows: result.changes, changes: result.changes }, []]
        }
      },
      async query(sql, params = []) {
        // Same as execute for SQLite shim
        return this.execute(sql, params)
      },
      async beginTransaction() {
        db.prepare('BEGIN').run()
      },
      async commit() {
        db.prepare('COMMIT').run()
      },
      async rollback() {
        try { db.prepare('ROLLBACK').run() } catch { /* may not be in a transaction */ }
      },
      release() { /* no-op for SQLite */ },
    }
  },
}
