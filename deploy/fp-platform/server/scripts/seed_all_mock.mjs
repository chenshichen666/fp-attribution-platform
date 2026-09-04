/**
 * 综合mock数据脚本
 * 1. 修复 real_data_tag_precision 前3周精度（W1≈50%, W2≈55%, W3≈62%）
 * 2. 补充 cluster_data（聚类簇数据）
 * 3. 补充 real_data_samples（标签详情页样本数据）
 */
import { createRequire } from 'module'
import mysql2 from 'mysql2/promise'

const conn = await mysql2.createConnection({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, multipleStatements: true,
})

const INDUSTRIES = ['医疗健康','电商服务','美妆个护','数字传媒内容','食品饮料','通讯和IT服务','游戏','生活日用','金融','教育培训']
const ELEMENT_TYPES = ['ELEMENT_TYPE_IMAGE','ELEMENT_TYPE_VIDEO','ELEMENT_TYPE_TEXT','ELEMENT_TYPE_IMAGE']
const TAG_IDS = [14669,14776,15021,15088,15233,15300,15400,15500]
const TAG_NAMES = {14669:'营销内容',14776:'低俗诱导',15021:'违规广告',15088:'画面血腥',15233:'政治敏感',15300:'虚假宣传',15400:'违禁商品',15500:'色情低俗'}

// ============================================================
// 1. 修复 real_data_tag_precision 前3周精度
// W1(2026-04-27): 精度50% → tp=500, fp=500, fp_conf=450 (per tag: tp=10, fp=10)
// W2(2026-05-04): 精度55% → tp=550, fp=450
// W3(2026-05-11): 精度62% → tp=620, fp=380
// W4(2026-05-18): 精度67% → 已有67.2% 保持
// ============================================================
console.log('1. 修复前3周精度...')
const w1Weeks = [
  { ds: '2026-04-27', tpPer: 10, fpPer: 10 },   // 50%
  { ds: '2026-05-04', tpPer: 11, fpPer: 9 },    // 55%
  { ds: '2026-05-11', tpPer: 124, fpPer: 76 },  // 62% (per tag total)
]
for (const w of w1Weeks) {
  await conn.execute(
    `UPDATE real_data_tag_precision SET tp=?, fp=?, fp_conf=ROUND(?*0.9) WHERE ds=?`,
    [w.tpPer, w.fpPer, w.fpPer, w.ds]
  )
  const [r] = await conn.execute('SELECT SUM(tp) tp, SUM(fp) fp FROM real_data_tag_precision WHERE ds=?', [w.ds])
  const total = Number(r[0].tp) + Number(r[0].fp)
  const prec = total > 0 ? (Number(r[0].tp)/total*100).toFixed(1) : 0
  console.log(`  ds=${w.ds} → 精度=${prec}%`)
}

// ============================================================
// 2. 补充 cluster_data（确保聚类簇页面有数据）
// 当前787条，但class_id格式需核查
// ============================================================
console.log('2. 检查cluster_data...')
const [cdRows] = await conn.execute("SELECT DISTINCT class_id FROM cluster_data WHERE class_id LIKE 'c%' LIMIT 20")
console.log(`  已有聚类簇: ${cdRows.map(r=>r.class_id).join(',')}`)

const [cdCount] = await conn.execute("SELECT COUNT(*) c FROM cluster_data WHERE class_id LIKE 'c%'")
console.log(`  class_id以c开头的数据: ${cdCount[0].c}条`)

if (Number(cdCount[0].c) < 100) {
  console.log('  补充聚类簇数据...')
  // 生成20个簇，每簇15-30条记录
  const clusters = Array.from({length:20}, (_,i) => `c${i+1}`)
  const insertVals = []
  const baseDate = new Date('2026-08-01')
  
  for (const cid of clusters) {
    const clusterSize = 15 + Math.floor(Math.random()*20)
    const mainTagId = TAG_IDS[Math.floor(Math.random()*TAG_IDS.length)]
    const secTagId = TAG_IDS[Math.floor(Math.random()*TAG_IDS.length)]
    
    for (let j = 0; j < clusterSize; j++) {
      const daysOff = Math.floor(Math.random()*60)
      const d = new Date(baseDate.getTime() - daysOff*86400000)
      const ds = d.toISOString().slice(0,10)
      const et = ELEMENT_TYPES[Math.floor(Math.random()*ELEMENT_TYPES.length)]
      const isFP = Math.random() > 0.6  // 40%精度
      const policyIds = JSON.stringify([mainTagId, secTagId])
      const aiPolicyIds = isFP ? '[]' : JSON.stringify([mainTagId])
      const ext = et.includes('VIDEO') ? 'mp4' : 'jpg'
      const url = `https://example.com/ad/${cid}_${j}.${ext}`
      const fp = `efp_${cid}_${j}_${Date.now()}`
      insertVals.push([ds, et, policyIds, aiPolicyIds, url, fp, cid])
    }
  }
  
  // 批量插入
  for (let i=0; i<insertVals.length; i+=50) {
    const batch = insertVals.slice(i, i+50)
    const ph = batch.map(()=>'(?,?,?,?,?,?,?)').join(',')
    const flat = batch.flat()
    await conn.execute(
      `INSERT INTO cluster_data (arrive_time,element_type,policy_ids,ai_evaluate_policy_ids,element_value,element_fingerprint,class_id) VALUES ${ph}`,
      flat
    )
  }
  console.log(`  插入 ${insertVals.length} 条聚类数据`)
}

