<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useAuthStore } from '../../stores/auth'
import { tagApi, dataMetaApi, overviewApi } from '../../api/index'
import Icon from '../../components/Icon.vue'
import KpiCard from '../../components/KpiCard.vue'
import EChart from '../../components/EChart.vue'
import DateRangeFilter from '../../components/DateRangeFilter.vue'
import ClusterView from './ClusterView.vue'
import { useRemotePersistedRef } from '../../utils/usePersistedRef'

const router = useRouter()
const toast = useToastStore()
const auth = useAuthStore()
// 总览内 tab：标签概况（KPI+趋势）/ 聚类簇（标签维度已迁移至「误杀Case分析 → 标签跟踪」）
const mainTab = useRemotePersistedRef('analysis:mainTab', 'overview')

// 数据上传态：所有数据由管理员上传到后端，各角色登录后共享
const dataMeta = ref({ updatedAt: '', updatedBy: '', fileName: '', isDraft: false })
const uploaded = computed(() => !!dataMeta.value.updatedAt)
// 概览 KPI（真实 API）
const kpi = reactive({ precision: 0, fpRate: 0, fpCount: 0, tagCount: 0, sampleTotal: 0, fileName: '', absolutePrecision: 0, clusterCount: 0, precisionChange: null, absolutePrecisionChange: null, fpCountChange: null, sampleTotalChange: null, tagCountChange: null, clusterCountChange: null, changePeriod: '' })
const loading = ref(false)

// 全局时间筛选：控制 KPI 卡 + 趋势图（真实数据按 arrive_time 范围聚合）
const globalDate = useRemotePersistedRef('analysis:globalDate', { preset: '', start: '', end: '' })
// 数据最新业务日期（YYYY-MM-DD），作为「近N天」preset 的终点锚点
const dataMaxDate = ref('')

// preset(近N天) → {start,end} 真实日期范围；自定义则直接用 start/end
function dateRange() {
  const g = globalDate.value
  if (g.start || g.end) return { start: g.start, end: g.end }
  return {}
}

// 是否已用数据实际周期初始化过时间窗口
let dateInited = false
// 初始化标志：首次设置 globalDate 时阻止 watch 重复触发 loadData，避免丢弃数据后重复加载
let initializing = false

// 趋势图数据（真实 API）
const trendsData = ref({ weekTrend: [], dayTrend: [] })
const trendsLoading = ref(false)

// 精度排行榜（行业 / 元素类型维度，与趋势同源按 arrive_time 联动）
const ranking = ref({ byElement: [], byIndustry: [] })
const rankingLoading = ref(false)

// 周维度趋势图默认折叠（暂无数据）


