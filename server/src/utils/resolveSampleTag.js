import { query } from '../db/pool.js'

// ===== 标签 ID 解析：把「任意来源的标签 id」统一解析为 real_data_samples.tag_id =====
//
// 背景：平台存在两套标签 ID 体系：
//   - real_data_tags.id        （871+，标签字典主键，标签跟踪/素材分类入口用的就是它）
//   - real_data_samples.tag_id （1001+，样本表/精度聚合表外键）
// 两者的映射关系存在 real_data_tags.tag_id 列里。
// 若拿 871+ 的 id 直查 real_data_samples / real_data_tag_precision，会因 ID 体系不一致查空，
// 导致「周精度趋势走 mock、行业置信下钻为空」等问题。
//
// 解析顺序（带 5 分钟进程内缓存）：
//   1) rawId 直接命中 real_data_samples.tag_id → 原样返回
//   2) real_data_tags.id = rawId → 返回其 tag_id（1001+）
//   3) real_data_tags.tag_name = rawId（前端传标签名时）→ 返回其 tag_id
//   4) 都失败 → 返回 null（调用方走兜底逻辑）
const _cache = new Map() // rawId -> { sampleTagId, tagName }
const CACHE_TTL = 5 * 60 * 1000

export async function resolveSampleTag(rawId) {
  const key = String(rawId ?? '').trim()
  if (!key) return null
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v

  let v = null
  try {
    // 1) 直接命中样本表
    const c1 = await query(`SELECT COUNT(*) AS c FROM real_data_samples WHERE tag_id = ?`, [key])
    if (Number(c1[0]?.c) > 0) {
      v = { sampleTagId: String(key), tagName: '' }
    } else {
      // 2) 标签字典主键 id → tag_id
      const rows = await query(
        `SELECT tag_id, tag_name FROM real_data_tags WHERE id = ? OR tag_name = ? LIMIT 1`,
        [Number(key) || key, key]
      )
      if (rows.length && rows[0].tag_id != null) {
        v = { sampleTagId: String(rows[0].tag_id), tagName: rows[0].tag_name || '' }
      }
    }
  } catch { v = null }

  _cache.set(key, { t: Date.now(), v })
  return v
}