// ============================================================
// 3. 补充 real_data_samples（标签详情页需要数据）
// 每个tag_id补充至少200条样本，覆盖各行业、元素类型
// ============================================================
console.log('3. 检查real_data_samples...')
const [sampleCounts] = await conn.execute(
  'SELECT tag_id, COUNT(*) c FROM real_data_samples GROUP BY tag_id ORDER BY tag_id'
)
console.log('  当前各tag样本数:', JSON.stringify(sampleCounts.map(r=>({tag:r.tag_id,c:r.c}))))

const WEEKS_DATES = [
  '2026-04-27','2026-05-04','2026-05-11','2026-05-18','2026-05-25',
  '2026-06-01','2026-06-08','2026-06-15','2026-06-22','2026-06-29',
  '2026-07-06','2026-07-13','2026-07-20','2026-07-27','2026-08-03',
  '2026-08-10','2026-08-17','2026-08-24','2026-08-31'
]

// 各周目标精度（与real_data_tag_precision一致）
const WEEK_PRECISION = [0.50, 0.55, 0.62, 0.67, 0.75, 0.63, 0.70, 0.76, 0.77, 0.78, 0.875, 0.86, 0.83, 0.86, 0.87, 0.893, 0.89, 0.865, 0.853]

const existingTagIds = new Set(sampleCounts.map(r=>Number(r.tag_id)))
const CLASS_IDS = ['c1','c2','c3','c4','c5','c6','c7','c8','c9','c10']

for (const tagId of TAG_IDS) {
  const existing = sampleCounts.find(r=>Number(r.tag_id)===tagId)?.c || 0
  if (existing >= 200) { console.log(`  tag ${tagId} 已有 ${existing} 条，跳过`); continue }
  
  const tagName = TAG_NAMES[tagId] || `标签${tagId}`
  console.log(`  为tag ${tagId}(${tagName}) 补充样本...`)
  const insertSamples = []
  
  // 每周补充约20条
  for (let wi=0; wi<WEEKS_DATES.length; wi++) {
    const ds = WEEKS_DATES[wi]
    const prec = WEEK_PRECISION[wi]
    const weekSamples = 15 + Math.floor(Math.random()*10)
    
    for (let j=0; j<weekSamples; j++) {
      const ind = INDUSTRIES[Math.floor(Math.random()*INDUSTRIES.length)]
      const et = ELEMENT_TYPES[Math.floor(Math.random()*ELEMENT_TYPES.length)]
      const isFP = Math.random() > prec ? 1 : 0  // 按精度比例生成fp
      const cid = CLASS_IDS[Math.floor(Math.random()*CLASS_IDS.length)]
      const ext = et.includes('VIDEO') ? 'mp4' : 'jpg'
      const mediaUrl = `https://example.com/sample/${tagId}_${ds}_${j}.${ext}`
      const fp2 = `efp_s${tagId}_${wi}_${j}`
      const advertiser = `广告主${Math.floor(Math.random()*20)+1}`
      const policyIds = JSON.stringify([tagId])
      const aiPolicyIds = isFP ? '[]' : JSON.stringify([tagId])
      
      insertSamples.push([
        tagId, tagName, `sample_${tagId}_${wi}_${j}`,
        fp2, et, et.includes('VIDEO')?1:0,
        String(tagId), isFP?'':String(tagId),
        ind, ind,
        mediaUrl, '', '',
        advertiser, ds, ds, isFP,
        isFP?'误杀':'正常', '',
        1, cid,
        'reviewer01', '',advertiser,'',
        policyIds, aiPolicyIds, `uid_${tagId}_${j}`
      ])
    }
  }
  
  // 批量插入
  for (let i=0; i<insertSamples.length; i+=50) {
    const batch = insertSamples.slice(i, i+50)
    const ph = batch.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const flat = batch.flat()
    await conn.execute(
      `INSERT IGNORE INTO real_data_samples 
       (tag_id,tag_name,sample_id,element_fingerprint,element_type,is_video,machine_tag,human_tag,
        first_level_industry_name,second_level_industry_name,media_url,ocr_content,asr_content,
        advertiser,arrive_time,ds,is_fp,fp_reason,remark,class_num,class_id,reviewer_name,
        dc_id,ops_advertiser_name,ai_evaluate_reviewer_name,policy_ids,ai_evaluate_policy_ids,uid)
       VALUES ${ph}`,
      flat
    )
  }
  console.log(`  插入 ${insertSamples.length} 条样本`)
}

// ============================================================
// 4. 验证结果
// ============================================================
console.log('\n=== 验证结果 ===')
const [precCheck] = await conn.execute(
  'SELECT ds, SUM(tp) tp, SUM(fp) fp FROM real_data_tag_precision GROUP BY ds ORDER BY ds LIMIT 5'
)
for (const r of precCheck) {
  const total = Number(r.tp)+Number(r.fp)
  console.log(`  ${r.ds}: 精度=${(Number(r.tp)/total*100).toFixed(1)}%`)
}

const [cdFinal] = await conn.execute("SELECT COUNT(DISTINCT class_id) clsn, COUNT(*) total FROM cluster_data WHERE class_id LIKE 'c%'")
console.log(`  cluster_data: ${cdFinal[0].clsn}个簇, ${cdFinal[0].total}条`)

const [sfinal] = await conn.execute('SELECT COUNT(*) c FROM real_data_samples')
console.log(`  real_data_samples: ${sfinal[0].c}条`)

await conn.end()
console.log('\n完成!')
