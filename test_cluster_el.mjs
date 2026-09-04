import { rawQuery } from './server/src/db/pool.js'
async function main() {
  // 模拟后端 cluster-elements 的查询
  const classId = 'c1'
  const page = 1, pageSize = 50
  const offset = (page - 1) * pageSize
  
  // 测试完整 SQL
  try {
    const rows = await rawQuery(
      `SELECT element_value, element_fingerprint, element_type, element_type_name,
        policy_ids, ai_evaluate_policy_ids, ocr_content, asr_content, arrive_time,
        first_level_industry_name, second_level_industry_name
       FROM ai_evaluate_detail
       WHERE class_id = ?
       ORDER BY arrive_time DESC
       LIMIT ? OFFSET ?`,
      [classId, pageSize, offset]
    )
    console.log('OK rows:', rows.length)
  } catch(e) {
    console.log('ERROR:', e.message)
    console.log('SQLSTATE:', e.sqlState)
    console.log('code:', e.code)
  }
}
main().then(() => process.exit())
