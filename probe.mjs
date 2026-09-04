import mysql from 'mysql2/promise'
const cfg = { host:process.env.DB_HOST, port:3306, user:process.env.DB_USER, password:process.env.DB_PASSWORD, database:process.env.DB_NAME }
const c = await mysql.createConnection(cfg)
const q = async (s) => { const [r] = await c.query(s); return r }
console.log('== samples by first_level_industry_name ==')
console.table(await q("SELECT first_level_industry_name ind, COUNT(*) cnt, MIN(arrive_time) min_at, MAX(arrive_time) max_at FROM real_data_samples GROUP BY first_level_industry_name ORDER BY cnt DESC"))
console.log('== samples 近7天窗口各行业误杀 ==')
console.table(await q("SELECT first_level_industry_name ind, COUNT(*) cnt, SUM(is_fp) fp FROM real_data_samples WHERE DATE(arrive_time) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY first_level_industry_name ORDER BY cnt DESC"))
console.log('== ai_evaluate_detail distinct first_level_industry_name ==')
console.table(await q("SELECT DISTINCT first_level_industry_name ind FROM ai_evaluate_detail ORDER BY ind"))
await c.end()
