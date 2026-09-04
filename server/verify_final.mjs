// 最终验证：用正确的返回字段
const BASE = 'http://127.0.0.1:36111'
async function get(path) {
  try {
    const r = await fetch(BASE + path, { headers: { 'x-user-eng': 'cookiethu' } })
    return await r.json()
  } catch (e) { return { __err: e.message } }
}
const j = (v) => JSON.stringify(v).slice(0, 200)

const tags = await get('/api/tags')
const list = Array.isArray(tags) ? tags : (tags.list || [])
const t0 = list[0]

console.log('=== 1. 数据更新至 ===')
const dm = await get('/api/data-meta')
console.log('  ', dm?.tagPrecision?.updatedAt, '(今天应为 2026-09-02)')

console.log('\n=== 2. 大盘趋势：15周 + W1=50 + 前三周≤65 + 峰值80 ===')
const tr = await get('/api/overview/trends')
const wt = tr?.weekTrend || []
const precs = wt.map(w => Number(w.precision))
console.log('  周数:', wt.length, '| 曲线:', precs.join(' → '))
console.log('  W1=50?', Math.abs(precs[0] - 50) < 0.5, '| 前三周≤65?', precs.slice(0, 3).every(p => p <= 65), '| 峰值80?', Math.abs(Math.max(...precs) - 80) < 0.5)
let d = 0; for (let i = 1; i < precs.length; i++) if (precs[i] < precs[i - 1]) d++
console.log('  高低错落：下降', d, '处')

console.log('\n=== 3. KPI ===')
const kpi = await get('/api/overview/kpi')
console.log('  精度:', kpi.precision, '| 绝对精度:', kpi.absolutePrecision, '| 样本:', kpi.sampleTotal, '| FP:', kpi.fpCount, '| 标签:', kpi.tagCount, '| 簇:', kpi.clusterCount)

console.log('\n=== 4. 标签下钻（核心：应有15周 + KPI三卡有值）===')
console.log('  标签:', t0?.id, t0?.name)
const trend = await get(`/api/tags/${t0.id}/trend?groupBy=ds`)
console.log('  趋势周数:', Array.isArray(trend) ? trend.length : 'ERR')
const detail = await get(`/api/tags/${t0.id}`)
console.log('  KPI三卡 → 精度:', detail.precision, '% | 样本:', detail.sampleTotal, '| FP:', detail.fp)
const samples = await get(`/api/tags/${t0.id}/samples`)
const sArr = Array.isArray(samples) ? samples : (samples.rows || [])
console.log('  素材明细条数:', sArr.length)
if (sArr.length) console.log('  首条素材:', j(sArr[0]).slice(0, 160))

console.log('\n=== 5. 结论沉淀库 ===')
const sed = await get('/api/sediments')
console.log('  沉淀条数:', Array.isArray(sed) ? sed.length : 'ERR')
console.log('  均有行业:', Array.isArray(sed) && sed.every(s => s.industryL1))
console.log('  样例:', j(sed[0]).slice(0, 170))

console.log('\n=== 6. 聚类簇 (overview/clusters 数据源=ai_evaluate_detail) ===')
const cl = await get('/api/overview/clusters')
console.log('  簇数:', cl?.total, '| 元素总数:', cl?.totalElements, '| 图片:', cl?.totalImages, '| 视频:', cl?.totalVideos)
console.log('  前3簇:', (cl?.clusters || []).slice(0, 3).map(c => `${c.classId}(${c.count})`).join(', '))

console.log('\n=== 7. 聚类簇 (badcase/clusters 数据源=sample_library_fine_label) ===')
const cl2 = await get(`/api/badcase/clusters?labelId=${t0.id}&sort=ratio`)
console.log('  簇数:', cl2?.total)
;(cl2?.clusters || []).slice(0, 3).forEach(c => console.log(`    ${c.clusterId} 元素=${c.total} 命中=${c.hit} 占比=${c.ratio}% 分区=${c.zone}`))

console.log('\n=== 8. 簇特征 ===')
const cf = await get(`/api/badcase/cluster-features?tagId=${t0.id}`)
console.log('  条数:', Array.isArray(cf) ? cf.length : 'ERR')

console.log('\n=== 9. 数据洞察 ===')
const di = await get(`/api/badcase/data-insight?tagId=${t0.id}`)
console.log('  周数:', di?.trend?.weeks?.length, '| 行业下钻:', (di?.industryDrillDown?.rows || []).length)

console.log('\n=== 10. 工单 / 通知 ===')
const tk = await get('/api/tickets')
console.log('  工单:', (Array.isArray(tk) ? tk : (tk.list || tk.rows || [])).length)
console.log('  通知:', j(await get('/api/notifications')))

console.log('\n=== 11. 全标签覆盖抽查（随机5个标签均有15周+素材）===')
for (const t of list.slice(0, 5)) {
  const tr2 = await get(`/api/tags/${t.id}/trend?groupBy=ds`)
  const sp = await get(`/api/tags/${t.id}/samples`)
  const sA = Array.isArray(sp) ? sp : (sp.rows || [])
  const dt2 = await get(`/api/tags/${t.id}`)
  console.log(`  ${t.id} ${t.name}: 趋势${Array.isArray(tr2) ? tr2.length : 0}周 | 素材${sA.length}条 | 精度${dt2.precision}% 样本${dt2.sampleTotal} FP${dt2.fp}`)
}
