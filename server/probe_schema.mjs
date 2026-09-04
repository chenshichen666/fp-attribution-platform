import mysql from 'mysql2/promise'
const DB = { host: process.env.DB_HOST, port: 3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME }
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5, dateStrings: true })
const [rows] = await pool.query('DESCRIBE real_data_tag_precision_samples')
console.log('=== real_data_tag_precision_samples 结构 ===')
rows.forEach(r => console.log(`${r.Field} | ${r.Type} | null=${r.Null} | key=${r.Key} | def=${r.Default ?? 'NULL'}`))
await pool.end()
