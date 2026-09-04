import mysql from 'mysql2/promise'
const DB = { host: process.env.DB_HOST, port: 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5, dateStrings: true })
const [tags] = await pool.query('SELECT tag_id, tag_name, total, fp, precision_val FROM real_data_tags ORDER BY tag_id')
console.log('real_data_tags 标签数:', tags.length)
tags.forEach(t => console.log(`${t.tag_id} | ${t.tag_name} | total=${t.total} fp=${t.fp} prec=${t.precision_val}`))
const [miss] = await pool.query(`SELECT t.tag_id FROM real_data_tags t LEFT JOIN real_data_samples s ON t.tag_id=s.tag_id GROUP BY t.tag_id HAVING COUNT(s.id)=0`)
console.log('\n样本表缺失的标签:', miss.map(m => m.tag_id).join(','))
await pool.end()
