import { rawQuery } from './server/src/db/pool.js'
async function main() {
  // 模拟前端带 tagId 参数调 cluster-elements
  const classId = 'c1'
  const tagId = '14926'
  const page = 1, pageSize = 50
  const offset = (page - 1) * pageSize
  
  const conditions = ['class_id = ?']
  const params = [classId]
  conditions.push('(policy_ids LIKE ? OR ai_evaluate_policy_ids LIKE ?)')
  params.push(`%${tagId}%`, `%${tagId}%`)
  
  const whereClause = 'WHERE ' + conditions.join(' AND ')
  
  console.log('params before count:', JSON.stringify(params))
  console.log('count SQL:', `SELECT COUNT(*) AS c FROM ai_evaluate_detail ${whereClause}`)
  
  try {
    const countRows = await rawQuery(`SELECT COUNT(*) AS c FROM ai_evaluate_detail ${whereClause}`, params)
    console.log('count OK:', countRows[0].c)
  } catch(e) {
    console.log('count ERROR:', e.message)
  }
  
  try {
    const rows = await rawQuery(
      `SELECT element_value FROM ai_evaluate_detail ${whereClause} ORDER BY arrive_time DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    )
    console.log('rows OK:', rows.length)
  } catch(e) {
    console.log('rows ERROR:', e.message, '| code:', e.code)
  }
}
main().then(() => process.exit())
