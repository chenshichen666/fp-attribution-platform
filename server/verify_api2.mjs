// 验证聚类簇、沉淀库搜索、自由分析等剩余页面
const BASE = 'http://127.0.0.1:36111'
async function get(path) {
  try {
    const r = await fetch(BASE + path, {
      headers: { 'x-user-eng': 'cookiethu', 'x-user-name': encodeURIComponent('超级管理员') },
    })
    return await r.json()
  } catch (e) { return { __err: e.message } }
}

const tags = await get('/api/tags')
const list = Array.isArray(tags) ? tags : (tags.list || [])
const t0 = list[0]
console.log('使用标签:', t0?.id, t0?.name)

console.log('\n=== 聚类簇 (overview/clusters) ===')
const cl = await get('/api/overview/clusters?page=1&pageSize=5')
console.log('总数 =', cl?.total, '| 本页 =', (cl?.rows || []).length)
;(cl?.rows || []).slice(0, 5).forEach(c => console.log(`  ${c.classId} 样本=${c.sampleCount ?? c.total} FP=${c.fp} 精度=${c.precision}%`))

console.log('\n=== 聚类簇 (badcase/clusters 带 sort) ===')
if (t0) {
  const cl2 = await get(`/api/badcase/clusters?labelId=${t0.id}&sort=ratio`)
  console.log('总数 =', cl2?.total, '| 条数 =', (cl2?.clusters || []).length)
  ;(cl2?.clusters || []).slice(0, 5).forEach(c => console.log(`  ${c.classId} 样本=${c.total} FP=${c.fpCount ?? c.fp} 精度=${c.precision}%`))
  const hist = await get(`/api/badcase/histogram?labelId=${t0.id}`)
  console.log('直方图 =', JSON.stringify(hist).slice(0, 150))
  const st = await get(`/api/badcase/stats?labelId=${t0.id}`)
  console.log('统计 =', JSON.stringify(st).slice(0, 200))
}

console.log('\n=== 沉淀库搜索 ===')
const s1 = await get('/api/sediments/search?q=' + encodeURIComponent('误判'))
console.log('搜索"误判" =', Array.isArray(s1) ? s1.length : 'ERR')
const s2 = await get('/api/sediments/search?industry=' + encodeURIComponent('医疗健康'))
console.log('按行业"医疗健康" =', Array.isArray(s2) ? s2.length : 'ERR')
const s3 = await get('/api/sediments/search?resultType=real_fp')
console.log('按结论real_fp =', Array.isArray(s3) ? s3.length : 'ERR')

console.log('\n=== 数据洞察 (data-insight) ===')
if (t0) {
  const di = await get(`/api/badcase/data-insight?tagId=${t0.id}`)
  console.log('周数 =', di?.trend?.weeks?.length, '| 精度 =', (di?.trend?.precision || []).slice(0, 15).join(','))
  console.log('行业下钻行数 =', (di?.industryDrillDown?.rows || []).length)
}

console.log('\n=== 标签样本明细 ===')
if (t0) {
  const sp = await get(`/api/tags/${t0.id}/samples?page=1&pageSize=3`)
  console.log('样本总数 =', sp?.total, '| 本页 =', (sp?.rows || []).length)
  if ((sp?.rows || []).length) console.log('首条:', JSON.stringify(sp.rows[0]).slice(0, 180))
}