// 日期偏移：基于 YYYY-MM-DD 字符串前移/后移 n 天
function shiftDate(s, n) {
  const dt = new Date(String(s).slice(0, 10) + 'T00:00:00')
  if (isNaN(dt.getTime())) return ''
  dt.setDate(dt.getDate() + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// 近7天 vs 前7天 各指标变化（图四式 KPI 卡）
// 精度类 = 百分点变化（pp）；数量类 = 相对变化比例（%）
async function loadKpiChange(k) {
  const maxD = (k && k.dataMaxDate) || ''
  if (!maxD) {
    kpi.precisionChange = null
    kpi.absolutePrecisionChange = null
    kpi.fpCountChange = null
    kpi.sampleTotalChange = null
    kpi.tagCountChange = null
    kpi.clusterCountChange = null
    kpi.changePeriod = ''
    return
  }
  const lastStart = shiftDate(maxD, -6)
  const prevEnd = shiftDate(maxD, -7)
  const prevStart = shiftDate(maxD, -13)
  try {
    const [cur, prev] = await Promise.all([
      overviewApi.kpi({ start: lastStart, end: maxD }),
      overviewApi.kpi({ start: prevStart, end: prevEnd }),
    ])
    const abs = (c, p) => (c != null && p != null ? Number((c - p).toFixed(1)) : null)
    const pct = (c, p) => (p != null && p > 0 ? Number(((c - p) / p * 100).toFixed(0)) : null)
    kpi.precisionChange = cur && prev ? { value: abs(cur.precision, prev.precision), type: 'absolute' } : null
    kpi.absolutePrecisionChange = cur && prev ? { value: abs(cur.absolutePrecision, prev.absolutePrecision), type: 'absolute' } : null
    kpi.fpCountChange = cur && prev ? { value: pct(cur.fpCount, prev.fpCount), type: 'relative' } : null
    kpi.sampleTotalChange = cur && prev ? { value: pct(cur.sampleTotal, prev.sampleTotal), type: 'relative' } : null
    kpi.tagCountChange = cur && prev ? { value: pct(cur.tagCount, prev.tagCount), type: 'relative' } : null
    kpi.clusterCountChange = cur && prev ? { value: pct(cur.clusterCount, prev.clusterCount), type: 'relative' } : null
    kpi.changePeriod = `${lastStart.slice(5).replace('-', '/')}-${maxD.slice(5).replace('-', '/')}`
  } catch {
    kpi.precisionChange = null
    kpi.absolutePrecisionChange = null
    kpi.fpCountChange = null
    kpi.sampleTotalChange = null
    kpi.tagCountChange = null
    kpi.clusterCountChange = null
    kpi.changePeriod = ''
  }
}

async function loadData() {
  loading.value = true
  try {
    let range = dateRange()
    if (!dateInited) {
      dateInited = true
      // dataMeta 与探测 overview 并行，缩短首屏白屏时间
      const [meta, p] = await Promise.all([dataMetaApi.get(), tagApi.overview({})])
      if (meta) {
        if (meta.aiEval || meta.tagPrecision) {
          const primary = meta.aiEval?.updatedAt ? meta.aiEval : meta.tagPrecision
          dataMeta.value = primary || { updatedAt: '', updatedBy: '', fileName: '', isDraft: false }
        } else {
          dataMeta.value = { ...meta, isDraft: false }
        }
      }
      if (p && p.dataMinDate && p.dataMaxDate) {
        range = { start: p.dataMinDate, end: p.dataMaxDate }
        dataMaxDate.value = p.dataMaxDate
        initializing = true
        globalDate.value = { preset: '', start: p.dataMinDate, end: p.dataMaxDate }
      }
    }

    if (!uploaded.value) {
      Object.assign(kpi, { precision: 0, fpRate: 0, fpCount: 0, tagCount: 0, sampleTotal: 0, fileName: '' })
      return
    }

    // 并行加载概览KPI + 趋势图数据
    trendsLoading.value = true
    overviewApi.trends(range).then(t => {
      trendsData.value = t || { weekTrend: [], dayTrend: [] }
    }).catch(() => {
      trendsData.value = { weekTrend: [], dayTrend: [] }
    }).finally(() => { trendsLoading.value = false })

    overviewApi.kpi(range).then(k => {
      if (k) {
        kpi.precision = k.precision ?? 0
        kpi.absolutePrecision = k.absolutePrecision ?? 0
        kpi.sampleTotal = k.sampleTotal ?? 0
        kpi.fpCount = k.fpCount ?? 0
        kpi.tagCount = k.tagCount ?? 0
        kpi.clusterCount = k.clusterCount ?? 0
      }
      // 近7天 vs 前7天 变化（图四式 KPI 卡）
      loadKpiChange(k)
    }).catch(() => {})

    // 精度排行榜（行业 / 元素类型维度），与趋势同源联动
    rankingLoading.value = true
    overviewApi.ranking(range).then(r => {
      ranking.value = {
        byElement: (r && r.byElement) || [],
        byIndustry: (r && r.byIndustry) || [],
      }
    }).catch(() => {
      ranking.value = { byElement: [], byIndustry: [] }
    }).finally(() => { rankingLoading.value = false })

    // 交叉分析矩阵（行业 × 元素类型，与排行榜同源联动）
    loadCross()

    initializing = false
  } catch (e) {
    initializing = false
    toast.warn(e.message || '加载概览数据失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => { loadData() })
watch(globalDate, () => { if (initializing) return; loadData() }, { deep: true })

// KPI 卡直接使用真实概览数据（已随时间范围联动）
const liveKpi = computed(() => kpi)

// ===== 周维度精度趋势图 =====
// 计算本周环比指标
const weekTrendSummary = computed(() => {
  const d = trendsData.value.weekTrend || []
  if (d.length < 1) return { panPrec: null, absPrec: null, panChange: null, absChange: null }
  const last = d[d.length - 1]
  const prev = d.length >= 2 ? d[d.length - 2] : null
  const panPrec = last.precision
  const absPrec = last.absolutePrecision
  const panChange = prev ? Number((panPrec - prev.precision).toFixed(2)) : null
  const absChange = prev && absPrec != null && prev.absolutePrecision != null ? Number((absPrec - prev.absolutePrecision).toFixed(2)) : null
  return { panPrec, absPrec, panChange, absChange }
})

const weekTrendOption = computed(() => {
  const d = trendsData.value.weekTrend || []
  // 判断每个数据点是否未满7天
  const isPartial = d.map(t => (t.days != null && t.days < 7))
  // 构造连续线段的 lineStyle 数据
  // ECharts 支持在 series.data 中逐点设置样式
  const panData = d.map((t, i) => {
    const val = t.precision ?? null
    const item = { value: val }
    if (isPartial[i]) {
      item.symbol = 'circle'
      item.symbolSize = 7
      item.itemStyle = { color: '#fff', borderColor: '#f97316', borderWidth: 2 }
    }
    return item
  })
  const absData = d.map((t, i) => {
    const val = t.absolutePrecision ?? null
    const item = { value: val }
    if (isPartial[i]) {
      item.symbol = 'circle'
      item.symbolSize = 7
      item.itemStyle = { color: '#fff', borderColor: '#22c55e', borderWidth: 2 }
    }
    return item
  })
  // 构造 pieces 用于 visualMap 虚线段
  // 改用 markLine 不行，用 lineStyle 的 type 按段
  // ECharts 不支持逐段 lineStyle，改用覆盖两个 series（实线+虚线）方案
  // 简化：最后一个点如果 partial，用 series 叠加方案
  // 最终方案：用 data item 的自定义 + 全局 lineStyle 为实线，最后一段如partial则叠一条虚线段

  return {
    grid: { left: 40, right: 24, top: 42, bottom: 30, containLabel: true },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        if (!params || !params.length) return ''
        const idx = params[0].dataIndex
        const item = d[idx]
        if (!item) return ''
        const dateRange = item.startDate && item.endDate
          ? `${item.startDate} ~ ${item.endDate}` : (item.date || '')
        const partial = isPartial[idx] ? `<span style="color:#f59e0b;font-size:11px">（仅${item.days}天数据）</span>` : ''
        let html = `<div style="font-weight:600;margin-bottom:4px">${item.week} ${partial}</div>`
        html += `<div style="color:#8b94a8;font-size:11px;margin-bottom:6px">${dateRange}</div>`
        params.forEach(p => {
          if (p.value != null) {
            html += `<div style="display:flex;align-items:center;gap:6px;margin:2px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>${p.seriesName} <b>${p.value}%</b></div>`
          }
        })
        return html
      }
    },
    legend: {
      data: [
        { name: '大盘精度', icon: 'roundRect' },
        { name: '绝对精度', icon: 'roundRect' },
        { name: '虚线点 = 未满7天', icon: 'circle' },
      ],
      right: 8, top: 4,
      itemWidth: 14, itemHeight: 8,
      textStyle: { fontSize: 11, color: '#5a6478' },
      formatter: (name) => name === '虚线点 = 未满7天' ? '{partial|○ 虚线点 = 未满7天}' : name,
      textStyle: {
        fontSize: 11, color: '#5a6478',
        rich: { partial: { fontSize: 10, color: '#f59e0b', padding: [0, 0, 0, 2] } }
      },
    },
    xAxis: {
      type: 'category',
      data: d.map(t => t.week || ''),
      axisLabel: { fontSize: 11, color: '#8b94a8' },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', max: 100, min: v => Math.max(0, Math.floor((v.min - 5) / 10) * 10),
      axisLabel: { formatter: '{value}%', color: '#8b94a8', fontSize: 11 },
      splitLine: { lineStyle: { color: '#f0f2f6', type: 'dashed' } },
    },
    series: [
      {
        name: '大盘精度', type: 'line', smooth: false,
        data: panData.map((item, i) => {
          const pv = typeof item === 'object' ? item.value : item
          const av = (() => { const a = absData[i]; return typeof a === 'object' ? a.value : a })()
          const tooClose = pv != null && av != null && Math.abs(pv - av) < 4
          const panAbove = pv == null || av == null || pv >= av
          const base = typeof item === 'object' ? { ...item } : { value: item }
          base.label = {
            show: true, fontSize: 10, color: '#f97316', fontWeight: 600,
            formatter: p => p.value != null ? p.value + '%' : '',
            position: panAbove ? 'top' : 'bottom',
            offset: tooClose ? (panAbove ? [0, -6] : [0, 6]) : [0, 0],
          }
          return base
        }),
        lineStyle: { color: '#f97316', width: 2.4 }, itemStyle: { color: '#f97316' },
        symbol: 'circle', symbolSize: 6,
      },
      {
        name: '绝对精度', type: 'line', smooth: false,
        data: absData.map((item, i) => {
          const av = typeof item === 'object' ? item.value : item
          const pv = (() => { const p = panData[i]; return typeof p === 'object' ? p.value : p })()
          const tooClose = pv != null && av != null && Math.abs(pv - av) < 4
          const absAbove = av != null && pv != null && av > pv
          const base = typeof item === 'object' ? { ...item } : { value: item }
          base.label = {
            show: true, fontSize: 10, color: '#22c55e', fontWeight: 600,
            formatter: p => p.value != null ? p.value + '%' : '',
            position: absAbove ? 'top' : 'bottom',
            offset: tooClose ? (absAbove ? [0, -6] : [0, 6]) : [0, 0],
          }
          return base
        }),
        lineStyle: { color: '#22c55e', width: 2.4 }, itemStyle: { color: '#22c55e' },
        symbol: 'circle', symbolSize: 6,
      },
      {
        name: '虚线点 = 未满7天', type: 'line',
        data: [], lineStyle: { opacity: 0 }, itemStyle: { opacity: 0 },
        symbol: 'none',
      },
    ],
  }
})

// ===== 日维度精度趋势图 =====
const dayTrendOption = computed(() => {
  const d = trendsData.value.dayTrend || []
  return {
    grid: { left: 45, right: 56, top: 42, bottom: 30, containLabel: true },
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['大盘精度', '绝对精度', '初审拒绝率'], right: 8, top: 4,
      icon: 'roundRect', itemWidth: 14, itemHeight: 8,
      textStyle: { fontSize: 11, color: '#5a6478' },
    },
    xAxis: {
      type: 'category',
      data: d.map(t => {
        const date = t.date || ''
        if (date.length >= 10) return date.slice(5)
        return date
      }),
      axisLabel: { fontSize: 11, color: '#8b94a8' },
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value', max: 100, min: 0, interval: 20,
        axisLabel: { formatter: '{value}%', color: '#8b94a8', fontSize: 11 },
        splitLine: { lineStyle: { color: '#f0f2f6', type: 'dashed' } },
      },
      {
        type: 'value', position: 'right', max: 100, min: 0, interval: 20,
        axisLabel: { formatter: '{value}%', color: '#8b94a8', fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '大盘精度', type: 'line', smooth: false, yAxisIndex: 0,
        data: d.map(t => t.precision ?? null),
        lineStyle: { color: '#f97316', width: 2.4 }, itemStyle: { color: '#f97316' },
        symbol: 'circle', symbolSize: 6,
        label: { show: true, position: 'top', formatter: '{c}%', fontSize: 9, color: '#f97316', fontWeight: 600 },
      },
      {
        name: '绝对精度', type: 'line', smooth: false, yAxisIndex: 0,
        data: d.map(t => t.absolutePrecision ?? null),
        lineStyle: { color: '#22c55e', width: 2.4 }, itemStyle: { color: '#22c55e' },
        symbol: 'circle', symbolSize: 6,
        label: { show: true, position: 'bottom', formatter: '{c}%', fontSize: 9, color: '#22c55e', fontWeight: 600 },
      },
      {
        name: '初审拒绝率', type: 'bar', yAxisIndex: 1,
        data: d.map(t => t.rejectRate ?? null),
        barWidth: '42%',
        itemStyle: { color: '#94a3b8', borderRadius: [3, 3, 0, 0] },
        label: { show: true, position: 'top', formatter: p => p.value != null ? p.value + '%' : '', fontSize: 9, color: '#64748b' },
      },
    ],
  }
})

// 精度五档配色（与大盘口径一致）：<50 红 / 50-70 橙 / 70-80 黄 / 80-90 浅绿 / ≥90 绿
function precisionColor(p) {
  if (p < 50) return { bg: '#fee2e2', fg: '#dc2626', bar: 'linear-gradient(90deg,#fca5a5,#ef4444)' }
  if (p < 70) return { bg: '#ffedd5', fg: '#ea580c', bar: 'linear-gradient(90deg,#fdba74,#f97316)' }
  if (p < 80) return { bg: '#fef9c3', fg: '#ca8a04', bar: 'linear-gradient(90deg,#fde047,#eab308)' }
  if (p < 90) return { bg: '#dcfce7', fg: '#16a34a', bar: 'linear-gradient(90deg,#86efac,#22c55e)' }
  return { bg: '#bbf7d0', fg: '#15803d', bar: 'linear-gradient(90deg,#6ee7b7,#10b981)' }
}
// 交叉矩阵整格热力配色（参照图：红→橙→琥珀→绿→青，浅色档用深字保证可读）
function heatCell(p) {
  if (p < 50) return { bg: '#ef4444', fg: '#ffffff' }
  if (p < 70) return { bg: '#f97316', fg: '#ffffff' }
  if (p < 80) return { bg: '#f59e0b', fg: '#1f2937' }
  if (p < 90) return { bg: '#16a34a', fg: '#ffffff' }
  return { bg: '#0d9488', fg: '#ffffff' }
}

// 精度排行榜子维度切换：按一级行业 / 按元素类型
const rankDim = useRemotePersistedRef('analysis:rankDim', 'industry')
const activeRank = computed(() => {
  const list = rankDim.value === 'industry' ? ranking.value.byIndustry : ranking.value.byElement
  return (list || []).filter(x => x && x.name)
})
// 当前维度最大误杀量，用于误杀条形图比例
const rankMaxFp = computed(() => {
  const list = activeRank.value
  if (!list.length) return 1
  return Math.max(...list.map(x => Number(x.fp) || 0), 1)
})

// ===== 钻取详情抽屉（行业 / 元素类型两模式） =====
// 按一级行业维度点击 → 行业钻取（byElement/bySecond/byTag）
// 按元素类型维度点击 → 元素类型钻取（byIndustry/byTag）
const industryDrawer = reactive({ open: false, loading: false, loadingName: '', detail: null })
const elementDrawer = reactive({ open: false, loading: false, loadingName: '', detail: null })
function onRankRowClick(e) {
  const li = e.target.closest('.rank-item')
  if (!li) return
  const name = li.getAttribute('data-name')
  if (!name) return
  if (rankDim.value === 'element') openElementDrawer(name)
  else openIndustryDrawer(name)
}
function openIndustryDrawer(name) {
  industryDrawer.open = true
  industryDrawer.loading = true
  industryDrawer.loadingName = name
  industryDrawer.detail = null
  overviewApi.industryDetail(name).then(d => {
    industryDrawer.detail = d || null
  }).catch(() => {
    industryDrawer.detail = null
  }).finally(() => { industryDrawer.loading = false })
}
function closeIndustryDrawer() {
  industryDrawer.open = false
}
function openElementDrawer(name) {
  elementDrawer.open = true
  elementDrawer.loading = true
  elementDrawer.loadingName = name
  elementDrawer.detail = null
  overviewApi.elementDetail(name).then(d => {
    elementDrawer.detail = d || null
  }).catch(() => {
    elementDrawer.detail = null
  }).finally(() => { elementDrawer.loading = false })
}
function closeElementDrawer() {
  elementDrawer.open = false
}

// ===== 交叉分析：行业 × 元素类型 精度矩阵 =====
// 数据源与精度排行榜同源（ai_evaluate_detail 全量），不受全局时间窗过滤
const cross = reactive({ modalities: [], rows: [] })
const crossLoading = ref(false)
const crossCollapsed = ref(false)
function crossCell(row, elName) {
  const c = row && row.cells && row.cells[elName]
  return c || { precision: 0, total: 0, fp: 0, hasData: false }
}
function crossAdvertisers(row) {
  const arr = (row && row.advertisers) || []
  const out = []
  for (let i = 0; i < 1; i++) out.push(arr[i] || { advertiser: '', precision: 0, total: 0, fp: 0, hasData: false })
  return out
}
function loadCross() {
  crossLoading.value = true
  overviewApi.crossAnalysis({ topK: 1 }).then(d => {
    if (d) {
      cross.modalities = d.modalities || []
      cross.rows = d.rows || []
    }
  }).catch(() => {
    cross.modalities = []
    cross.rows = []
  }).finally(() => { crossLoading.value = false })
}

// 交叉点钻取弹窗（行业 × 元素类型 低精度标签贡献）
const crossModal = reactive({ open: false, loading: false, loadingName: '', detail: null })
function onCrossCellClick(industry, element) {
  const cell = crossCell(
    cross.rows.find(r => r.industry === industry),
    element
  )
  if (!cell.hasData) return
  crossModal.open = true
  crossModal.loading = true
  crossModal.loadingName = `${industry} · ${element}`
  crossModal.detail = null
  overviewApi.crossDetail(industry, element).then(d => {
    crossModal.detail = d || null
  }).catch(() => {
    crossModal.detail = null
  }).finally(() => { crossModal.loading = false })
}
function onCrossAdvClick(industry, adv) {
  if (!adv || !adv.hasData) return
  crossModal.open = true
  crossModal.loading = true
  crossModal.loadingName = `${industry} · 广告主 ${adv.advertiser}`
  crossModal.detail = null
  overviewApi.crossDetail(industry, '', adv.advertiser).then(d => {
    crossModal.detail = d || null
  }).catch(() => {
    crossModal.detail = null
  }).finally(() => { crossModal.loading = false })
}
function closeCrossModal() {
  crossModal.open = false
}

// ===== 趋势图标签下钻：点击数据点设置时间范围 =====
function onWeekTrendClick(params) {
  if (!params || params.dataIndex == null) return
  const d = trendsData.value.weekTrend || []
  const item = d[params.dataIndex]
  if (!item || !item.startDate || !item.endDate) return
  // 设置 globalDate 为该周的时间范围，联动排行榜和交叉分析
  globalDate.value = { preset: '', start: item.startDate, end: item.endDate }
}

function onDayTrendClick(params) {
  if (!params || params.dataIndex == null) return
  const d = trendsData.value.dayTrend || []
  const item = d[params.dataIndex]
  if (!item || !item.date) return
  // 设置 globalDate 为该日的时间范围，联动排行榜和交叉分析
  globalDate.value = { preset: '', start: item.date, end: item.date }
}
</script>

<template>
  <div class="page-wrap">
    <!-- 无数据时提示 -->
    <div v-if="!uploaded && !loading" class="data-status-bar">
      <div class="dsb-left">
        <span class="dsb-ic"><Icon name="database" :size="18" /></span>
        <div class="dsb-info">
          <strong>暂无评测数据</strong>
          <em>{{ auth.isAdmin ? '请前往「管理 → 数据管理」上传评测数据' : '请等待管理员上传评测数据' }}</em>
        </div>
      </div>
      <button v-if="auth.isAdmin" class="btn btn-primary btn-sm" @click="router.push('/manage/data')">
        <Icon name="database" :size="15" />前往数据管理
      </button>
    </div>

    <!-- 初始加载中：避免空白 -->
    <div v-else-if="!uploaded && loading" class="init-loading">
      <span class="spin"></span>正在加载概览数据…
    </div>

    <template v-else-if="uploaded">
      <!-- 控制条：时间窗口（左定格）+ 总览内部 tab（右定格） -->
      <div class="top-bar">
        <div class="top-date">
          <DateRangeFilter v-model="globalDate" :max-date="dataMaxDate" />
        </div>
        <div class="seg-tabs main-tabs">
          <button :class="{ on: mainTab === 'overview' }" @click="mainTab = 'overview'">标签概况</button>
          <button :class="{ on: mainTab === 'cluster' }" @click="mainTab = 'cluster'">聚类簇</button>
        </div>
      </div>

      <!-- 标签概况：KPI + 周/日维度精度趋势（整页） -->
      <template v-if="mainTab === 'overview'">
        <!-- 6 指标卡：大盘精度 / 绝对精度 / 总样本数 / FP数 / 标签数 / 聚类簇数（常驻总览） -->
        <div class="kpi-row">
          <KpiCard icon="precision" label="大盘精度" :value="liveKpi.precision" unit="%" color="orange" :change="liveKpi.precisionChange" :period="liveKpi.changePeriod" />
          <KpiCard icon="checkCircle" label="绝对精度" :value="liveKpi.absolutePrecision" unit="%" color="green" :change="liveKpi.absolutePrecisionChange" :period="liveKpi.changePeriod" />
          <KpiCard icon="sample" label="总样本数" :value="liveKpi.sampleTotal" color="blue" :change="liveKpi.sampleTotalChange" :period="liveKpi.changePeriod" />
          <KpiCard icon="fpcount" label="FP 数" :value="liveKpi.fpCount" color="red" :change="liveKpi.fpCountChange" :period="liveKpi.changePeriod" />
          <KpiCard icon="tagcount" label="标签数" :value="liveKpi.tagCount" color="purple" :change="liveKpi.tagCountChange" :period="liveKpi.changePeriod" />
          <KpiCard icon="box" label="聚类簇数" :value="liveKpi.clusterCount" color="blue" :change="liveKpi.clusterCountChange" :period="liveKpi.changePeriod" />
        </div>

        <!-- 双趋势图（纵向堆叠，非并列） -->
        <div class="trend-stack">
          <div class="card chart-card rise">
            <div class="card-hd">
              <h3>周维度精度趋势</h3>
              <div v-if="weekTrendSummary.panPrec != null" class="week-summary">
                <span class="ws-item">
                  <span class="ws-dot" style="background:#f97316"></span>
                  <span class="ws-label">本周大盘精度</span>
                  <span class="ws-val" style="color:#f97316">{{ weekTrendSummary.panPrec }}%</span>
                  <span v-if="weekTrendSummary.panChange != null" class="ws-change" :style="{ color: weekTrendSummary.panChange >= 0 ? '#22c55e' : '#ef4444' }">
                    {{ weekTrendSummary.panChange >= 0 ? '↑' : '↓' }}{{ Math.abs(weekTrendSummary.panChange) }}pp
                  </span>
                </span>
                <span v-if="weekTrendSummary.absPrec != null" class="ws-item">
                  <span class="ws-dot" style="background:#22c55e"></span>
                  <span class="ws-label">本周绝对精度</span>
                  <span class="ws-val" style="color:#22c55e">{{ weekTrendSummary.absPrec }}%</span>
                  <span v-if="weekTrendSummary.absChange != null" class="ws-change" :style="{ color: weekTrendSummary.absChange >= 0 ? '#22c55e' : '#ef4444' }">
                    {{ weekTrendSummary.absChange >= 0 ? '↑' : '↓' }}{{ Math.abs(weekTrendSummary.absChange) }}pp
                  </span>
                </span>
              </div>
            </div>
            <EChart :option="weekTrendOption" height="450px" @clickItem="onWeekTrendClick" />
          </div>
          <div class="card chart-card rise">
            <div class="card-hd"><h3>日维度精度趋势</h3></div>
            <EChart :option="dayTrendOption" height="475px" @clickItem="onDayTrendClick" />
          </div>
        </div>

        <!-- 精度排行榜（行业 / 元素类型维度） -->
        <div class="card rank-card rise">
          <div class="card-hd">
            <div class="rh-left">
              <h3>精度排行榜</h3>
            </div>
            <div class="seg-tabs rank-tabs">
              <button :class="{ on: rankDim === 'industry' }" @click="rankDim = 'industry'">按一级行业</button>
              <button :class="{ on: rankDim === 'element' }" @click="rankDim = 'element'">按元素类型</button>
            </div>
          </div>
          <div v-if="rankingLoading" class="rank-loading"><span class="spin"></span>加载排行中…</div>
          <div v-else-if="!activeRank.length" class="rank-empty">暂无数据</div>
          <ul v-else class="rank-list" @click="onRankRowClick">
            <li v-for="(it, i) in activeRank" :key="it.name" class="rank-item" :data-name="it.name">
              <span class="rank-no">{{ i + 1 }}</span>
              <span class="rank-name" :title="it.name">{{ it.name }}</span>
              <span class="rank-prec" :style="{ color: precisionColor(it.precision).fg }">{{ it.precision }}%</span>
              <span class="rank-bar-track">
                <span class="rank-fp-bar" :style="{ width: (it.total ? (15 + 85 * Math.sqrt(Math.min(it.fp / it.total, 1))) : 0) + '%' }">误杀量 {{ it.fp.toLocaleString() }}</span>
              </span>
              <span class="rank-rej-num">拒绝量 {{ (it.reject != null ? it.reject : it.total - it.fp).toLocaleString() }}</span>
              <span class="rank-go"><Icon name="chevronRight" :size="15" /></span>
            </li>
          </ul>
        </div>

        <!-- 交叉分析：行业 × 元素类型 精度热力矩阵 -->
        <div class="card cross-card rise">
          <div class="card-hd">
            <div class="rh-left">
              <h3>交叉分析 · 行业 × 元素类型 × 广告主 TOP1</h3>
            </div>
            <button class="coll-btn" @click="crossCollapsed = !crossCollapsed">{{ crossCollapsed ? '展开' : '收起' }}</button>
          </div>
          <div v-if="crossLoading" class="rank-loading"><span class="spin"></span>加载交叉分析…</div>
          <div v-else-if="!cross.rows.length" class="rank-empty">暂无数据</div>
          <div v-else v-show="!crossCollapsed" class="cross-body">
            <div class="cross-scroll">
              <table class="cross-table">
                <thead>
                  <tr>
                    <th class="cross-th-corner">行业 \ 维度</th>
                    <th v-for="m in cross.modalities" :key="m.name" class="cross-th">{{ m.name }}</th>
                    <th class="cross-th cross-th-adv">广告主 TOP{{ cross.topK }}（按误杀量）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in cross.rows" :key="row.industry">
                    <th class="cross-row-hd">{{ row.industry }}</th>
                    <td v-for="m in cross.modalities" :key="m.name"
                        class="cross-cell"
                        :class="{ 'is-clickable': crossCell(row, m.name).hasData, 'is-empty': !crossCell(row, m.name).hasData }"
                        :style="{ background: crossCell(row, m.name).hasData ? heatCell(crossCell(row, m.name).precision).bg : '' }"
                        @click="onCrossCellClick(row.industry, m.name)">
                      <template v-if="crossCell(row, m.name).hasData">
                        <span class="cross-heat-prec" :style="{ color: heatCell(crossCell(row, m.name).precision).fg }">{{ crossCell(row, m.name).precision }}%</span>
                        <span class="cross-heat-fp" :style="{ color: heatCell(crossCell(row, m.name).precision).fg }">误{{ crossCell(row, m.name).fp.toLocaleString() }}</span>
                      </template>
                      <span v-else class="cross-dash">—</span>
                    </td>
                    <td v-for="(a, ai) in crossAdvertisers(row)" :key="'adv' + ai"
                        class="cross-cell cross-cell-adv"
                        :class="{ 'is-clickable': a.hasData, 'is-empty': !a.hasData }"
                        :style="{ background: a.hasData ? heatCell(a.precision).bg : '' }"
                        :title="a.advertiser"
                        @click="onCrossAdvClick(row.industry, a)">
                      <template v-if="a.hasData">
                        <span class="cross-heat-adv" :style="{ color: heatCell(a.precision).fg }">{{ a.advertiser }}</span>
                        <span class="cross-heat-prec" :style="{ color: heatCell(a.precision).fg }">{{ a.precision }}%</span>
                        <span class="cross-heat-fp" :style="{ color: heatCell(a.precision).fg }">误{{ a.fp.toLocaleString() }}</span>
                      </template>
                      <span v-else class="cross-dash">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="cross-legend">
              <span class="cl-title">精度档：</span>
              <span class="cl-chip" style="background:#ef4444;color:#fff"><50%</span>
              <span class="cl-chip" style="background:#f97316;color:#fff">50–70%</span>
              <span class="cl-chip" style="background:#f59e0b;color:#1f2937">70–80%</span>
              <span class="cl-chip" style="background:#16a34a;color:#fff">80–90%</span>
              <span class="cl-chip" style="background:#0d9488;color:#fff">≥90%</span>
            </div>
          </div>
        </div>

        <!-- 交叉点钻取弹窗（行业 × 元素类型 低精度标签贡献） -->
        <Teleport to="body">
          <transition name="fade">
            <div v-if="crossModal.open" class="cross-modal-mask" @click="closeCrossModal">
              <div class="cross-modal" @click.stop>
                <div class="cm-hd">
                  <div class="cm-title">{{ crossModal.detail?.name || crossModal.loadingName }}</div>
                  <div class="cm-sub">低精度标签贡献（按精度升序）</div>
                  <button class="idr-close" @click="closeCrossModal"><Icon name="close" :size="18" /></button>
                </div>
                <div v-if="crossModal.loading" class="idr-loading"><span class="spin"></span>加载标签贡献…</div>
                <div v-else-if="crossModal.detail" class="cm-body">
                  <div class="cm-stats">
                    <div class="idr-stat">
                      <span class="idr-stat-ic" :style="{ color: precisionColor(crossModal.detail.precision).fg, background: precisionColor(crossModal.detail.precision).bg }"><Icon name="precision" :size="16" /></span>
                      <div><div class="idr-stat-v" :style="{ color: precisionColor(crossModal.detail.precision).fg }">{{ crossModal.detail.precision }}%</div><div class="idr-stat-l">精度</div></div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#dc2626;background:#fdeced"><Icon name="fpcount" :size="16" /></span>
                      <div><div class="idr-stat-v">{{ crossModal.detail.fp.toLocaleString() }}</div><div class="idr-stat-l">误杀量</div></div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#4f7cff;background:#eef2ff"><Icon name="sample" :size="16" /></span>
                      <div><div class="idr-stat-v">{{ crossModal.detail.total.toLocaleString() }}</div><div class="idr-stat-l">样本量</div></div>
                    </div>
                  </div>
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="tags" :size="15" />低精度审核标签</div>
                    <ul class="idr-rows">
                      <li v-for="(t, i) in crossModal.detail.byTag" :key="t.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ t.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': t.precision < 14 }" :style="{ width: Math.max(t.precision, 4) + '%', background: precisionColor(t.precision).bar }">{{ t.precision >= 14 ? '误杀 ' + t.fp.toLocaleString() : '' }}</span><span v-if="t.precision < 14" class="idr-bar-out">误杀 {{ t.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(t.precision).fg }">{{ t.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ t.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!crossModal.detail.byTag.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </Teleport>

        <!-- 行业钻取详情弹窗 -->
        <Teleport to="body">
          <transition name="fade">
            <div v-if="industryDrawer.open" class="cross-modal-mask" @click="closeIndustryDrawer">
              <div class="cross-modal cross-modal-lg" @click.stop>
                <div class="cm-hd">
                  <div class="cm-title">{{ industryDrawer.detail?.name || industryDrawer.loadingName }}</div>
                  <div class="cm-sub">AI 评测明细 · 行业精度钻取</div>
                  <button class="idr-close" @click="closeIndustryDrawer"><Icon name="close" :size="18" /></button>
                </div>

                <div v-if="industryDrawer.loading" class="idr-loading"><span class="spin"></span>加载行业详情…</div>
                <div v-else-if="industryDrawer.detail" class="idr-body">
                  <!-- 概览数字 -->
                  <div class="idr-stats">
                    <div class="idr-stat">
                      <span class="idr-stat-ic" :style="{ color: precisionColor(industryDrawer.detail.precision).fg, background: precisionColor(industryDrawer.detail.precision).bg }"><Icon name="precision" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v" :style="{ color: precisionColor(industryDrawer.detail.precision).fg }">{{ industryDrawer.detail.precision }}%</div>
                        <div class="idr-stat-l">精度</div>
                      </div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#dc2626;background:#fdeced"><Icon name="fpcount" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v">{{ industryDrawer.detail.fp.toLocaleString() }}</div>
                        <div class="idr-stat-l">误杀量</div>
                      </div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#4f7cff;background:#eef2ff"><Icon name="sample" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v">{{ industryDrawer.detail.total.toLocaleString() }}</div>
                        <div class="idr-stat-l">样本量</div>
                      </div>
                    </div>
                  </div>

                  <!-- 按元素类型 -->
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="film" :size="15" />按元素类型</div>
                    <ul class="idr-rows">
                      <li v-for="(e, i) in industryDrawer.detail.byElement" :key="e.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ e.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': e.precision < 14 }" :style="{ width: Math.max(e.precision, 4) + '%', background: precisionColor(e.precision).bar }">{{ e.precision >= 14 ? '误杀 ' + e.fp.toLocaleString() : '' }}</span><span v-if="e.precision < 14" class="idr-bar-out">误杀 {{ e.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(e.precision).fg }">{{ e.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ e.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!industryDrawer.detail.byElement.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>

                  <!-- 按审核标签 -->
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="tags" :size="15" />按审核标签<span class="idr-sec-tip">审核标签ID · 审核标签名（按精度升序）</span></div>
                    <ul class="idr-rows">
                      <li v-for="(t, i) in industryDrawer.detail.byTag" :key="t.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ t.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': t.precision < 14 }" :style="{ width: Math.max(t.precision, 4) + '%', background: precisionColor(t.precision).bar }">{{ t.precision >= 14 ? '误杀 ' + t.fp.toLocaleString() : '' }}</span><span v-if="t.precision < 14" class="idr-bar-out">误杀 {{ t.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(t.precision).fg }">{{ t.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ t.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!industryDrawer.detail.byTag.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>

                  <!-- 按二级行业 -->
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="tagcount" :size="15" />按二级行业</div>
                    <ul class="idr-rows">
                      <li v-for="(s, i) in industryDrawer.detail.bySecond" :key="s.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ s.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': s.precision < 14 }" :style="{ width: Math.max(s.precision, 4) + '%', background: precisionColor(s.precision).bar }">{{ s.precision >= 14 ? '误杀 ' + s.fp.toLocaleString() : '' }}</span><span v-if="s.precision < 14" class="idr-bar-out">误杀 {{ s.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(s.precision).fg }">{{ s.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ s.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!industryDrawer.detail.bySecond.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </Teleport>

        <!-- 元素类型钻取详情弹窗 -->
        <Teleport to="body">
          <transition name="fade">
            <div v-if="elementDrawer.open" class="cross-modal-mask" @click="closeElementDrawer">
              <div class="cross-modal cross-modal-lg" @click.stop>
                <div class="cm-hd">
                  <div class="cm-title">{{ elementDrawer.detail?.name || elementDrawer.loadingName }} · 元素类型</div>
                  <div class="cm-sub">AI 评测明细 · 元素类型精度钻取</div>
                  <button class="idr-close" @click="closeElementDrawer"><Icon name="close" :size="18" /></button>
                </div>

                <div v-if="elementDrawer.loading" class="idr-loading"><span class="spin"></span>加载元素类型详情…</div>
                <div v-else-if="elementDrawer.detail" class="idr-body">
                  <!-- 概览数字 -->
                  <div class="idr-stats">
                    <div class="idr-stat">
                      <span class="idr-stat-ic" :style="{ color: precisionColor(elementDrawer.detail.precision).fg, background: precisionColor(elementDrawer.detail.precision).bg }"><Icon name="precision" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v" :style="{ color: precisionColor(elementDrawer.detail.precision).fg }">{{ elementDrawer.detail.precision }}%</div>
                        <div class="idr-stat-l">精度</div>
                      </div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#dc2626;background:#fdeced"><Icon name="fpcount" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v">{{ elementDrawer.detail.fp.toLocaleString() }}</div>
                        <div class="idr-stat-l">误杀量</div>
                      </div>
                    </div>
                    <div class="idr-stat">
                      <span class="idr-stat-ic" style="color:#4f7cff;background:#eef2ff"><Icon name="sample" :size="16" /></span>
                      <div>
                        <div class="idr-stat-v">{{ elementDrawer.detail.total.toLocaleString() }}</div>
                        <div class="idr-stat-l">样本量</div>
                      </div>
                    </div>
                  </div>

                  <!-- 按一级行业 -->
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="tagcount" :size="15" />按一级行业</div>
                    <ul class="idr-rows">
                      <li v-for="(s, i) in elementDrawer.detail.byIndustry" :key="s.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ s.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': s.precision < 14 }" :style="{ width: Math.max(s.precision, 4) + '%', background: precisionColor(s.precision).bar }">{{ s.precision >= 14 ? '误杀 ' + s.fp.toLocaleString() : '' }}</span><span v-if="s.precision < 14" class="idr-bar-out">误杀 {{ s.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(s.precision).fg }">{{ s.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ s.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!elementDrawer.detail.byIndustry.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>

                  <!-- 按审核标签 -->
                  <div class="idr-sec">
                    <div class="idr-sec-hd"><Icon name="tags" :size="15" />按审核标签<span class="idr-sec-tip">审核标签ID · 审核标签名（按精度升序）</span></div>
                    <ul class="idr-rows">
                      <li v-for="(t, i) in elementDrawer.detail.byTag" :key="t.name" class="idr-row">
                        <span class="idr-dot">{{ i + 1 }}</span>
                        <span class="idr-row-name">{{ t.name }}</span>
                        <span class="idr-bar-track"><span class="idr-bar" :class="{ 'is-low': t.precision < 14 }" :style="{ width: Math.max(t.precision, 4) + '%', background: precisionColor(t.precision).bar }">{{ t.precision >= 14 ? '误杀 ' + t.fp.toLocaleString() : '' }}</span><span v-if="t.precision < 14" class="idr-bar-out">误杀 {{ t.fp.toLocaleString() }}</span></span>
                        <span class="idr-row-prec" :style="{ color: precisionColor(t.precision).fg }">{{ t.precision }}%</span>
                        <span class="idr-row-meta">样本 {{ t.total.toLocaleString() }}</span>
                      </li>
                      <li v-if="!elementDrawer.detail.byTag.length" class="idr-empty">暂无数据</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </Teleport>
      </template>

      <!-- 聚类簇（整页，标签维度已迁移至「误杀Case分析 → 标签跟踪」） -->
      <ClusterView v-else :date-range="dateRange()" />
    </template>
  </div>
</template>

<style scoped>
.data-status-bar { display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; background: #fff; border: 1px solid var(--border-strong); border-radius: 14px; margin-bottom: 18px; box-shadow: 0 2px 8px rgba(20,30,60,.04); }
.dsb-left { display: flex; align-items: center; gap: 14px; }
.dsb-ic { width: 40px; height: 40px; border-radius: 11px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; flex-shrink: 0; }
.dsb-info { display: flex; flex-direction: column; line-height: 1.4; }
.dsb-info strong { font-size: 15px; font-weight: 600; color: var(--text-1); }
.dsb-info em { font-size: 12px; font-style: normal; color: var(--text-3); }

.kpi-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; margin-bottom: 18px; }
.top-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.top-date { display: inline-flex; align-items: center; padding: 5px 8px; background: #fff; border: 1px solid var(--border-strong); border-radius: 11px; box-shadow: 0 2px 8px rgba(20,30,60,.04); }
.top-date :deep(.drf) { gap: 8px; }
.top-date :deep(.drf-btn) { padding: 4px 10px; font-size: 11px; }
.top-date :deep(.drf-custom input[type="date"]) { height: 26px; font-size: 12px; }
.trend-stack { display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px; }
.week-collapse .collapsible-hd { cursor: pointer; display: flex; align-items: center; justify-content: space-between; user-select: none; }
.week-collapse .collapse-icon { font-size: 16px; color: #8b94a8; transition: transform 0.25s ease; }
.week-summary { display: flex; gap: 20px; margin-left: auto; margin-right: 16px; }
.ws-item { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ws-label { color: #8b94a8; }
.ws-val { font-size: 16px; font-weight: 800; }
.ws-change { font-size: 11px; font-weight: 600; }
.week-collapse .collapse-icon.rotated { transform: rotate(-90deg); }
.week-collapse.collapsed { box-shadow: 0 1px 3px rgba(20,30,56,0.05); }
.seg-tabs { display: flex; gap: 4px; margin-bottom: 18px; background: #f0f2f6; padding: 4px; border-radius: 12px; width: fit-content; }
.seg-tabs button { display: inline-flex; align-items: center; gap: 7px; padding: 12px 28px; border: none; border-radius: 11px; font-size: 17px; font-weight: 700; color: var(--text-2); background: transparent; cursor: pointer; transition: all .18s; }
.seg-tabs button:hover { color: var(--text-1); }
.seg-tabs button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); }
.chart-card { padding: 22px 24px; margin-bottom: 18px; }
.card-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.card-hd h3 { font-size: 15px; font-weight: 700; }
.init-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; font-size: 14px; color: var(--text-3); }
.init-loading .spin { width: 18px; height: 18px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
@keyframes lspin { to { transform: rotate(360deg); } }
.rank-card { padding: 22px 24px 18px; margin-bottom: 36px; }
.cross-card { padding: 22px 24px 18px; }
.rh-left { display: flex; flex-direction: column; gap: 3px; }
.rank-hint { font-size: 12px; color: var(--text-3); }
.rank-tabs { margin-bottom: 0; }
.card-hd { align-items: flex-start; }
.rank-loading { display: flex; align-items: center; gap: 10px; padding: 28px 0; font-size: 14px; color: var(--text-3); }
.rank-loading .spin { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
.rank-empty { font-size: 13px; color: var(--text-3); padding: 22px 0; text-align: center; }
.rank-head { display: grid; grid-template-columns: 22px 110px 66px minmax(120px, 1fr) 96px 20px; align-items: center; gap: 12px; padding: 0 12px 4px; font-size: 11.5px; color: var(--text-3); font-weight: 600; }
.rank-head span:nth-child(3), .rank-head span:nth-child(5) { text-align: right; }
.rank-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rank-item { display: grid; grid-template-columns: 22px 110px 66px minmax(120px, 1fr) 96px 20px; align-items: center; gap: 12px; padding: 6px 12px; border-radius: 10px; background: var(--bg-soft); transition: background .15s ease, transform .15s ease; }
.rank-item:hover { background: #eef2f9; transform: translateX(2px); }
.rank-no { font-size: 12px; font-weight: 800; color: var(--text-3); text-align: center; width: 22px; height: 22px; line-height: 22px; border-radius: 7px; background: #e8ecf3; }
.rank-name { font-size: 13.5px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-prec { font-size: 15px; font-weight: 800; text-align: right; font-variant-numeric: tabular-nums; }
.rank-bar-track { position: relative; display: block; height: 18px; border-radius: 6px; background: #f1f4f8; overflow: hidden; }
.rank-fp-bar { display: flex; align-items: center; height: 100%; min-width: 52px; border-radius: 6px; padding: 0 8px; font-size: 11px; color: #c2185b; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; background: #ffcacb; border-right: 2px solid #ffb3c1; transition: width .5s cubic-bezier(.16,1,.3,1); box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; }
.rank-rej-num { font-size: 12.5px; color: #6b7280; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.rank-go { color: var(--text-3); display: inline-flex; transition: transform .15s ease, color .15s ease; }
.rank-item:hover .rank-go { color: var(--brand); transform: translateX(2px); }
@media (max-width: 900px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
  .rank-item { grid-template-columns: 20px 66px 50px 1fr 66px 16px; gap: 7px; }
  .rank-fp-num, .rank-rej-num { font-size: 11px; }
}

/* ===== 行业钻取详情抽屉 ===== */
.drawer-mask { position: fixed; inset: 0; z-index: 1000; background: rgba(20,28,46,.42); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; }
.industry-drawer { width: 460px; max-width: 88vw; height: 100%; background: var(--bg-page); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: drawerIn .26s cubic-bezier(.16,1,.3,1); }
@keyframes drawerIn { from { transform: translateX(30px); opacity: .4; } to { transform: none; opacity: 1; } }
.drawer-leave-active .industry-drawer { animation: drawerOut .2s ease forwards; }
@keyframes drawerOut { to { transform: translateX(30px); opacity: 0; } }
.idr-hd { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: #fff; border-bottom: 1px solid var(--border); }
.idr-hd-l { display: flex; align-items: center; gap: 12px; }
.idr-ic { width: 38px; height: 38px; border-radius: 11px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; }
.idr-title { font-size: 17px; font-weight: 700; color: var(--text-1); }
.idr-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.idr-close { width: 34px; height: 34px; border-radius: 9px; color: var(--text-2); display: grid; place-items: center; transition: all .15s; }
.idr-close:hover { background: var(--bg-soft); color: var(--text-1); }
.idr-loading { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 60px 0; color: var(--text-3); }
.idr-loading .spin { width: 18px; height: 18px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
.idr-body { flex: 1; overflow-y: auto; padding: 16px 18px 22px; }
.idr-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; margin-bottom: 18px; }
.idr-stat { display: flex; align-items: center; gap: 9px; padding: 11px 12px; background: #fff; border: 1px solid var(--border); border-radius: var(--r-md); }
.idr-stat-ic { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0; }
.idr-stat-v { font-size: 17px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; line-height: 1.2; }
.idr-stat-l { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.idr-sec { margin-bottom: 16px; }
.idr-sec-hd { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; color: var(--text-1); margin-bottom: 10px; }
.idr-sec-hd :deep(.icon) { color: var(--brand); }
.idr-sec-tip { font-size: 11px; font-weight: 500; color: var(--text-3); background: var(--bg-soft); padding: 2px 7px; border-radius: 6px; margin-left: 4px; }
.idr-tag-id { display: inline-block; margin-left: 6px; font-size: 11px; font-weight: 600; color: var(--brand); background: var(--brand-soft); padding: 1px 6px; border-radius: 5px; }
.idr-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.idr-row { display: grid; grid-template-columns: 22px 96px 1fr 46px auto; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 9px; background: #fff; border: 1px solid var(--border); }
.idr-row:hover { border-color: var(--brand); }
.idr-dot { width: 22px; height: 22px; line-height: 22px; text-align: center; border-radius: 7px; background: #e8ecf3; color: var(--text-3); font-size: 12px; font-weight: 700; }
.idr-row-name { font-size: 13px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idr-bar-track { position: relative; display: block; height: 24px; border-radius: 7px; background: #eef1f6; overflow: hidden; }
.idr-bar { display: flex; align-items: center; height: 100%; border-radius: 7px; padding: 0 10px; font-size: 11.5px; color: #fff; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; transition: width .5s cubic-bezier(.16,1,.3,1); box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; }
.idr-bar.is-low { background: #fca5a5 !important; }
.idr-bar-out { position: absolute; top: 0; left: 0; display: flex; align-items: center; height: 24px; padding-left: 10px; font-size: 11.5px; color: var(--red); font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
.idr-row-prec { font-size: 14px; font-weight: 800; text-align: right; font-variant-numeric: tabular-nums; }
.idr-row-meta { font-size: 11px; color: var(--text-3); text-align: right; white-space: nowrap; }
.idr-empty { font-size: 13px; color: var(--text-3); padding: 16px 0; text-align: center; }

/* 交叉分析：行业 × 元素类型 精度热力矩阵 */
.cross-body { padding: 8px 0 0; }
.cross-scroll { overflow-x: auto; }
.cross-table { border-collapse: separate; border-spacing: 0; width: max-content; }
.cross-th-corner, .cross-th, .cross-row-hd { font-size: 12px; font-weight: 700; color: var(--text-1); background: var(--bg-soft); text-align: center; padding: 6px 10px; position: sticky; top: 0; }
.cross-th-adv { background: #f0f4ff; color: var(--brand); border-top-right-radius: 10px; }
.cross-th-corner { left: 0; z-index: 2; text-align: left; border-top-left-radius: 10px; }
.cross-th { border-top: 1px solid var(--border); }
.cross-th:last-child { border-top-right-radius: 10px; }
.cross-cell-adv { background: #fafbff; width: 184px; }
.cross-adv-name { display: block; font-size: 9.5px; font-weight: 600; color: var(--text-1); max-width: 92px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px; }
.cross-row-hd { left: 0; z-index: 1; text-align: left; border-left: 1px solid var(--border); white-space: nowrap; padding: 6px 6px 6px 14px; }
.cross-row-hd:last-of-type { border-bottom-left-radius: 10px; }
.cross-cell { border: 3px solid var(--bg-page); background-clip: padding-box; padding: 3px 8px; text-align: center; vertical-align: middle; border-radius: 9px; min-width: 92px; }
.cross-cell.is-clickable { cursor: pointer; transition: transform .15s, box-shadow .15s; }
.cross-cell.is-clickable:hover { transform: scale(1.04); box-shadow: 0 6px 16px rgba(15,23,42,.22); position: relative; z-index: 3; }
.cross-cell.is-empty { background: var(--bg-soft); }
.cross-heat-prec { display: block; font-size: 12px; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; }
.cross-heat-fp { display: block; margin-top: 1px; font-size: 8px; font-weight: 600; opacity: .92; font-variant-numeric: tabular-nums; }
.cross-heat-adv { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 9.5px; font-weight: 700; line-height: 1.25; word-break: break-all; margin-bottom: 2px; }
.cross-dash { color: var(--text-3); font-size: 14px; font-weight: 600; }
.cross-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.cl-title { font-size: 11px; color: var(--text-3); }
.cl-chip { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.cross-modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 1200; padding: 24px; }
.cross-modal { width: min(520px, 100%); max-height: 84vh; overflow-y: auto; background: #fff; border-radius: 16px; box-shadow: 0 24px 70px rgba(15,23,42,.28); }
.cross-modal-lg { width: min(580px, 100%); }
.cm-hd { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.cm-title { font-size: 15px; font-weight: 800; color: var(--text-1); }
.cm-sub { font-size: 11.5px; color: var(--text-3); }
.cm-hd .idr-close { position: absolute; top: 12px; right: 12px; }
.cm-body { padding: 14px 18px; }
.cm-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.coll-btn { font-size: 12.5px; font-weight: 600; color: var(--brand); background: var(--brand-soft); border: none; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.coll-btn:hover { background: var(--brand); color: #fff; }
</style>
