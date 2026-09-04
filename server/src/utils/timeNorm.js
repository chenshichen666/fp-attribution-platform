// 统一时间解析工具：根治「更新时间算错」
// 背景：arrive_time 是 varchar(32)，历史数据混入多种格式（2026-08-31 / 2026/8/3 /
// 2026-08-31 12:00 / 2026-08-31T12:00:00Z / Excel 序列号 / 2026年8月3日），
// 直接 MAX() 按字典序比较会得出错误结果；DATETIME 的 ISO 字符串又是 UTC，
// 与北京时间差 8 小时，跨零点会整整差一天。
// 本模块提供：归一化为 YYYY-MM-DD 的纯业务日期，以及安全的「最大日期」计算。

import { rawQuery } from '../db/pool.js'

// 北京时间偏移（毫秒）：服务端按 Asia/Shanghai 口径展示，避免 UTC 跨零点差一天
const CST_OFFSET_MS = 8 * 60 * 60 * 1000

// 将任意格式的时间值归一化为 'YYYY-MM-DD'（业务日期，北京时间口径）
// 无法解析时返回 ''
export function normDate(v) {
  if (v == null) return ''
  // 已是 Date 对象（mysql2 对 DATETIME 列的默认返回）
  if (v instanceof Date) return dateToCST(v)
  const s = String(v).trim()
  if (!s) return ''

  // 1) Excel 序列号（纯数字，如 45870 或 45870.5）：Excel 日期系统起点 1899-12-30
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    // 合理区间：1990-01-01 ~ 2100-12-31 对应的序列号
    if (n >= 32874 && n <= 88070) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000)
      return dateToCST(d)
    }
    // 形如 20260831 的紧凑数字日期
    const m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    return ''
  }

  // 2) ISO 字符串（含 T / Z / 时区偏移）：按 UTC 真实时刻折算到北京时间
  if (/\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return dateToCST(d)
  }

  // 3) 中文日期：2026年8月3日
  const cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (cn) return pad(cn[1], cn[2], cn[3])

  // 4) 常规分隔符日期：2026-08-31 / 2026/8/3 / 2026.8.3，可带时间部分
  const std = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (std) return pad(std[1], std[2], std[3])

  // 5) 兜底：交给 Date 解析（能救回部分非标准写法），失败则返回空
  const d2 = new Date(s)
  if (!isNaN(d2.getTime())) return dateToCST(d2)
  return ''
}

// 按北京时间口径输出 YYYY-MM-DD
function dateToCST(d) {
  return fmt(new Date(d.getTime() + CST_OFFSET_MS))
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function pad(y, m, d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}`
}

// 从一批原始时间值中求「最大业务日期」
// 逐值归一化后按字符串比较（YYYY-MM-DD 字典序 == 时间序），彻底规避 MySQL 字典序陷阱
// 全部无法解析时返回 '' —— 调用方据此回退，而不是拿当天日期冒充业务时间
export function maxDate(values) {
  let best = ''
  for (const v of values) {
    const d = normDate(v)
    if (d && d > best) best = d
  }
  return best
}

// 判断某表「是否有可用业务时间」的安全查询：取样本后在 JS 侧求最大值
// 说明：表可能很大，不 SELECT MAX()（varchar 字典序不可靠），改为取最近一批行在 JS 侧算
export async function safeMaxDateGlobal(tableName, sampleSize = 2000) {
  try {
    const rows = await rawQuery(
      `SELECT arrive_time FROM \`${tableName}\` WHERE arrive_time IS NOT NULL LIMIT ${Number(sampleSize)}`
    )
    if (!rows || !rows.length) {
      // 表里可能根本没有 arrive_time 列或全为空：退回「取一行看有没有数据」
      const any = await rawQuery(`SELECT 1 FROM \`${tableName}\` LIMIT 1`)
      if (!any || !any.length) return { date: '', count: 0 }
      return { date: '', count: -1 }
    }
    return { date: maxDate(rows.map((r) => r.arrive_time)), count: rows.length }
  } catch (e) {
    console.error('[safeMaxDateGlobal] ERROR:', e?.message || e)
    return { date: '', count: 0 }
  }
}
