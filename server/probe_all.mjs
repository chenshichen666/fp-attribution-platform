import mysql from 'mysql2/promise'

const DB = {
  host: process.env.DB_HOST,
  port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
}
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5, dateStrings: true })

async function show(title, sql) {
  try {
    const [rows] = await pool.query(sql)
    console.log('\n=== ' + title + ' ===')
    if (!Array.isArray(rows) || rows.length === 0) { console.log('(空)'); return rows }
    const cols = Object.keys(rows[0])
    console.log(cols.join(' | '))
    for (const r of rows.slice(0, 60)) console.log(cols.map(c => String(r[c] ?? 'NULL')).join(' | '))
    console.log('行数: ' + rows.length)
    return rows
  } catch (e) {
    console.log('\n=== ' + title + ' === 错误: ' + e.message)
    return null
  }
}

// 精度表周维度（趋势图默认数据源）
await show('精度表周聚合', `SELECT ds, SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fp_conf, SUM(total) total,
  ROUND(SUM(tp)/(SUM(tp)+SUM(fp))*100,2) prec, ROUND(SUM(tp)/(SUM(tp)+SUM(fp_conf))*100,2) abs_prec
  FROM real_data_tag_precision WHERE ds != '' GROUP BY ds ORDER BY ds`)

// 精度表每个标签覆盖周数
await show('精度表标签覆盖周数分布', `SELECT cover_weeks, COUNT(*) AS tag_cnt FROM (
  SELECT tag_id, COUNT(DISTINCT ds) AS cover_weeks FROM real_data_tag_precision WHERE ds != '' GROUP BY tag_id
) t GROUP BY cover_weeks ORDER BY cover_weeks`)

await show('覆盖周数<15的标签', `SELECT tag_id, MAX(tag_name) nm, COUNT(DISTINCT ds) c, MIN(ds) mn, MAX(ds) mx
  FROM real_data_tag_precision WHERE ds != '' GROUP BY tag_id HAVING c < 15 ORDER BY c LIMIT 40`)

// 沉淀库
await show('sediments 状态分布', `SELECT result_type, COUNT(*) c FROM sediments GROUP BY result_type`)
await show('sediments 行业分布', `SELECT industry_l1, COUNT(*) c FROM sediments GROUP BY industry_l1 ORDER BY c DESC LIMIT 20`)
await show('sediments 样例', `SELECT id,title,type,category,result_type,tag_id,tag_name,industry_l1,samples,is_demo FROM sediments LIMIT 8`)

// 聚类簇特征
await show('cluster_features 覆盖', `SELECT tag_id, COUNT(*) c FROM cluster_features GROUP BY tag_id ORDER BY c DESC LIMIT 20`)
await show('cluster_data 样例', `SELECT * FROM cluster_data LIMIT 3`)

// 标签下钻数据源
await show('real_data_tags 样例', `SELECT * FROM real_data_tags LIMIT 5`)
await show('tags 表样例', `SELECT * FROM tags LIMIT 5`)

// 数据更新时间口径
await show('各表最大业务日期', `SELECT 'samples' t, MAX(DATE(arrive_time)) d FROM real_data_samples
UNION ALL SELECT 'precision', MAX(ds) FROM real_data_tag_precision
UNION ALL SELECT 'ai_eval', MAX(DATE(arrive_time)) FROM ai_evaluate_detail`)

await show('ai_evaluate_detail 周分布', `SELECT YEARWEEK(arrive_time,1) wk, MIN(DATE(arrive_time)) ws, COUNT(*) c FROM ai_evaluate_detail GROUP BY wk ORDER BY wk`)

await pool.end()
