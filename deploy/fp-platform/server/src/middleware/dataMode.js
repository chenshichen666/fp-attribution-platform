/**
 * 数据模式中间件：统一使用正式表，不再区分草稿/正式
 * 线上与 With 平台数据保持一致
 */
export function dataMode(req, res, next) {
  req.dataMode = 'prod'
  next()
}

/**
 * 根据当前请求的数据模式返回对应表名
 * @param {Object} req - Express 请求对象
 * @param {string} prodTable - 正式表名
 * @returns {string} 实际应查询的表名
 */
export function getDataTable(req, prodTable) {
  return prodTable
}

/**
 * 将 SQL 字符串中的正式表名替换为当前模式对应的表名
 * 用于包含 JOIN / 子查询等复杂 SQL
 * @param {Object} req - Express 请求对象
 * @param {string} sql - 原始 SQL
 * @returns {string} 替换后的 SQL
 */
export function rewriteDataTables(req, sql) {
  return sql
}
