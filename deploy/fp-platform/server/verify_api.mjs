// 端到端验证各页面接口数据
const BASE = 'http://127.0.0.1:36111'

async function get(path) {
  try {
    const r = await fetch(BASE + path, {
      headers: {
        'x-user-eng': 'cookiethu',
        'x-user-name': encodeURIComponent('超级管理员'),
        'x-user-team': encodeURIComponent('治理策略组'),
      },
    })
    const j = await r.json()
    return j
  } catch (e) {
    return { __err: e.message }
  }
}

console.log('=== 1. 数据更新时间 (dataMeta) ===')
const dm = await get('/api/data-meta')
console.log('updatedAt =', dm?.tagPrecision?.updatedAt, '| aiEval =', dm?.aiEval?.updatedAt)

console.log('\n=== 2. 大盘趋势 (overview/trends) 15周 ===')
const tr = await get('/api/overview/trends')
const wt = tr?.weekTrend || []
console.log('周数 =', wt.length)
wt.forEach(w => console.log(`  ${w.week} ${w.startDate}~${w.endDate} 精度=${w.precision}% 绝对=${w.absolutePrecision}% FP=${w.fp} 样本=${w.total}`))
console.log('日趋势点数 =', (tr?.dayTrend || []).length)

console.log('\n=== 3. KPI 概览 ===')
const kpi = await get('/api/overview/kpi')
console.log(JSON.stringify(kpi, null, 1))

console.log('\n=== 4. 标签列表（精度排行榜）===')
const tags = await get('/api/tags')
const list = Array.isArray(tags) ? tags : (tags.list || [])
console.log('标签数 =', list.length)
list.slice(0, 8).forEach(t => console.log(`  ${t.id} ${t.name} 精度=${t.precision}% 样本=${t.sampleTotal || t.total} FP=${t.fp}`))

console.log('\n=== 5. 标签下钻趋势（应15周）===')
const firstTag = list[0]
if (firstTag) {
  const trend = await get(`/api/tags/${firstTag.id}/trend?groupBy=ds`)
  console.log(`标签 ${firstTag.id} 趋势点数 =`, Array.isArray(trend) ? trend.length : 'ERR')
  if (Array.isArray(trend)) trend.forEach(t => console.log(`  ${t.date} 精度=${t.precision}% TP=${t.tp} FP=${t.fp} 样本=${t.total}`))

  const detail = await get(`/api/tags/${firstTag.id}`)
  console.log(`\n标签详情 KPI: 精度=${detail.precision}% 样本=${detail.sampleTotal} FP=${detail.fp}`)

  const insight = await get(`/api/tags/${firstTag.id}/insight`)
  if (insight && insight.trend) console.log('insight 周数 =', (insight.trend.weeks || []).length)
}

console.log('\n=== 6. 结论沉淀库 ===')
const sed = await get('/api/sediments')
console.log('沉淀条数 =', Array.isArray(sed) ? sed.length : 'ERR')
if (Array.isArray(sed) && sed.length) {
  const s = sed[0]
  console.log('首条:', s.title, '| 行业:', s.industryL1, '| 标签:', s.tagName, '| 样例数:', s.samples)
  const withIndustry = sed.filter(x => x.industryL1).length
  console.log('有行业值的条数 =', withIndustry, '/', sed.length)
}
const sedTags = await get('/api/sediments/tags')
console.log('沉淀标签下拉数 =', Array.isArray(sedTags) ? sedTags.length : 'ERR')

console.log('\n=== 7. 聚类簇特征 ===')
if (firstTag) {
  const cf = await get(`/api/badcase/cluster-features?tagId=${firstTag.id}`)
  console.log('簇特征数 =', Array.isArray(cf) ? cf.length : JSON.stringify(cf).slice(0, 150))
  if (Array.isArray(cf)) cf.forEach(c => console.log(`  ${c.classId}: ${(c.featureSummary || '').slice(0, 30)}... owner=${c.owner}`))
}

console.log('\n=== 8. 行业分布 / 元素类型 ===')
const ind = await get('/api/overview/industry-detail?industry=' + encodeURIComponent('医疗健康'))
console.log('行业下钻 =', Array.isArray(ind) ? `${ind.length} 条` : JSON.stringify(ind).slice(0, 150))
const el = await get('/api/overview/element-detail?element=' + encodeURIComponent('视频'))
console.log('元素下钻 =', Array.isArray(el) ? `${el.length} 条` : JSON.stringify(el).slice(0, 150))

console.log('\n=== 9. 聚类簇（误杀Case分析）===')
if (firstTag) {
  const cl = await get(`/api/badcase/clusters?labelId=${firstTag.id}&page=1&pageSize=5`)
  if (cl && cl.rows) {
    console.log(`标签 ${firstTag.id} 聚类簇总数 =`, cl.total || cl.rows.length)
    cl.rows.slice(0, 5).forEach(c => console.log(`  ${c.classId} 样本=${c.sampleCount || c.total} FP=${c.fp} 精度=${c.precision}%`))
  } else {
    console.log('聚类簇 =', JSON.stringify(cl).slice(0, 250))
  }
}

console.log('\n=== 10. 工单 ===')
const tk = await get('/api/tickets')
const tl = Array.isArray(tk) ? tk : (tk.list || tk.rows || [])
console.log('工单数 =', tl.length)

console.log('\n=== 11. 素材分类（上传数据）===')
if (firstTag) {
  const st = await get(`/api/classify-upload/${firstTag.id}/status`)
  console.log('上传状态 =', JSON.stringify(st).slice(0, 200))
  const sp = await get(`/api/classify-upload/${firstTag.id}/samples`)
  console.log('上传样本数 =', Array.isArray(sp) ? sp.length : (sp?.total ?? JSON.stringify(sp).slice(0, 120)))
}

console.log('\n=== 12. 通知 ===')
const nt = await get('/api/notifications')
console.log('通知数 =', JSON.stringify(nt).slice(0, 120))
