<script setup>
import { ref, computed, reactive, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useTicketFlowStore } from '../../stores/ticketFlow'
import { useAuthStore } from '../../stores/auth'
import { useAnalysisStore } from '../../stores/analysis'
import { tagStatus } from '../../data/mock'
import { tagApi, badcaseApi, materialApi } from '../../api'
import { usePersistedRef, useRemotePersistedRef } from '../../utils/usePersistedRef'
import { previewSrc, openOriginal, onMediaError, isBadShardUrl, isMediaUrl, retryOriginalSrc, rawHttpsUrlPlain, mediaProxyFallback } from '../../utils/mediaPreview'
import Icon from '../../components/Icon.vue'
import EChart from '../../components/EChart.vue'
import Pager from '../../components/Pager.vue'
import EmptyState from '../../components/EmptyState.vue'
import TragSearchModal from '../../components/TragSearchModal.vue'
import MaterialAnnotations from '../../components/MaterialAnnotations.vue'
import VideoPlayer from '../../components/VideoPlayer.vue'
import { generateClusterFeature } from '../classify/scriptClassify'

/* ============ 媒体守卫（与 Tickets/Sediment 一致，避免把名称当相对路径） ============ */
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  return /^https?:\/\//i.test(url)
}
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
function isVideoByUrl(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  if (VIDEO_EXT.includes(ext)) return true
  if (/video/i.test(clean)) return true
  return false
}
// 是否为可直接内嵌的媒体（img/vid）；否则应作为「打开原链接」文本展示
// 改动六：坏分片（.f0.mp4 等回源垃圾字节流）不内嵌，直接展示「↗ 原素材」逃生链接
function isEmbeddableMedia(url) {
  return isValidHttpUrl(url) && isMediaUrl(url) && !isBadShardUrl(url)
}
// 与素材分类一致的 CDN 域名白名单：无扩展名也尝试加载（h5.gdt.qq.com/xjviewer/nemo/xxx 等）
const CDN_HOST_WHITELIST = ['gtimg.cn', 'gtimg.com', 'qpic.cn', 'qq.com', 'myqcloud.com', 'tencent-cloud.com']
function isCdnHost(url) {
  try {
    const { hostname } = new URL(url)
    return CDN_HOST_WHITELIST.some(h => hostname.endsWith(h))
  } catch { return false }
}
// 非文本素材：mediaUrl 存在但是非媒体文件（HTML 落地页等）→ 回退为链接展示
function isLinkOnly(s) {
  if (isCardText(s)) return false
  if (!s.mediaUrl) return false
  if (!isValidHttpUrl(s.mediaUrl)) return true
  if (isCdnHost(s.mediaUrl)) return false
  return !isMediaUrl(s.mediaUrl)
}


// 预览直连 CDN（http→https 自动升级），原始直链保留在 data-raw-url，
// 加载失败时由 onMediaError 展示「↗ 原素材」逃生通道。不走后端代理。

const route = useRoute()
const router = useRouter()
const toast = useToastStore()
const ticketFlow = useTicketFlowStore()
const auth = useAuthStore()
const analysisStore = useAnalysisStore()

// 标签基础信息（来自 tagApi.list 匹配当前路由 id）+ 该标签素材明细（tagApi.samples）
const loading = ref(false)
const tag = ref({ id: route.params.id, name: '', precision: 0, total: 0, fp: 0, rank: 0 })
const samples = ref([])

// ===== 图三独立时间筛选：单独控制审核判定统计 + 明细列表（默认近7天）=====
const verifyRange = ref('7')          // 时间粒度：7/14/30
const verifyCustomRange = ref(false)  // 是否启用自定义时间区间
const verifyStart = ref('')
const verifyEnd = ref('')
const detailSamples = ref([])         // 明细列表独立数据（verifyRange 控制）
const detailLoading = ref(false)

// ===== 概况 KPI 近7天 vs 前7天 变化（图四式 KPI 卡）=====
const dataMaxDate = ref('')           // 数据最新业务日期（用于计算近7天窗口）
const kpiChange = reactive({ precisionChange: null, fpChange: null, sampleChange: null, changePeriod: '' })
// 近7天概况主数值（图二口径：三卡显示近7天数据，而非标签全量聚合值）
const kpiRecent = reactive({ precision: 0, total: 0, fp: 0, ready: false })

const verifyRangeOptions = [
  { v: '7', l: '7天' },
  { v: '14', l: '14天' },
  { v: '30', l: '30天' },
  { v: 'custom', l: '自定义' },
]

// 时间粒度切换：选「自定义」时启用日期区间
function setVerifyRange(r) {
  if (r === 'custom') {
    verifyCustomRange.value = true
    const d = dataMaxDate.value ? new Date(dataMaxDate.value + 'T00:00:00') : new Date()
    const p = n => String(n).padStart(2, '0')
    if (!verifyEnd.value) verifyEnd.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    if (!verifyStart.value) {
      const s = new Date(d.getTime() - 6 * 86400000)
      verifyStart.value = `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`
    }
    return
  }
  verifyCustomRange.value = false
  verifyRange.value = r
}

function verifyDateRange() {
  if (verifyCustomRange.value) return { start: verifyStart.value || '', end: verifyEnd.value || '' }
  const days = Number(verifyRange.value) || 7
  // 时间锚点优先取「数据最新业务日期」，避免数据截止日早于今天（如数据到 08/15、今天 08/23）时窗口落空导致明细为空
  const end = dataMaxDate.value ? new Date(dataMaxDate.value + 'T00:00:00') : new Date()
  const start = new Date(end.getTime())
  start.setDate(end.getDate() - (days - 1))
  const p = n => String(n).padStart(2, '0')
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return { start: fmt(start), end: fmt(end) }
}

async function loadDetailSamples() {
  if (!tag.value.id) return
  detailLoading.value = true
  try {
    const list = await tagApi.samples(tag.value.id, { ...verifyDateRange(), status: 'all' })
    detailSamples.value = Array.isArray(list) ? list : []
    validateDetailFilters()
  } catch {
    detailSamples.value = []
  } finally {
    detailLoading.value = false
    loadAnnotatedIds()
  }
}

// 日期偏移：s 形如 'YYYY-MM-DD'，n 为天数偏移（可为负）
function shiftDate(s, n) {
  const dt = new Date(String(s).slice(0, 10) + 'T00:00:00')
  if (isNaN(dt.getTime())) return ''
  dt.setDate(dt.getDate() + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// 概况 KPI 近7天 vs 前7天 变化（精度=百分点 pp，样本/FP=相对比例 %）
async function loadKpiChange() {
  const maxD = dataMaxDate.value || ''
  if (!maxD || !tag.value.id) {
    kpiChange.precisionChange = null
    kpiChange.fpChange = null
    kpiChange.sampleChange = null
    kpiChange.changePeriod = ''
    return
  }
  const lastStart = shiftDate(maxD, -6)
  const prevEnd = shiftDate(maxD, -7)
  const prevStart = shiftDate(maxD, -13)
  try {
    // 按周（ds）聚合：标签在精度表有完整 15 周数据
    // 近7天 = 最新一周；前7天 = 上一周
    const [cur, prev] = await Promise.all([
      tagApi.trend(tag.value.id, { groupBy: 'ds', start: lastStart, end: maxD }),
      tagApi.trend(tag.value.id, { groupBy: 'ds', start: prevStart, end: prevEnd }),
    ])
    const sum = (arr, f) => (Array.isArray(arr) ? arr.reduce((s, r) => s + (Number(r[f]) || 0), 0) : 0)
    const curTotal = sum(cur, 'total')
    const prevTotal = sum(prev, 'total')
    const curFp = sum(cur, 'fp')
    const prevFp = sum(prev, 'fp')
    const curTp = curTotal - curFp
    const prevTp = prevTotal - prevFp
    const curPrec = curTotal > 0 ? Number((curTp / curTotal * 100).toFixed(1)) : 0
    const prevPrec = prevTotal > 0 ? Number((prevTp / prevTotal * 100).toFixed(1)) : 0
    // 保存近7天概况主数值（三卡显示近7天数据，而非标签全量聚合值）
    kpiRecent.precision = curPrec
    kpiRecent.total = curTotal
    kpiRecent.fp = curFp
    kpiRecent.ready = true
    kpiChange.precisionChange = { value: Number((curPrec - prevPrec).toFixed(1)), type: 'absolute' }
    kpiChange.fpChange = prevFp > 0 ? { value: Number(((curFp - prevFp) / prevFp * 100).toFixed(0)), type: 'relative' } : null
    kpiChange.sampleChange = prevTotal > 0 ? { value: Number(((curTotal - prevTotal) / prevTotal * 100).toFixed(0)), type: 'relative' } : null
    kpiChange.changePeriod = `${lastStart.slice(5).replace('-', '/')}-${maxD.slice(5).replace('-', '/')}`
  } catch {
    kpiChange.precisionChange = null
    kpiChange.fpChange = null
    kpiChange.sampleChange = null
    kpiChange.changePeriod = ''
  }
}

// 标签详情时间筛选项（真实数据按 arrive_time 范围聚合）
// 使用独立持久化键，避免与 ClassifyView 的 'classify:tagDate' 共享导致过期时间窗口（跨设备延续）
const tagDate = useRemotePersistedRef('tagDetail:tagDate', { preset: '', start: '', end: '' })
function dateRange() {
  const g = tagDate.value
  if (g.start || g.end) return { start: g.start, end: g.end }
  return {}
}

// 是否已用数据实际周期初始化过时间窗口
let dateInited = false
// 加载守卫：防止并发 loadData
let loadingGuard = false
// 初始化标志：首次设置 tagDate 时阻止 watch 重复触发 loadData，避免丢弃数据后重复加载
let initializing = false

async function loadData() {
  if (loadingGuard) return
  loadingGuard = true
  loading.value = true
  try {
    let range = dateRange()

    // 首次加载：并行发起 overview（获取默认时间窗口）+ detail + samples，
    // overview 不阻塞 detail+samples 的首屏渲染，后者不传时间范围先全量返回
    if (!dateInited) {
      dateInited = true
      // 无时间范围先全量加载（range 为空则 samples 不走时间过滤）
      const [tagInfo, list, probe] = await Promise.all([
        tagApi.detail(route.params.id),
        tagApi.samples(route.params.id, { ...{}, status: 'all' }),
        tagApi.overview({}),
      ])
      // overview 返回后静默设置默认时间窗口，不触发重新加载
      if (probe && probe.dataMinDate && probe.dataMaxDate) {
        dataMaxDate.value = probe.dataMaxDate
        // 固定近7天口径：时间窗口设为「数据最新日期往前 7 天 ~ 数据最新日期」
        tagDate.value = { preset: '', start: shiftDate(probe.dataMaxDate, -6), end: probe.dataMaxDate }
        // 每日趋势改用「数据最新日期」为基准的窗口重载（onMounted 首次调用时 dataMaxDate 尚未就绪，
        // 只能走 days 相对今天，会少天数；此处补一次，让趋势图与表格显示完整 7 天）
        loadDailyTrend()
        loadInsight()
      }

      if (tagInfo && tagInfo.id) {
        tag.value = tagInfo
      } else {
        tag.value = { ...tag.value, precision: 0, total: 0, fp: 0, sampleTotal: 0, rank: 0, tp: 0 }
      }
      samples.value = Array.isArray(list) ? list : []
      if (tagInfo?.id) {
        analysisStore.setData({ samples: list || [], tags: [{ ...tagInfo }], kpi: { fileName: '' }, fileName: '' })
      }
      loadDetailSamples()
      loadKpiChange()
    } else {
      // 非首次（时间窗口切换）：按实际时间范围加载
      const [tagInfo, list] = await Promise.all([
        tagApi.detail(route.params.id),
        tagApi.samples(route.params.id, { ...range, status: 'all' }),
      ])
      if (tagInfo && tagInfo.id) {
        tag.value = tagInfo
      } else {
        tag.value = { ...tag.value, precision: 0, total: 0, fp: 0, sampleTotal: 0, rank: 0, tp: 0 }
      }
      samples.value = Array.isArray(list) ? list : []
      if (tagInfo?.id) {
        analysisStore.setData({ samples: list || [], tags: [{ ...tagInfo }], kpi: { fileName: '' }, fileName: '' })
      }
    }
  } catch (e) {
    initializing = false
    toast.warn(e.message || '加载标签详情失败')
    samples.value = []
  } finally {
    loading.value = false
    loadingGuard = false
  }
}

onMounted(() => { loadData() })
// keep-alive 缓存下，从一个标签切换到另一个标签时组件实例复用、onMounted 不再触发，
// 需监听路由 id 变化以重新拉取数据并重置时间窗口
watch(() => route.params.id, () => {
  dateInited = false
  initializing = false
  page.value = 1
  // 切换标签时重置明细筛选（审核人/判定/只看标注/关注等），
  // 避免上一个标签的筛选条件持久化残留，导致新标签明细被过滤为空（元素无数据）
  resetFilters()
  watchFilter.value = ''
  loadData()
})
watch(tagDate, () => { if (initializing) return; page.value = 1; loadData() }, { deep: true })
watch([verifyRange, verifyCustomRange, verifyStart, verifyEnd], () => { loadDetailSamples() })

// 概况指标直接使用真实标签聚合值
// curTotal = sampleTotal（精度聚合表 real_data_tag_precision 的 FP+TP），即该标签下整体样本数
const curPrecision = computed(() => kpiRecent.ready ? kpiRecent.precision : (Number(tag.value.precision) || 0))
const curTotal = computed(() => kpiRecent.ready ? kpiRecent.total : (Number(tag.value.sampleTotal) || 0))
const curFp = computed(() => kpiRecent.ready ? kpiRecent.fp : (Number(tag.value.fp) || 0))
const curStatus = computed(() => tagStatus(curPrecision.value))

// 环形仪表
const ringDeg = computed(() => (curPrecision.value / 100) * 360)
const ringColor = computed(() => curStatus.value.color)

// ===== 概况 KPI 变化展示辅助 =====
function chgText(chg) {
  if (!chg || chg.value == null) return ''
  const v = Math.abs(chg.value)
  return chg.type === 'relative' ? v + '%' : v + 'pp'
}
function chgArrow(chg) {
  if (!chg || chg.value == null) return '—'
  return chg.value > 0 ? '↑' : (chg.value < 0 ? '↓' : '—')
}
function chgCls(chg) {
  if (!chg || chg.value == null) return ''
  return chg.value > 0 ? 'up' : (chg.value < 0 ? 'down' : 'flat')
}

// ===== 每日精度趋势图（KPI 卡片下方新增）=====
const dailyTrend = ref([])           // [{ date, precision, tp, fp, total }]
const dailyTrendLoading = ref(false)
const dailyIndustryL1 = ref('')      // 一级行业筛选（真实数据，作用于 trend 聚合）
const dailyIndustryL2 = ref('')      // 二级行业筛选（真实数据，作用于 trend 聚合）
const dailyElementType = ref('')     // 元素类型筛选（真实数据，作用于 trend 聚合）
const dailyRange = ref('7')          // 时间粒度：7/14/30，默认近7天
const dailyCustomRange = ref(false)  // 是否启用自定义时间区间
const dailyStart = ref('')
const dailyEnd = ref('')
const dailyEvents = ref([])          // 模型发布/规则变更事件（暂无数据，先标灰图例）

// 加载每日精度趋势数据
async function loadDailyTrend() {
  if (!route.params.id) return
  dailyTrendLoading.value = true
  try {
    const q = {
      // 周维度：按 ds 聚合（精度表含完整 15 周），避免走样本表日聚合导致只出少量点
      groupBy: 'ds',
      industry: dailyIndustryL1.value || '',
      industryL2: dailyIndustryL2.value || '',
      elementType: dailyElementType.value || '',
    }
    if (dailyCustomRange.value) {
      q.start = dailyStart.value || ''
      q.end = dailyEnd.value || ''
    } else if (dataMaxDate.value) {
      // 用「数据最新日期」往前 N 天作为窗口，避免以「今天」为基准超出数据范围，
      // 导致趋势图只显示窗口内个别有数据的天数（如数据截至 08/15，今天 08/19，默认7天只能出 3 个点）
      q.start = shiftDate(dataMaxDate.value, -(Number(dailyRange.value) - 1))
      q.end = dataMaxDate.value
    } else {
      q.days = dailyRange.value
    }
    const points = await tagApi.trend(route.params.id, q)
    dailyTrend.value = Array.isArray(points) ? points : []
  } catch {
    dailyTrend.value = []
  } finally {
    dailyTrendLoading.value = false
  }
}

// 时间粒度切换：选「自定义」时启用日期区间
function setDailyRange(r) {
  if (r === 'custom') {
    dailyCustomRange.value = true
    // 默认回填近7天区间（以数据最新业务日期为终点锚点，避免窗口落空）
    const d = dataMaxDate.value ? new Date(dataMaxDate.value + 'T00:00:00') : new Date()
    const p = n => String(n).padStart(2, '0')
    if (!dailyEnd.value) dailyEnd.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    if (!dailyStart.value) {
      const s = new Date(d.getTime() - 6 * 86400000)
      dailyStart.value = `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`
    }
    return
  }
  dailyCustomRange.value = false
  dailyRange.value = r
}

// 趋势筛选联动：时间/行业/元素变化时重载
watch([dailyRange, dailyIndustryL1, dailyIndustryL2, dailyElementType, dailyCustomRange], () => { if (!initializing) loadDailyTrend() })
function applyDailyCustomRange() { if (dailyStart.value && dailyEnd.value) loadDailyTrend() }

// 时间粒度选项
const dailyRangeOptions = [
  { v: '7', l: '7天' },
  { v: '14', l: '14天' },
  { v: '30', l: '30天' },
  { v: 'custom', l: '自定义' },
]
// 行业下拉选项（每日趋势图，基于全局样本 samples；去掉「全部」占位）
const dailyIndustryOptions = computed(() => {
  const set = new Set(samples.value.map(s => (s.firstLevelIndustryName || s.industryL1 || '').trim()).filter(Boolean))
  return Array.from(set).sort()
})
// 二级行业下拉选项（联动一级行业：选中一级行业时仅列出该一级行业下的二级行业）
const dailyIndustryL2Options = computed(() => {
  const l1 = dailyIndustryL1.value
  const set = new Set(samples.value
    .filter(s => !l1 || (s.firstLevelIndustryName || s.industryL1 || '').trim() === l1)
    .map(s => (s.secondLevelIndustryName || s.industryL2 || '').trim())
    .filter(Boolean))
  return Array.from(set).sort()
})

// 负载趋势数据（mounted 后加载，时间窗口变化时联动重载）
onMounted(() => { loadDailyTrend(); loadInsight(); loadClusterFeatures() })
watch(() => route.params.id, () => { loadDailyTrend(); loadInsight(); loadClusterFeatures() })

// 类型筛选（跨设备延续）
const typeFilter = useRemotePersistedRef('tagDetail:typeFilter', '全部')
const types = computed(() => {
  const set = new Set(detailSamples.value.map(s => s.elementTypeName))
  return ['全部', ...Array.from(set)]
})
function typeCount(t) { return t === '全部' ? detailSamples.value.length : detailSamples.value.filter(s => s.elementTypeName === t).length }

// 人审标签筛选（跨设备延续）
const humanTagFilter = useRemotePersistedRef('tagDetail:humanTagFilter', '全部')
const humanTagTypes = computed(() => {
  const set = new Set()
  for (const s of detailSamples.value) {
    const raw = s.humanTag || s.aiEvaluatePolicyIds || ''
    const cleaned = String(raw).replace(/[\[\]\s]/g, '')
    if (!cleaned) {
      set.add('通过')
    } else {
      const tags = cleaned.split(/[,，]/).filter(Boolean)
      for (const t of tags) set.add(t)
    }
  }
  return ['全部', ...Array.from(set)]
})

// ===== 图三按钮组：全选 / 只看标注 =====
const onlyAnnotated = useRemotePersistedRef('tagDetail:onlyAnnotated', false) // 只看有标注的样本
const annotatedIds = ref(new Set()) // 有标注的样本 ID 集合（批量查询维护）

// 批量查询当前标签下所有样本的标注，构建"有标注"集合（供只看标注过滤）
async function loadAnnotatedIds() {
  if (!tag.value.id || !detailSamples.value.length) return
  try {
    const ids = detailSamples.value.map(s => s.id)
    const rows = await materialApi.annotations(tag.value.id, ids)
    annotatedIds.value = new Set((Array.isArray(rows) ? rows : []).map(r => r.sampleId))
  } catch {
    annotatedIds.value = new Set()
  }
}

// 一级行业筛选（跨设备延续）：从当前样本提取去重（与素材分类口径一致）
const industryL1Filter = useRemotePersistedRef('tagDetail:industryL1Filter', '全部')
const industryL1Options = computed(() => {
  const set = new Set(detailSamples.value.map(s => (s.firstLevelIndustryName || s.industryL1 || '').trim()).filter(Boolean))
  return ['全部', ...Array.from(set).sort()]
})
// 二级行业筛选：选中一级行业时仅列出该一级行业下的二级行业
const industryL2Filter = useRemotePersistedRef('tagDetail:industryL2Filter', '全部')
const industryL2Options = computed(() => {
  const set = new Set(detailSamples.value
    .filter(s => industryL1Filter.value === '全部' || (s.firstLevelIndustryName || s.industryL1 || '') === industryL1Filter.value)
    .map(s => (s.secondLevelIndustryName || s.industryL2 || '').trim())
    .filter(Boolean))
  return ['全部', ...Array.from(set).sort()]
})
function onL1Change() { industryL2Filter.value = '全部'; page.value = 1 }
function setIndustryL1(v) { industryL1Filter.value = v; onL1Change() }
function setIndustryL2(v) { industryL2Filter.value = v; page.value = 1 }

// 审核人筛选（跨设备延续）
const reviewerFilter = useRemotePersistedRef('tagDetail:reviewerFilter', '全部')
const reviewerOptions = computed(() => {
  const set = new Set(detailSamples.value.map(s => (s.reviewerName || s.aiEvaluateReviewerName || '').trim()).filter(Boolean))
  return ['全部', ...Array.from(set).sort()]
})
function setReviewer(v) { reviewerFilter.value = v; page.value = 1 }

// 广告主ID筛选（跨设备延续）
const advertiserIdFilter = useRemotePersistedRef('tagDetail:advertiserIdFilter', '全部')
const advertiserIdOptions = computed(() => {
  const set = new Set(detailSamples.value.map(s => (s.advertiserId || s.uid || '').trim()).filter(Boolean))
  return ['全部', ...Array.from(set).sort()]
})
function setAdvertiser(v) { advertiserIdFilter.value = v; page.value = 1 }

const filtered = computed(() => {
  let arr = detailSamples.value
  if (verifyFilter.value !== '全部') arr = arr.filter(s => s.verifyStatus === verifyFilter.value)
  if (typeFilter.value !== '全部') arr = arr.filter(s => s.elementTypeName === typeFilter.value)
  if (industryL1Filter.value !== '全部') arr = arr.filter(s => (s.firstLevelIndustryName || s.industryL1 || '') === industryL1Filter.value)
  if (industryL2Filter.value !== '全部') arr = arr.filter(s => (s.secondLevelIndustryName || s.industryL2 || '') === industryL2Filter.value)
  if (reviewerFilter.value !== '全部') arr = arr.filter(s => (s.reviewerName || s.aiEvaluateReviewerName || '') === reviewerFilter.value)
  if (advertiserIdFilter.value !== '全部') arr = arr.filter(s => (s.advertiserId || s.uid || '') === advertiserIdFilter.value)
  if (humanTagFilter.value !== '全部') {
    arr = arr.filter(s => {
      const raw = s.humanTag || s.aiEvaluatePolicyIds || ''
      const cleaned = String(raw).replace(/[\[\]\s]/g, '')
      if (humanTagFilter.value === '通过') return !cleaned
      const tags = cleaned.split(/[,，]/).filter(Boolean)
      return tags.includes(humanTagFilter.value)
    })
  }
  if (onlyAnnotated.value) arr = arr.filter(s => annotatedIds.value.has(s.id))
  // 关注筛选：我的元素关注 / 我的簇关注
  if (watchFilter.value === 'element') arr = arr.filter(s => watchedElements.value.includes(s.id))
  else if (watchFilter.value === 'cluster') arr = arr.filter(s => s.classId && watchedClusters.value.includes(s.classId))
  return arr
})

// 分页（跨设备延续）
const page = useRemotePersistedRef('tagDetail:samplePage', 1)
const pageSize = useRemotePersistedRef('tagDetail:samplePageSize', 20)
const paged = computed(() => {
  if (pageSize.value === 'all') return filtered.value
  const s = (page.value - 1) * Number(pageSize.value)
  return filtered.value.slice(s, s + Number(pageSize.value))
})
function setType(t) { typeFilter.value = t; page.value = 1 }
function setHumanTag(t) { humanTagFilter.value = t; page.value = 1 }

// 重置筛选：一键恢复全部筛选条件（类型/判定/行业/审核人/广告主/人审标签/只看标注）
function resetFilters() {
  typeFilter.value = '全部'
  verifyFilter.value = '全部'
  industryL1Filter.value = '全部'
  industryL2Filter.value = '全部'
  reviewerFilter.value = '全部'
  advertiserIdFilter.value = '全部'
  humanTagFilter.value = '全部'
  onlyAnnotated.value = false
  page.value = 1
}

// 校验明细筛选值是否仍有效：清除跨标签/跨会话残留的脏筛选值
// （例如上一个标签的审核人ID，在新标签数据中不存在，会把手动过滤成空 → 元素无数据）
function validateDetailFilters() {
  if (typeFilter.value !== '全部' && !types.value.includes(typeFilter.value)) typeFilter.value = '全部'
  if (humanTagFilter.value !== '全部' && !humanTagTypes.value.includes(humanTagFilter.value)) humanTagFilter.value = '全部'
  if (industryL1Filter.value !== '全部' && !industryL1Options.value.includes(industryL1Filter.value)) {
    industryL1Filter.value = '全部'
    industryL2Filter.value = '全部'
  }
  if (industryL2Filter.value !== '全部' && !industryL2Options.value.includes(industryL2Filter.value)) industryL2Filter.value = '全部'
  if (reviewerFilter.value !== '全部' && !reviewerOptions.value.includes(reviewerFilter.value)) reviewerFilter.value = '全部'
  if (advertiserIdFilter.value !== '全部' && !advertiserIdOptions.value.includes(advertiserIdFilter.value)) advertiserIdFilter.value = '全部'
}

// ===== 明细展示方式：表格 / 卡片（复用素材分类卡片形式） =====
const viewMode = useRemotePersistedRef('tagDetail:viewMode', 'table') // 'table' | 'card'
const cols = ref(4) // 卡片列数：1 / 4 / custom
const customCols = ref(4)
const activeCols = computed(() => {
  const n = cols.value === 'custom' ? Number(customCols.value) : Number(cols.value)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.max(Math.round(n), 1), 12) : 4
})
const gridStyle = computed(() => activeCols.value > 1 ? { gridTemplateColumns: `repeat(${activeCols.value}, minmax(0, 1fr))` } : {})
const mediaErr = ref(new Set())
function cardMediaErr(id) { return mediaErr.value.has(id) }
// 卡片 OCR/ASR 折叠状态（与素材分类一致：默认折叠，点击标题展开/收起）
const cardSections = reactive({}) // { [id:field]: bool }
function cardSectionOpen(s, field) {
  return !!cardSections[`${s.id}:${field}`]
}
function toggleCardSection(s, field) {
  const key = `${s.id}:${field}`
  cardSections[key] = !cardSections[key]
}
// 媒体加载失败：与素材分类一致的三层兜底（直连重试 → 代理兜底 → 打开原链接）
function onErr(id) {
  const el = document.querySelector(`[data-vid="${id}"]`)
  // 图片：尝试原始直连重试一次
  if (el && el.tagName === 'IMG' && retryOriginalSrc(el)) return
  // 视频：首次失败先用「原始直连（不重签 dis_t）」重试一次，再决定是否降级
  if (el && el.tagName === 'VIDEO' && !el.dataset.__vidRetry) {
    el.dataset.__vidRetry = '1'
    const raw = el.getAttribute('data-raw-url') || el.dataset.src || el.src || ''
    const plain = rawHttpsUrlPlain(raw)
    if (plain && plain !== el.src) {
      el.src = plain
      el.load()
      return
    }
  }
  // 直连重试仍失败 → 二级兜底走后端代理（服务端续期 dis_t 代拉）
  if (el && mediaProxyFallback(el)) return
  // 代理仍失败：标记降级，模板切换到「打开原链接」逃生通道
  if (mediaErr.value.has(id)) return
  mediaErr.value.add(id); mediaErr.value = new Set(mediaErr.value)
}
// 视频播放状态同步（卡片 ↔ 相似样本弹窗共享同一播放进度），与素材分类一致
const videoStates = reactive({})  // { [sampleId]: { currentTime, paused, duration, playbackRate } }
function syncVideoState(el, sampleId) {
  if (!el || !sampleId) return
  const st = videoStates[sampleId]
  if (st) {
    try {
      if (st.currentTime != null && Math.abs(el.currentTime - st.currentTime) > 0.3) el.currentTime = st.currentTime
      if (st.paused === false) el.play().catch(() => {})
      else el.pause()
      if (st.playbackRate) el.playbackRate = st.playbackRate
    } catch {}
  }
  if (el._syncBound) return
  el._syncBound = true
  el.addEventListener('timeupdate', () => {
    if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0 }
    videoStates[sampleId].currentTime = el.currentTime
    videoStates[sampleId].duration = el.duration || 0
  })
  el.addEventListener('play', () => {
    if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0 }
    videoStates[sampleId].paused = false
  })
  el.addEventListener('pause', () => {
    if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0 }
    videoStates[sampleId].paused = true
    videoStates[sampleId].currentTime = el.currentTime
  })
}
const SPEED_OPTIONS = [1, 1.5, 2, 3, 0.5]
function speedLabel(sampleId) {
  const rate = videoStates[sampleId]?.playbackRate || 1
  return `${rate}x`
}
function cycleSpeed(sampleId) {
  const cur = videoStates[sampleId]?.playbackRate || 1
  const idx = SPEED_OPTIONS.indexOf(cur)
  const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
  if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0, playbackRate: next }
  else videoStates[sampleId].playbackRate = next
  document.querySelectorAll(`video[data-vid="${sampleId}"], .detail-modal video`).forEach(el => {
    if (el) el.playbackRate = next
  })
}
function isCardText(s) { return !s.mediaUrl || s.elementTypeName === '文本' }
const TYPE_EN_MAP = { '视频': 'Video', '图片': 'Image', '文本': 'Text', '落地页': 'URL' }
function cardTypeText(s) {
  const t = s.elementTypeName
    ? s.elementTypeName
    : (!s.mediaUrl ? '文本' : (isVideoByUrl(s.mediaUrl) ? '视频' : '图片'))
  return TYPE_EN_MAP[t] || t
}
function cardVerifyLabel(s) {
  return { consistent: '一致', miss: '漏放', fp: '误杀' }[s.verifyStatus] || '—'
}
// 三态审核判定角标：一致 / 漏放 / 误杀，三种颜色样式，素材与聚类素材统一标注
function verifyBadge(s) {
  const map = { consistent: ['一致', 'v-consistent'], miss: ['漏放', 'v-miss'], fp: ['误杀', 'v-fp'] }
  const pair = map[s.verifyStatus]
  return pair ? { label: pair[0], cls: pair[1] } : { label: '', cls: '' }
}
function humanTagText(s) {
  const t = s.humanTag && String(s.humanTag).replace(/[\[\]]/g, '').trim()
  return t || '通过'
}
// 机审标签：取数据中审核元素ID（policyIds 优先，兜底 machineTag）中的全部标签，而非仅当前筛选标签
function machineTagText(s) {
  const raw = s.policyIds || s.machineTag || ''
  const t = String(raw).replace(/[\[\]]/g, '').trim()
  return t || ''
}

// ===== TRAG 相似素材检索弹窗（图三：点击卡片打开，与素材分类一致） =====
const tragSearchVisible = ref(false)
const tragSearchMaterial = ref(null)
function toTragMaterial(s) {
  const human = s.humanTag && String(s.humanTag).replace(/[\[\]]/g, '').trim()
  return {
    id: s.id,
    elementId: s.elementId || s.id,
    mediaUrl: s.mediaUrl,
    type: s.elementTypeName,
    elementTypeName: s.elementTypeName,
    isVideo: s.isVideo || s.elementTypeName === '视频',
    elementFingerprint: s.elementFingerprint,
    industryL1: s.firstLevelIndustryName || s.industryL1 || '',
    industryL2: s.secondLevelIndustryName || s.industryL2 || '',
    policyIds: s.machineTag || s.policyIds || '',
    aiEvaluatePolicyIds: human || '',
    humanTagEmpty: !human,
    dcId: s.dcId || '',
    reviewerName: s.reviewerName || '',
    opsAdvertiserName: s.advertiserId || s.uid || '',
    advertiserId: s.advertiserId || s.uid || '',
    ocr: s.ocrContent || '',
    asr: s.asrContent || '',
    verifyStatus: s.verifyStatus,
    machineTag: s.machineTag,
    humanTag: s.humanTag,
    remark: s.remark,
  }
}
function openDetail(s) {
  tragSearchMaterial.value = toTragMaterial(s)
  tragSearchVisible.value = true
}
function closeTragSearch() {
  tragSearchVisible.value = false
  tragSearchMaterial.value = null
}

// ===== 明细视图：元素 / 聚类簇（融合，共用同一份 samples 数据） =====
const detailView = useRemotePersistedRef('tagDetail:detailView', 'element') // 'element' | 'cluster'
// 簇行固定为列表形态；顶部「列表/卡片」为元素粒度切换：列表=表格，卡片=卡片，作用于簇内展开的元素素材（聚类簇行不受影响）
const clusterViewMode = ref('list')
const isListMode = computed(() => viewMode.value === 'table')
const isCardMode = computed(() => viewMode.value === 'card')
function setListCard(mode) {
  viewMode.value = mode === 'list' ? 'table' : 'card'
}
const expandedCluster = ref('') // 当前展开的簇 classId（点击行下拉簇内素材预览卡片）
const clusterChecked = reactive({}) // 簇行勾选状态（勾选后可直接下载/提需，无需进入选择模式）
// 我的关注：跨设备延续（按用户隔离），分「簇关注」与「元素关注」两个维度
const watchedClusters = useRemotePersistedRef('tagDetail:watchClusters', []) // 关注的聚类簇 classId
const watchedElements = useRemotePersistedRef('tagDetail:watchElements', [])   // 关注的元素（素材）id
// 关注筛选三档：'' 全部 / 'cluster' 我的簇关注 / 'element' 我的元素关注
const watchFilter = ref('')
function isWatchedCluster(cid) { return watchedClusters.value.includes(cid) }
function toggleWatchCluster(cid) {
  const set = new Set(watchedClusters.value)
  const nowOn = !set.has(cid)
  if (nowOn) set.add(cid)
  else set.delete(cid)
  watchedClusters.value = [...set]
  if (nowOn) watchFilter.value = 'cluster'
}
function isWatchedElement(id) { return watchedElements.value.includes(id) }
function toggleWatchElement(id) {
  const set = new Set(watchedElements.value)
  const nowOn = !set.has(id)
  if (nowOn) set.add(id)
  else set.delete(id)
  watchedElements.value = [...set]
  if (nowOn) watchFilter.value = 'element'
}

// 聚类簇 = 明细 samples 按 classId（c 开头）前端分组聚合，与元素视图调用同一份素材卡片数据
const curTagId = computed(() => String(route.params.id || ''))
// 簇精度（不随数据源「全部/一致/漏放/误杀」变化）：始终基于该标签全部样本统计
// 精度 = 簇内一致数量 ÷ (一致 + 误杀)
const clusterPrecisionMap = computed(() => {
  const map = new Map()
  for (const s of detailSamples.value) {
    const cid = s.classId
    if (!cid || !String(cid).startsWith('c')) continue
    if (!map.has(cid)) map.set(cid, { consistent: 0, fp: 0 })
    const m = map.get(cid)
    if (s.verifyStatus === 'consistent') m.consistent++
    else if (s.verifyStatus === 'fp') m.fp++
  }
  const out = new Map()
  for (const [cid, m] of map) {
    const denom = m.consistent + m.fp
    out.set(cid, {
      consistent: m.consistent,
      fp: m.fp,
      precision: denom > 0 ? Math.round(m.consistent / denom * 100) : null,
    })
  }
  return out
})
const clusterGroups = computed(() => {
  const map = new Map()
  const tagId = curTagId.value
  // 数据源随「审核判定」筛选（全部/一致/漏放/误杀）联动：切换后簇的机审/人审占比按筛选后样本重算
  const vf = verifyFilter.value
  const source = vf === '全部' ? detailSamples.value : detailSamples.value.filter(s => s.verifyStatus === vf)
  for (const s of source) {
    const cid = s.classId
    if (!cid || !String(cid).startsWith('c')) continue
    if (!map.has(cid)) {
      map.set(cid, { classId: cid, total: 0, machineHits: 0, humanHits: 0, machineTagCount: {}, humanTagCount: {}, industryCount: {}, advCount: {}, reviewerCount: {}, elements: [] })
    }
    const c = map.get(cid)
    c.total++
    const mIds = String(s.machineTag || s.policyIds || '').replace(/[\[\]\s]/g, '').split(/[,，]/).filter(Boolean)
    const hIds = String(s.humanTag || s.aiEvaluatePolicyIds || '').replace(/[\[\]\s]/g, '').split(/[,，]/).filter(Boolean)
    // 机审/人审命中 = 逗号边界精确命中当前标签（图二判定逻辑），避免"任意策略非空"导致的 100% 失真
    if (tagId && mIds.includes(tagId)) c.machineHits++
    if (tagId && hIds.includes(tagId)) c.humanHits++
    for (const t of mIds) c.machineTagCount[t] = (c.machineTagCount[t] || 0) + 1
    for (const t of hIds) c.humanTagCount[t] = (c.humanTagCount[t] || 0) + 1
    const ind = [s.firstLevelIndustryName || s.industryL1 || '', s.secondLevelIndustryName || s.industryL2 || ''].filter(Boolean).join('/') || '未知'
    c.industryCount[ind] = (c.industryCount[ind] || 0) + 1
    const adv = s.advertiserId || s.uid || s.opsAdvertiserName || '未知'
    c.advCount[adv] = (c.advCount[adv] || 0) + 1
    const reviewer = s.reviewerName || s.aiEvaluateReviewerName || ''
    if (reviewer) c.reviewerCount[reviewer] = (c.reviewerCount[reviewer] || 0) + 1
    c.elements.push(s)
  }
  const list = []
  for (const c of map.values()) {
    const mPct = c.total ? Math.round(c.machineHits / c.total * 100) : 0
    const hPct = c.total ? Math.round(c.humanHits / c.total * 100) : 0
    const passPct = Math.max(0, 100 - hPct)
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, cnt]) => ({ id: k, name: k, count: cnt, pct: c.total ? Math.round(cnt / c.total * 100) : 0 }))
    const firstMedia = c.elements.find(e => e.mediaUrl) || null
    const prec = clusterPrecisionMap.value.get(c.classId)
    list.push({
      classId: c.classId,
      total: c.total,
      machinePct: mPct,
      humanPct: hPct,
      humanPassPct: passPct,
      clusterPrecision: prec ? prec.precision : null,
      clusterConsistent: prec ? prec.consistent : 0,
      clusterFp: prec ? prec.fp : 0,
      machineTags: top(c.machineTagCount, 5),
      humanTags: top(c.humanTagCount, 5),
      industries: top(c.industryCount, 5),
      advertisers: top(c.advCount, 3),
      reviewers: top(c.reviewerCount, 8),
      preview: firstMedia ? { elementValue: firstMedia.mediaUrl, isVideo: !!firstMedia.isVideo || firstMedia.elementTypeName === '视频', isText: firstMedia.elementTypeName === '文本' } : null,
      elements: c.elements,
    })
  }
  return list.sort((a, b) => b.total - a.total)
})

// 聚类簇展示列表：按关注筛选三档过滤
const displayClusterGroups = computed(() => {
  if (watchFilter.value === 'cluster') {
    return clusterGroups.value.filter(c => watchedClusters.value.includes(c.classId))
  }
  if (watchFilter.value === 'element') {
    // 我的元素关注：只显示包含至少一个已关注元素的簇
    return clusterGroups.value.filter(c => (c.elements || []).some(e => watchedElements.value.includes(e.id)))
  }
  return clusterGroups.value
})

// 簇列表分页：默认每页 20 簇，可切换 20/50/100，支持翻页（页码/每页数量跨设备延续）
const clusterListPage = useRemotePersistedRef('tagDetail:clusterPage', 1)
const clusterListPageSize = useRemotePersistedRef('tagDetail:clusterPageSize', 20)
const clusterListPageCount = computed(() => Math.max(1, Math.ceil(displayClusterGroups.value.length / (Number(clusterListPageSize.value) || 20))))
const pagedClusterGroups = computed(() => {
  const list = displayClusterGroups.value
  const size = Number(clusterListPageSize.value) || 20
  if (list.length <= size) return list
  const maxPage = Math.max(1, Math.ceil(list.length / size))
  const p = Math.min(Number(clusterListPage.value) || 1, maxPage)
  return list.slice((p - 1) * size, p * size)
})
function setClusterListPage(p) { clusterListPage.value = Math.max(1, Math.min(p, clusterListPageCount.value)) }
function setClusterListPageSize(n) { clusterListPageSize.value = n; clusterListPage.value = 1 }
// 切换关注筛选后重置簇列表到第一页（watchFilter 已在前方定义）
watch(watchFilter, () => { clusterListPage.value = 1 })

// 聚合量构成：机审占比 / 人审占比 / 人审通过占比（三色条），随「审核判定」筛选（全部/一致/漏放/误杀）联动重算
function clusterPctBars(c) {
  return [
    { key: 'machine', label: '机审', pct: c.machinePct || 0, color: '#0ea5e9' },
    { key: 'human', label: '人审', pct: c.humanPct || 0, color: '#a855f7' },
    { key: 'pass', label: '人审通过', pct: c.humanPassPct || 0, color: '#22c55e' },
  ]
}
// 簇精度 tooltip 解释：簇内一致数量 /（一致 + 误杀），不随数据源（全部/一致/漏放/误杀）变化
function clusterPrecisionTip(c) {
  const p = c.clusterPrecision
  if (p === null || p === undefined) {
    return '簇精度 = 簇内一致数量 /（一致 + 误杀）\n本簇无一致/误杀样本'
  }
  return `簇精度 = 簇内一致数量 /（一致 + 误杀）\n本簇：一致 ${c.clusterConsistent} · 误杀 ${c.clusterFp} → ${p}%`
}
// 展开/收起某簇：点击行下拉该簇下预览卡片（直接展示该簇 samples，与明细一致）
function toggleClusterExpand(classId) {
  expandedCluster.value = expandedCluster.value === classId ? '' : classId
}

// 簇内分页：展开后每页最多展示 CLUSTER_PAGE_SIZE 条，左右翻页查看（避免大簇一次性渲染上千行导致卡顿/跳动）
const CLUSTER_PAGE_SIZE = 20
const clusterPage = reactive({}) // classId -> 当前页码（1 起）
function clusterPageCount(c) { return Math.max(1, Math.ceil((c.elements?.length || 0) / CLUSTER_PAGE_SIZE)) }
function clusterPageNo(c) { return Math.min(clusterPage[c.classId] || 1, clusterPageCount(c)) }
function clusterPaged(c) {
  const els = c.elements || []
  if (els.length <= CLUSTER_PAGE_SIZE) return els
  const p = clusterPageNo(c)
  const s = (p - 1) * CLUSTER_PAGE_SIZE
  return els.slice(s, s + CLUSTER_PAGE_SIZE)
}
function clusterPagePrev(c) { if (clusterPageNo(c) > 1) clusterPage[c.classId] = clusterPageNo(c) - 1 }
function clusterPageNext(c) { if (clusterPageNo(c) < clusterPageCount(c)) clusterPage[c.classId] = clusterPageNo(c) + 1 }
// 勾选簇行 → 将该簇内素材（同一份 samples）加入 selected，可直接下载/提需
function toggleClusterCheck(c) {
  const checked = !clusterChecked[c.classId]
  clusterChecked[c.classId] = checked
  for (const s of (c.elements || [])) {
    if (checked) selected.value.add(s.id)
    else selected.value.delete(s.id)
  }
  selected.value = new Set(selected.value)
}
// 清除某簇勾选关联的样本
function clearClusterCheck(classId) {
  if (clusterChecked[classId]) {
    toggleClusterCheck(clusterGroups.value.find(c => c.classId === classId) || { classId, elements: [] })
  }
}
// 表头全选：一键勾选/取消全部聚类簇（每簇素材加入 selected，可直接下载/提需）
const allClustersChecked = computed(() => displayClusterGroups.value.length > 0 && displayClusterGroups.value.every(c => clusterChecked[c.classId]))
function toggleAllClusters() {
  const target = !allClustersChecked.value
  for (const c of displayClusterGroups.value) {
    clusterChecked[c.classId] = target
    for (const s of (c.elements || [])) {
      if (target) selected.value.add(s.id)
      else selected.value.delete(s.id)
    }
  }
  selected.value = new Set(selected.value)
}
function clusterTagList(tags) {
  return (tags || []).map(t => ({ id: t.id, name: t.name, pct: t.pct, count: t.count }))
}

// ===== 簇特征总结（可编辑套路）：按标签从后端加载，编辑后保存 =====
const clusterFeatures = reactive({})       // classId -> { summary, owner, updatedAt }
const clusterFeatureSaving = reactive({})  // classId -> bool
const clusterFeatureDraft = reactive({})   // classId -> 编辑中的草稿文本
const clusterFeatureGenerating = reactive({}) // classId -> bool（AI 生成中）

async function loadClusterFeatures() {
  const tagId = curTagId.value
  if (!tagId) return
  try {
    const rows = (await badcaseApi.getClusterFeatures(tagId)) || []
    for (const r of rows) {
      clusterFeatures[r.classId] = { summary: r.featureSummary || '', owner: r.owner || '', updatedAt: r.updatedAt || '' }
    }
  } catch { /* 加载失败静默，面板仍可编辑/生成 */ }
}
function featureSummaryOf(c) {
  return clusterFeatureDraft[c.classId] ?? clusterFeatures[c.classId]?.summary ?? clusterFeatureProse(c)
}
// 簇特征文字总结（图一修订）：行业主要集中在 X 占比；主要审核员 X 打标占比；人审标签主要为；广告主均是 X；套路：OCR/ASR 高频词
function clusterFeatureProse(c) {
  const n = (c.elements && c.elements.length) || 0
  const inds = (c.industries || []).filter(i => i && i.name && i.name !== '未知')
  const reviewers = [...(c.reviewers || [])].sort((a, b) => (b.count || 0) - (a.count || 0))
  const humanTags = clusterTagList(c.humanTags)
  const advs = [...(c.advertisers || [])].sort((a, b) => (b.count || 0) - (a.count || 0))
  const pct = (cnt, total) => (total ? Math.round((cnt / total) * 100) : 0)
  const parts = []
  if (inds.length) {
    const top = inds.slice(0, 3).map(i => `${i.name} ${pct(i.count, n)}%`).join('、')
    parts.push(`行业主要集中在 ${top}`)
  } else parts.push('行业分布不明确')
  if (reviewers.length) {
    const top = reviewers[0]
    const totRev = reviewers.reduce((s, r) => s + (r.count || 0), 0)
    parts.push(`主要审核员 ${top.name} 打标 ${top.count} 个（占审核量 ${pct(top.count, totRev)}%）`)
  } else parts.push('无审核员信息')
  if (humanTags.length) {
    const top = humanTags.slice(0, 3).map(t => `${t.name} ${t.pct}%`).join('、')
    parts.push(`人审标签主要为 ${top}`)
  } else parts.push('人审标签均为通过')
  if (advs.length) {
    if (advs.length === 1) parts.push(`广告主均是 ${advs[0].name}`)
    else parts.push(`广告主主要为 ${advs.slice(0, 3).map(a => a.name).join('、')}`)
  } else parts.push('无广告主信息')
  const saved = clusterFeatureDraft[c.classId] ?? clusterFeatures[c.classId]?.summary ?? ''
  const trick = saved || generateClusterFeature(c.elements || []).summary
  if (trick) parts.push(`套路：${trick}`)
  return parts.join('；') + '。'
}
function startFeatureEdit(c) {
  clusterFeatureDraft[c.classId] = featureSummaryOf(c)
}
function cancelFeatureEdit(c) {
  delete clusterFeatureDraft[c.classId]
}
// 根据簇内素材 OCR/ASR 提取套路总结
function generateClusterSummary(c) {
  clusterFeatureGenerating[c.classId] = true
  // 让出主线程，避免大簇同步计算阻塞 UI
  setTimeout(() => {
    try {
      const r = generateClusterFeature(c.elements || [])
      clusterFeatureDraft[c.classId] = clusterFeatureProse(c) || r.summary || '该簇素材暂无 OCR/ASR 文本内容'
    } finally {
      clusterFeatureGenerating[c.classId] = false
    }
  }, 30)
}
async function saveClusterFeature(c) {
  const tagId = curTagId.value
  if (!tagId || !c.classId) return
  const summary = (clusterFeatureDraft[c.classId] ?? featureSummaryOf(c)).trim()
  clusterFeatureSaving[c.classId] = true
  try {
    await badcaseApi.saveClusterFeature({ tagId, classId: c.classId, featureSummary: summary })
    clusterFeatures[c.classId] = { summary, owner: '', updatedAt: '' }
    delete clusterFeatureDraft[c.classId]
    toast.success('簇特征已保存')
  } catch (e) {
    toast.warn(e.message || '保存失败')
  } finally {
    clusterFeatureSaving[c.classId] = false
  }
}

// 审核判定筛选（跨设备延续）：基于后端每样本 verifyStatus 字段
// 一致 consistent：审核标签ID打了该标签且人审也打了该标签
// 误杀 fp：审核标签ID打了该标签但人审没有打该标签
// 漏放 miss：除了一致和误杀的情况（人审打了但机审未打，或双方都未打）
const verifyFilter = useRemotePersistedRef('tagDetail:verifyFilter', '全部')
const verifyOptions = [
  { key: '全部', label: '全部' },
  { key: 'consistent', label: '一致' },
  { key: 'miss', label: '漏放' },
  { key: 'fp', label: '误杀' },
]
const verifyCount = (k) => {
  if (k === '全部') return detailSamples.value.length
  return detailSamples.value.filter(s => s.verifyStatus === k).length
}
function setVerify(k) { verifyFilter.value = k; page.value = 1; clusterListPage.value = 1 }

// 选择
const selected = ref(new Set())
const allChecked = computed(() => filtered.value.length && filtered.value.every(s => selected.value.has(s.id)))
function toggle(id) { selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id); selected.value = new Set(selected.value) }
function toggleAll() {
  if (allChecked.value) filtered.value.forEach(s => selected.value.delete(s.id))
  else filtered.value.forEach(s => selected.value.add(s.id))
  selected.value = new Set(selected.value)
}
function goTicket() {
  const objs = detailSamples.value.filter(s => selected.value.has(s.id)).map(s => ({
    id: s.id, type: s.elementTypeName || s.type || '图片', isVideo: !!s.isVideo,
    mediaUrl: s.mediaUrl || '', ocr: s.ocrContent || '', asr: s.asrContent || '',
    elementFingerprint: s.elementFingerprint || '',
    industryL1: s.firstLevelIndustryName || s.industryL1 || '',
    industryL2: s.secondLevelIndustryName || s.industryL2 || '',
    tagId: tag.value?.id || '', tag: tag.value?.name || '',
    reviewerName: s.reviewerName || s.aiEvaluateReviewerName || '',
    dcId: s.dcId || '',
    advertiserId: s.advertiserId || '',
  }))
  // 检测整体勾选的聚类簇：若某簇全部元素均被勾选，则视为「选中簇」，携带簇特征
  const clusterSelections = []
  for (const c of clusterGroups.value) {
    const ids = (c.elements || []).map(e => e.id)
    if (ids.length && ids.every(id => selected.value.has(id))) {
      clusterSelections.push({
        classId: c.classId,
        total: c.total,
        feature: clusterFeatureProse(c),
        elements: (c.elements || []).map(s => ({
          id: s.id, type: s.elementTypeName || s.type || '图片', isVideo: !!s.isVideo,
          mediaUrl: s.mediaUrl || '', ocr: s.ocrContent || '', asr: s.asrContent || '',
          elementFingerprint: s.elementFingerprint || '',
          industryL1: s.firstLevelIndustryName || s.industryL1 || '',
          industryL2: s.secondLevelIndustryName || s.industryL2 || '',
          tagId: tag.value?.id || '', tag: tag.value?.name || '',
          reviewerName: s.reviewerName || s.aiEvaluateReviewerName || '',
          dcId: s.dcId || '',
          advertiserId: s.advertiserId || '',
          verifyStatus: s.verifyStatus || '',
        })),
      })
    }
  }
  const ctx = {
    tagId: tag.value.id, tag: tag.value.name,
    elementType: objs.length ? objs[0].type : '',
    industryL1: objs.length ? objs[0].industryL1 : '',
    industryL2: objs.length ? objs[0].industryL2 : '',
  }
  // 记录当前样本明细页作为来源，退出提需流程时可返回
  const wasActive = ticketFlow.active
  if (!wasActive) ticketFlow.begin()
  ticketFlow.setSamples(objs, ctx)
  ticketFlow.setClusters(clusterSelections)
  ticketFlow.setOrigin(route.fullPath)
  const clusterCount = clusterSelections.reduce((s, c) => s + c.elements.length, 0)
  toast.success(wasActive
    ? `已选 ${selected.value.size} 条样本${clusterSelections.length ? `（含 ${clusterSelections.length} 个簇）` : ''}，返回提需`
    : `已选 ${selected.value.size} 条样本${clusterSelections.length ? `（含 ${clusterCount} 条簇内素材）` : ''}，前往提需`)
  router.push({ name: 'tickets' })
}
function exportSelected() { toast.success(`已导出 ${selected.value.size} 条样本为 Excel`) }

// ===== 返回误杀Case分析（标签跟踪）并定位到当前标签 =====
function goBack() {
  router.push({
    path: '/classify',
    query: {
      tagId: route.params.id,
      tagName: tag.value?.name || '',
      start: tagDate.value.start || '',
      end: tagDate.value.end || '',
      preset: tagDate.value.preset || '',
    },
  })
}

// 导出选中素材为 Excel
async function exportSelectedExcel() {
  if (!selected.value.size) { toast.warn('请先勾选要导出的素材'); return }
  try {
    const range = dateRange()
    await tagApi.exportExcel(route.params.id, {
      sampleIds: [...selected.value],
      start: range.start || '',
      end: range.end || '',
    })
    toast.success(`已导出 ${selected.value.size} 条素材为 Excel`)
  } catch (e) {
    toast.warn(e.message || '导出失败')
  }
}

// ===== 图表筛选项：一级行业 / 二级行业 / 元素类型 =====
const COLLAPSE_N = 10
const PIE_COLORS = ['#4f7cff', '#7c6df0', '#1fb574', '#f5a000', '#f0454b', '#16c0c8']

// 误杀样本（人审未命中该机审标签）
const fpSamples = computed(() => samples.value.filter(s => s.isFp))

// 预览统一走直连 CDN（http→https 升级，失败由 onMediaError 兜底「↗ 原素材」）。
// 注意：必须同步返回字符串 URL——模板直接把它绑到 :src/:href，
// 若返回 Promise 会被字符串化为 "[object Promise]" 导致 Resource loading error。
function resolveSignedSrc(rawUrl) {
  return previewSrc(rawUrl)
}

// 缩略图点击：视频已内嵌 <video controls> 直接播放，无需跳转；图片/其他点击打开原链接
function onThumbClick(s) {
  if (isVideoByUrl(s.mediaUrl)) return
  openOriginal(s.mediaUrl)
}

// 通用：按字段统计误杀样本数分布
function distBy(field) {
  const m = {}
  for (const s of fpSamples.value) {
    const k = s[field] || '未知'
    m[k] = (m[k] || 0) + 1
  }
  return Object.entries(m).map(([name, value]) => ({ name, value }))
}

// ===== 行业分布（一级-二级 合并标签，扁平分布） =====
function distByIndustry() {
  const m = {}
  for (const s of fpSamples.value) {
    const l1 = s.firstLevelIndustryName || '未知'
    const l2 = s.secondLevelIndustryName || '未知'
    const k = `${l1}-${l2}`
    m[k] = (m[k] || 0) + 1
  }
  return Object.entries(m).map(([name, value]) => ({ name, value }))
}

// 行业搜索/排序/折叠（跨设备延续）
const indSort = useRemotePersistedRef('tagDetail:indSort', 'desc')
const indExpand = useRemotePersistedRef('tagDetail:indExpand', false)
const indSearch = useRemotePersistedRef('tagDetail:indSearch', '')
const indSorted = computed(() => distByIndustry()
  .filter(d => !indSearch.value || d.name.includes(indSearch.value.trim()))
  .sort((a, b) => indSort.value === 'desc' ? b.value - a.value : a.value - b.value))
const indShown = computed(() => indExpand.value ? indSorted.value : indSorted.value.slice(0, COLLAPSE_N))
const indOver = computed(() => indSorted.value.length > COLLAPSE_N)
const industryOption = computed(() => barOption(indShown.value, '#4f7cff'))

// 元素类型分布：随数据动态（图片/视频/文本/落地页取决于数据）
const typePie = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
  legend: { bottom: 0, icon: 'circle', textStyle: { color: '#5a6478', fontSize: 12 } },
  series: [{ type: 'pie', radius: ['52%', '74%'], center: ['50%', '44%'], avoidLabelOverlap: false,
    itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
    label: { show: false }, data: distBy('elementTypeName').map((d, i) => ({ ...d, itemStyle: { color: PIE_COLORS[i % PIE_COLORS.length] } })) }],
}))

// ===== 每日精度趋势图 EChart option（三面板纵向分区：日精度% / FP / 打标量 各自独立，互不相交）=====
const dailyTrendOption = computed(() => {
  const data = dailyTrend.value
  if (!data.length) return {}

  const dates = data.map(p => p.date?.slice(5) || '')
  const precisions = data.map(p => p.precision)
  const fpVals = data.map(p => p.fp)
  const totalVals = data.map(p => p.total)

  const maxTotal = Math.max(...totalVals, 1)
  const maxFp = Math.max(...fpVals, 1)
  const fmtVol = v => v >= 10000 ? (v / 10000).toFixed(1) + 'w' : v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v

  // 三面板纵向布局：日精度保持 116；FP/打标量柱状图压缩为 1/3（39），面板间隙 40
  const grids = [
    { left: 58, right: 26, top: 30, height: 116 },
    { left: 58, right: 26, top: 186, height: 39 },
    { left: 58, right: 26, top: 265, height: 39 },
  ]

  return {
    legend: { show: false },
    graphic: [
      { type: 'text', left: 14, top: 200, style: { text: 'FP', fill: '#7dd3fc', font: '600 12px sans-serif' } },
      { type: 'text', left: 14, top: 279, style: { text: '打标', fill: '#b6c0d0', font: '600 12px sans-serif' } },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255,255,255,.98)',
      borderColor: '#e8ecf4', borderWidth: 1,
      padding: [12, 16],
      textStyle: { fontSize: 12, color: '#5a6478' },
      extraCssText: 'box-shadow:0 8px 30px rgba(20,30,60,.14);border-radius:12px;',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(79,124,255,.05)' } },
      formatter: (params) => {
        const idx = params[0]?.dataIndex
        const dp = data[idx]
        if (!dp) return ''
        return `<div style="font-size:12px;color:#8b94a8;margin-bottom:8px;font-weight:600">${dp.date || ''}</div>
<div style="font-size:13px;margin-bottom:4px">· 日精度 <b style="color:${getPrecColor(dp.precision)};font-size:16px">${dp.precision ?? '—'}%</b></div>
<div style="font-size:12px;color:#8b94a8;margin-bottom:2px">· FP <b style="color:#e74c3c">${dp.fp ?? 0}</b></div>
<div style="font-size:12px;color:#8b94a8">· 打标量 <b>${Number(dp.total ?? 0).toLocaleString()}</b></div>`
      },
    },
    grid: grids,
    xAxis: [
      {
        type: 'category', data: dates, gridIndex: 0,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#e0e4ec' } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category', data: dates, gridIndex: 1,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#e0e4ec' } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category', data: dates, gridIndex: 2,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#e0e4ec' } },
        axisTick: { show: false },
        axisLabel: { fontSize: 11.5, color: '#5a6478', fontWeight: 500, margin: 12 },
      },
    ],
    yAxis: [
      {
        type: 'value', gridIndex: 0, name: '',
        min: 0, max: 100, interval: 25,
        axisLabel: { fontSize: 10.5, color: '#8b94a8', formatter: '{value}' },
        splitLine: { lineStyle: { color: '#f3f5f9', type: 'dashed' } },
      },
      {
        type: 'value', gridIndex: 1,
        min: 0, max: Math.ceil(maxFp * 1.25),
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'value', gridIndex: 2,
        min: 0, max: Math.ceil(maxTotal * 1.25),
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '日精度%', type: 'line', xAxisIndex: 0, yAxisIndex: 0, smooth: true,
        data: precisions.map((p, i) => ({
          value: p,
          label: {
            show: p !== null && p !== undefined,
            position: 'top',
            distance: 4,
            fontSize: 11,
            fontWeight: 700,
            color: '#f97316',
            formatter: (p !== null && p !== undefined) ? Math.round(p) : '',
          },
        })),
        lineStyle: { color: '#f97316', width: 3 },
        itemStyle: { color: '#f97316', borderColor: '#fff', borderWidth: 2 },
        symbol: 'circle', symbolSize: 7,
        emphasis: { focus: 'series', scale: 1.3 },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#c0c6d0', type: 'dashed', width: 1.2 },
          label: { formatter: '均值 {c}%', fontSize: 10, color: '#8b94a8', position: 'insideEndTop' },
          data: [{ type: 'average', name: '均值' }],
        },
      },
      {
        name: 'FP', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: fpVals,
        itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#a5ddfb' }, { offset: 1, color: '#7dd3fc' }] }, borderRadius: [4, 4, 0, 0] },
        barWidth: 16,
        label: { show: true, position: 'top', fontSize: 11, color: '#2e9fe0', fontWeight: 700, formatter: p => p.value > 0 ? p.value : '' },
      },
      {
        name: '打标量', type: 'bar', xAxisIndex: 2, yAxisIndex: 2,
        data: totalVals,
        itemStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#d7dde8' }, { offset: 1, color: '#cbd5e1' }] }, borderRadius: [4, 4, 0, 0] },
        barWidth: 16,
        label: { show: true, position: 'top', fontSize: 11, color: '#94a3b8', fontWeight: 700, formatter: p => p.value > 0 ? fmtVol(p.value) : '' },
      },
    ],
  }
})

function getPrecColor(p) {
  if (p === null || p === undefined) return '#8b94a8'
  if (p < 50) return '#e74c3c'
  if (p < 70) return '#f39c12'
  if (p < 80) return '#facc15'
  if (p < 90) return '#16a34a'
  return '#15803d'
}

// ===== 数据洞察看板（KPI 卡下新增，真实数据 real_data_samples 聚合，不受时间窗口影响） =====
const insightCollapsed = ref(false)   // 折叠态，默认展开
const insightTab = ref('')            // 状态 Tab：默认无选中（空），点击选中，再次点击取消
const insightTabs = [
  { key: 'status', label: '状态' },
  { key: 'analyzing', label: '分析中' },
  { key: 'rule', label: '与规则沟通' },
  { key: 'dev', label: '开发/训练中' },
  { key: 'optimizing', label: '已优化/覆盖中' },
  { key: 'resolved', label: '已解决/确定达标' },
]
// 点击状态 Tab：已选中的再次点击取消（恢复无选中），否则选中
function toggleInsightTab(key) {
  insightTab.value = insightTab.value === key ? '' : key
}
// 当前选中的处理状态文案（排除「状态」分组标签），用于顶部「精度关注」右侧徽章展示
const insightTabLabel = computed(() => {
  const t = insightTabs.find(t => t.key === insightTab.value && t.key !== 'status')
  return t ? t.label : ''
})
const insightLoading = ref(false)
const insightData = ref(null)   // { trend, industryDrillDown }

// 行业置值下钻时间筛选：7/14/30/自定义（默认近7天）
const insightRange = ref('7')
const insightCustomRange = ref(false)
const insightStart = ref('')
const insightEnd = ref('')
const insightRangeOptions = [
  { v: '7', l: '7天' },
  { v: '14', l: '14天' },
  { v: '30', l: '30天' },
  { v: 'custom', l: '自定义' },
]

function setInsightRange(r) {
  if (r === 'custom') {
    insightCustomRange.value = true
    // 默认回填近7天区间（以数据最新业务日期为终点锚点，避免窗口落空）
    const d = dataMaxDate.value ? new Date(dataMaxDate.value + 'T00:00:00') : new Date()
    const p = n => String(n).padStart(2, '0')
    if (!insightEnd.value) insightEnd.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    if (!insightStart.value) {
      const s = new Date(d.getTime() - 6 * 86400000)
      insightStart.value = `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`
    }
    return
  }
  insightCustomRange.value = false
  insightRange.value = r
  loadInsight()
}
function applyInsightCustomRange() {
  if (insightStart.value && insightEnd.value) loadInsight()
}

async function loadInsight() {
  if (!route.params.id) return
  insightLoading.value = true
  try {
    const q = {}
    if (insightCustomRange.value) {
      q.start = insightStart.value || ''
      q.end = insightEnd.value || ''
    } else {
      q.days = insightRange.value
    }
    const res = await badcaseApi.dataInsight(route.params.id, q)
    insightData.value = res || null
  } catch {
    insightData.value = null
  } finally {
    insightLoading.value = false
  }
}

// 五档精度配色（数据洞察专用，方案文档色值：≥90绿 / 80-90浅绿 / 70-80黄 / 50-70橙 / <50红）
function precLevel(p) {
  if (p === null || p === undefined) return { fg: '#94a3b8', bg: '#f1f5f9' }
  if (p >= 90) return { fg: '#16A34A', bg: '#dcfce7' }
  if (p >= 80) return { fg: '#84CC16', bg: '#ecfccb' }
  if (p >= 70) return { fg: '#EAB308', bg: '#fef9c3' }
  if (p >= 50) return { fg: '#F97316', bg: '#ffedd5' }
  return { fg: '#EF4444', bg: '#fee2e2' }
}

const insightTrend = computed(() => (insightData.value && insightData.value.trend) || null)

// 周精度趋势 ECharts option（橙色折线+面积填充，W1..Wn+日期副标签，最新点高亮）
const insightTrendOption = computed(() => {
  const t = insightTrend.value
  if (!t || !Array.isArray(t.weeks) || !t.weeks.length) return {}
  const n = t.weeks.length
  const last = n - 1
  const interval = n > 10 ? 1 : 0
  return {
    grid: { left: 52, right: 30, top: 34, bottom: 46 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255,255,255,.98)',
      borderColor: '#e8ecf4', borderWidth: 1,
      padding: [10, 14],
      textStyle: { fontSize: 12, color: '#5a6478' },
      extraCssText: 'box-shadow:0 8px 30px rgba(20,30,60,.14);border-radius:12px;',
      formatter: (params) => {
        const idx = params[0]?.dataIndex
        if (idx === undefined || !t.dateRanges[idx]) return ''
        return `<div style="font-size:12px;color:#8b94a8;margin-bottom:6px;font-weight:600">${t.weeks[idx]} · ${t.dateRanges[idx]}</div>
<div style="font-size:13px">· 精度 <b style="color:#F97316;font-size:16px">${t.precision[idx]}%</b></div>
<div style="font-size:12px;color:#8b94a8;margin-top:2px">· 打标量 <b>${Number(t.total[idx] ?? 0).toLocaleString()}</b> · FP <b style="color:#e74c3c">${Number(t.fp[idx] ?? 0).toLocaleString()}</b></div>`
      },
    },
    xAxis: {
      type: 'category',
      data: t.weeks,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#e0e4ec' } },
      axisTick: { show: false },
      axisLabel: {
        interval,
        margin: 8,
        formatter: (val, idx) => `{w|${val}}\n{d|${t.dateRanges[idx] || ''}}`,
        rich: {
          w: { fontSize: 11, color: '#334155', fontWeight: 600, lineHeight: 15 },
          d: { fontSize: 7, color: '#94A3B8', lineHeight: 9 },
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0, max: 100, interval: 25,
      axisLabel: { fontSize: 11, color: '#8b94a8', formatter: '{value}%' },
      splitLine: { lineStyle: { color: '#f3f5f9', type: 'dashed' } },
    },
    series: [{
      name: '周精度%',
      type: 'line',
      smooth: false,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color: '#F97316', width: 2 },
      itemStyle: { color: '#F97316', borderColor: '#fff', borderWidth: 1.5 },
      data: t.precision.map((p, i) => ({
        value: p,
        itemStyle: i === last
          ? { color: '#F97316', borderColor: '#fff', borderWidth: 3, shadowColor: 'rgba(249,115,22,.45)', shadowBlur: 8 }
          : undefined,
        label: {
          show: true, position: 'top',
          fontSize: i === last ? 13 : 9,
          fontWeight: i === last ? 700 : 400,
          color: '#F97316',
          formatter: '{c}%',
        },
      })),
    }],
  }
})

// 行业置值下钻
const insightIndustryRows = computed(() => {
  const dd = insightData.value && insightData.value.industryDrillDown
  return (dd && Array.isArray(dd.rows)) ? dd.rows : []
})

// 每日趋势数据表行
const dailyTrendRows = computed(() => dailyTrend.value.map(p => ({
  date: p.date,
  precision: p.precision,
  tp: p.tp ?? 0,
  fp: p.fp ?? 0,
  total: p.total ?? 0,
})))

// 每日趋势数据表（转置：日期为列横轴，指标为行纵轴）
const dailyTrendTable = computed(() => {
  const rows = dailyTrendRows.value
  if (!rows.length) return []
  return [
    {
      label: '精度%',
      values: rows.map(r => ({ raw: r.precision, text: r.precision !== null && r.precision !== undefined ? r.precision + '%' : '—', color: getPrecColor(r.precision) })),
    },
    {
      label: 'TP/FP',
      values: rows.map(r => ({ raw: null, text: `${r.tp}/${r.fp}` })),
    },
    {
      label: '打标量',
      values: rows.map(r => ({ raw: null, text: r.total.toLocaleString() })),
    },
    {
      label: '漏放',
      values: rows.map(() => ({ raw: null, text: '0' })),
    },
  ]
})

// ===== 方案设计阶段：广告主ID / 审核人 / 人审标签分布（跨设备延续）=====
const designSort = useRemotePersistedRef('tagDetail:designSort', 'desc')
const designExpand = useRemotePersistedRef('tagDetail:designExpand', false)
const designSearch = useRemotePersistedRef('tagDetail:designSearch', '')

// 广告主ID分布
function distByAdvertiser() {
  const m = {}
  for (const s of fpSamples.value) {
    const k = s.advertiserId || s.uid || s.opsAdvertiserName || '未知'
    m[k] = (m[k] || 0) + 1
  }
  return Object.entries(m).map(([name, value]) => ({ name, value }))
}
const advertiserSorted = computed(() => distByAdvertiser()
  .filter(d => !designSearch.value || d.name.includes(designSearch.value.trim()))
  .sort((a, b) => designSort.value === 'desc' ? b.value - a.value : a.value - b.value))
const advertiserShown = computed(() => designExpand.value ? advertiserSorted.value : advertiserSorted.value.slice(0, COLLAPSE_N))
const advertiserOver = computed(() => advertiserSorted.value.length > COLLAPSE_N)
const advertiserOption = computed(() => barOption(advertiserShown.value, '#e879f9'))

// 审核人分布
function distByReviewer() {
  const m = {}
  for (const s of fpSamples.value) {
    const k = s.reviewerName || '未知'
    m[k] = (m[k] || 0) + 1
  }
  return Object.entries(m).map(([name, value]) => ({ name, value }))
}
const reviewerSorted = computed(() => distByReviewer()
  .filter(d => !designSearch.value || d.name.includes(designSearch.value.trim()))
  .sort((a, b) => designSort.value === 'desc' ? b.value - a.value : a.value - b.value))
const reviewerShown = computed(() => designExpand.value ? reviewerSorted.value : reviewerSorted.value.slice(0, COLLAPSE_N))
const reviewerOver = computed(() => reviewerSorted.value.length > COLLAPSE_N)
const reviewerOption = computed(() => barOption(reviewerShown.value, '#fb923c'))

// 人审标签分布（[] 或空表示"通过"，有值时按逗号拆分逐个统计）
function distByHumanTag() {
  const m = {}
  for (const s of fpSamples.value) {
    // 后端 humanTag 已去外层方括号（如 "14926" 或 "15511,15513"），aiEvaluatePolicyIds 保留原始格式（如 "[14926]"）
    // 统一去方括号后判断
    const raw = s.humanTag || s.aiEvaluatePolicyIds || ''
    const cleaned = String(raw).replace(/[\[\]\s]/g, '')
    if (!cleaned) {
      m['通过'] = (m['通过'] || 0) + 1
    } else {
      const tags = cleaned.split(/[,，]/).filter(Boolean)
      for (const t of tags) {
        m[t] = (m[t] || 0) + 1
      }
    }
  }
  return Object.entries(m).map(([name, value]) => ({ name, value }))
}
const humanTagSorted = computed(() => distByHumanTag()
  .filter(d => !designSearch.value || d.name.includes(designSearch.value.trim()))
  .sort((a, b) => designSort.value === 'desc' ? b.value - a.value : a.value - b.value))
const humanTagShown = computed(() => designExpand.value ? humanTagSorted.value : humanTagSorted.value.slice(0, COLLAPSE_N))
const humanTagOver = computed(() => humanTagSorted.value.length > COLLAPSE_N)
const humanTagOption = computed(() => barOption(humanTagShown.value, '#38bdf8'))

function barOption(data, color) {
  return {
    grid: { left: 8, right: 30, top: 10, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: '#fff', borderColor: '#eef1f6', borderWidth: 1, padding: [8, 12],
      textStyle: { color: '#5a6478', fontSize: 12 },
      extraCssText: 'box-shadow:0 6px 24px rgba(20,30,60,.12);border-radius:10px;',
    },
    xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f0f2f6' } }, axisLabel: { color: '#8b94a8' } },
    yAxis: { type: 'category', inverse: true, data: data.map(d => d.name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#5a6478' } },
    series: [{ type: 'bar', barWidth: 12, data: data.map(d => d.value), itemStyle: { color, borderRadius: [0, 6, 6, 0] }, label: { show: true, position: 'right', color: '#5a6478', fontSize: 11, fontWeight: 600 } }],
  }
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <div class="ph-main">
        <button class="back" @click="goBack" title="返回"><Icon name="back" :size="18" /></button>
        <span class="ph-ic"><Icon name="analysis" :size="24" /></span>
        <div>
          <h1 class="tag-id">{{ tag.id }}<span class="badge" :class="`badge-${curStatus.cls}`">{{ curStatus.label }}</span><span v-if="insightTabLabel" class="badge badge-purple" :title="'当前处理状态：' + insightTabLabel">{{ insightTabLabel }}</span></h1>
          <div class="tag-name-row"><span class="tag-name">{{ tag.name }}</span></div>
        </div>
      </div>
    </div>

    <!-- 概况：三卡并列（近7天口径） -->
    <div class="overview">
      <div class="card kpi-card rise">
        <span class="mk-ic" style="background:var(--brand-soft);color:var(--brand)"><Icon name="precision" :size="20" /></span>
        <div><em>标签精度</em><b :style="{ color: curStatus.color }">{{ curPrecision }}<small>%</small></b>
          <span v-if="kpiChange.precisionChange" class="mk-chg" :class="chgCls(kpiChange.precisionChange)">
            {{ chgArrow(kpiChange.precisionChange) }}{{ chgText(kpiChange.precisionChange) }}
            <i v-if="kpiChange.changePeriod">· 近7天 {{ kpiChange.changePeriod }}</i>
          </span>
        </div>
      </div>
      <div class="card kpi-card rise">
        <span class="mk-ic" style="background:var(--brand-soft);color:var(--brand)"><Icon name="sample" :size="20" /></span>
        <div><em>整体样本数</em><b>{{ curTotal }}</b>
          <span v-if="kpiChange.changePeriod" class="mk-chg" :class="kpiChange.sampleChange ? chgCls(kpiChange.sampleChange) : 'up'">
            <template v-if="kpiChange.sampleChange">{{ chgArrow(kpiChange.sampleChange) }}{{ chgText(kpiChange.sampleChange) }}</template>
            <i>· 近7天 {{ kpiChange.changePeriod }}</i>
          </span>
        </div>
      </div>
      <div class="card kpi-card rise">
        <span class="mk-ic" style="background:var(--red-soft);color:var(--red)"><Icon name="fpcount" :size="20" /></span>
        <div><em>FP</em><b class="red">{{ curFp }}</b>
          <span v-if="kpiChange.changePeriod" class="mk-chg" :class="kpiChange.fpChange ? chgCls(kpiChange.fpChange) : 'up'">
            <template v-if="kpiChange.fpChange">{{ chgArrow(kpiChange.fpChange) }}{{ chgText(kpiChange.fpChange) }}</template>
            <i>· 近7天 {{ kpiChange.changePeriod }}</i>
          </span>
        </div>
      </div>
    </div>

    <!-- 周精度趋势看板 -->
    <div class="card rise insight-card">
      <div class="insight-hd" @click="insightCollapsed = !insightCollapsed">
        <div class="insight-hd-left">
          <span class="insight-hd-ic">📊</span>
          <h3>周精度趋势</h3>
        </div>
        <button class="insight-collapse" :title="insightCollapsed ? '展开' : '收起'">
          <Icon :name="insightCollapsed ? 'chevronDown' : 'chevronUp'" :size="16" />
        </button>
      </div>

      <template v-if="!insightCollapsed">
        <!-- Tab 导航（纯 UI 切换，点击选中/再点取消，不接数据过滤） -->
        <div class="insight-tabs">
          <button
            v-for="t in insightTabs"
            :key="t.key"
            class="insight-tab"
            :class="{ active: insightTab === t.key }"
            @click="toggleInsightTab(t.key)"
          >{{ t.label }}</button>
        </div>

        <!-- 主体：周精度趋势（左 65%）+ 行业置信下钻（右 35%） -->
        <div class="insight-body">
          <div class="insight-grid">
            <div class="insight-chart-col">
              <div v-if="insightLoading" class="insight-loading">数据加载中…</div>
              <template v-else>
                <div class="insight-chart" v-if="insightTrend && insightTrend.weeks.length">
                  <EChart :option="insightTrendOption" height="290px" />
                </div>
                <div v-else class="insight-empty">
                  <Icon name="chart" :size="20" />
                  <span>暂无精度趋势数据</span>
                </div>
              </template>
            </div>
            <div class="insight-drill-col">
              <div class="dt-insight-hd">
                <h4>行业置信下钻</h4>
                <div class="dt-insight-filters">
                  <div class="dt-range">
                    <button
                      v-for="r in insightRangeOptions"
                      :key="r.v"
                      class="dt-range-btn"
                      :class="{ active: (r.v === 'custom') ? insightCustomRange : (!insightCustomRange && insightRange === r.v) }"
                      @click="setInsightRange(r.v)"
                    >{{ r.l }}</button>
                  </div>
                  <div class="dt-range-custom" v-if="insightCustomRange">
                    <input type="date" v-model="insightStart" class="dt-date-input" @change="applyInsightCustomRange" />
                    <span class="dt-range-sep">至</span>
                    <input type="date" v-model="insightEnd" class="dt-date-input" @change="applyInsightCustomRange" />
                  </div>
                </div>
              </div>
              <div class="dt-insight-table-wrap">
                <table class="dt-insight-table">
                  <thead>
                    <tr><th>行业</th><th>元素</th><th>精度</th><th>误杀</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, i) in insightIndustryRows" :key="i">
                      <td class="di-ind" :title="r.industry">{{ r.industry }}</td>
                      <td class="di-elem">{{ r.elementType }}</td>
                      <td class="di-prec"><b :style="{ color: precLevel(r.precision).fg }">{{ r.precision.toFixed(1) }}%</b></td>
                      <td class="di-fp mono">{{ r.fpCount.toLocaleString() }}</td>
                    </tr>
                    <tr v-if="!insightIndustryRows.length">
                      <td colspan="4" class="di-empty">暂无行业数据</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 每日精度趋势图 -->
    <div class="card rise daily-trend-card" v-if="dailyTrend.length">
      <!-- 卡片头部 -->
      <div class="dt-hd">
        <div class="dt-hd-left">
          <span class="dt-hd-ic"><Icon name="chart" :size="17" /></span>
          <div class="dt-hd-titles">
            <h3>每日精度 &amp; TP/FP 趋势</h3>
            <span class="dt-sub">AI评测·近{{ dailyCustomRange ? (dailyStart?.slice(5) || '—') + ' ~ ' + (dailyEnd?.slice(5) || '—') : dailyRange + '天' }}</span>
          </div>
        </div>
        <div class="dt-hd-right">
          <!-- 时间粒度切换：7 / 14 / 30 / 自定义 -->
          <div class="dt-range">
            <button
              v-for="r in dailyRangeOptions"
              :key="r.v"
              class="dt-range-btn"
              :class="{ active: (r.v === 'custom') ? dailyCustomRange : (!dailyCustomRange && dailyRange === r.v) }"
              @click="setDailyRange(r.v)"
            >{{ r.l }}</button>
          </div>
          <!-- 自定义时间区间 -->
          <div class="dt-range-custom" v-if="dailyCustomRange">
            <input type="date" v-model="dailyStart" class="dt-date-input" @change="applyDailyCustomRange" />
            <span class="dt-range-sep">至</span>
            <input type="date" v-model="dailyEnd" class="dt-date-input" @change="applyDailyCustomRange" />
          </div>
          <div class="cf-select">
            <select v-model="dailyIndustryL1" @change="dailyIndustryL2 = ''">
              <option value="">全部行业</option>
              <option v-for="ind in dailyIndustryOptions" :key="ind" :value="ind">{{ ind }}</option>
            </select>
            <Icon name="chevronDown" :size="14" />
          </div>
          <div class="cf-select">
            <select v-model="dailyIndustryL2" :disabled="!dailyIndustryL1 || !dailyIndustryL2Options.length">
              <option value="">全部二级行业</option>
              <option v-for="ind in dailyIndustryL2Options" :key="ind" :value="ind">{{ ind }}</option>
            </select>
            <Icon name="chevronDown" :size="14" />
          </div>
          <div class="cf-select">
            <select v-model="dailyElementType">
              <option value="">全部元素</option>
              <option value="ELEMENT_TYPE_IMAGE">图片</option>
              <option value="ELEMENT_TYPE_VIDEO">视频</option>
              <option value="ELEMENT_TYPE_TEXT">文本</option>
              <option value="ELEMENT_TYPE_URL">落地页</option>
            </select>
            <Icon name="chevronDown" :size="14" />
          </div>
        </div>
      </div>

      <!-- 图例区：主图例 + 事件图例（与图片一致，位于图表上方） -->
      <div class="dt-legend">
        <span class="dt-legend-item main"><i class="dt-lg-line"></i>日精度%</span>
        <span class="dt-legend-item main"><i class="dt-lg-bar fp"></i>FP</span>
        <span class="dt-legend-item main"><i class="dt-lg-bar vol"></i>打标量</span>
        <span class="dt-legend-divider"></span>
        <span class="dt-legend-item off"><i class="dt-lg-dot img"></i>图片模型发布</span>
        <span class="dt-legend-item off"><i class="dt-lg-dot txt"></i>文本模型发布</span>
        <span class="dt-legend-item off"><i class="dt-lg-dot vid"></i>视频模型发布</span>
        <span class="dt-legend-item off"><i class="dt-lg-rule"></i>规则变更</span>
        <span class="dt-legend-tip">▷ 当天有模型发布（事件数据接入中）</span>
      </div>

      <!-- 图表（全宽，三面板纵向分区） -->
      <div class="dt-body">
        <div class="dt-chart">
          <EChart :option="dailyTrendOption" height="340px" />
        </div>
      </div>

      <!-- 数据表（转置：日期为横轴列，指标为纵轴行） -->
      <div class="daily-table-wrap">
        <table class="daily-table daily-table-t">
          <thead>
            <tr>
              <th class="dt-metric-hd"></th>
              <th v-for="r in dailyTrendRows" :key="r.date">{{ r.date?.slice(5)?.replace(/-/g, '/') || '—' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dailyTrendTable" :key="row.label">
              <td class="dt-metric">{{ row.label }}</td>
              <td
                v-for="(c, i) in row.values"
                :key="i"
                :class="{ 'dt-prec-cell': row.label === '精度%' }"
              >
                <template v-if="row.label === '精度%'">
                  <div class="dt-prec">
                    <b :style="{ color: c.color }">{{ c.text }}</b>
                    <span class="dt-prec-bar"><i :style="{ width: (c.raw || 0) + '%', background: c.color }"></i></span>
                  </div>
                </template>
                <template v-else>
                  <span class="mono">{{ c.text }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 脚注说明 -->
      <div class="dt-footer">
        <span>精度=TP/(TP+FP)；FP=机审误报（人审未打）；打标量=当日初审机审拒绝量（随行业/元素筛选）；漏放=FN。灰点=当天该标签无模型评测；▷=当天有模型发布，悬浮看模态与数据分区。</span>
      </div>
    </div>

    <!-- 分布图（5 图统一模块：行业 / 元素类型 / 审核人 / 人审标签 / 广告主ID） -->
    <div class="charts-hd"><span class="charts-hd-bar"></span><Icon name="alert" :size="16" /><span>误杀维度下钻</span></div>
    <div class="charts">
      <div class="card ch rise" style="grid-column: span 2;">
        <div class="ch-hd">
          <h3>AMS 行业分布</h3>
          <div class="ch-tools">
            <div class="ch-search">
              <Icon name="search" :size="13" />
              <input v-model="indSearch" placeholder="搜索行业" />
            </div>
            <button class="ch-sort" @click="indSort = indSort === 'desc' ? 'asc' : 'desc'">
              <Icon name="chart" :size="13" />{{ indSort === 'desc' ? '降序' : '升序' }}
            </button>
          </div>
        </div>
        <div class="bar-wrap"><EChart :option="industryOption" height="100%" /></div>
        <button v-if="indOver" class="ch-more" @click="indExpand = !indExpand">
          {{ indExpand ? '收起' : `展开全部 ${indSorted.length} 项` }}<Icon :name="indExpand ? 'chevronUp' : 'chevronDown'" :size="13" />
        </button>
      </div>
      <div class="card ch ch-pie rise"><h3>元素类型分布</h3><div class="pie-wrap"><EChart :option="typePie" height="300px" /></div></div>

      <div class="card ch rise">
        <div class="ch-hd">
          <h3>审核人分布</h3>
          <div class="ch-tools">
            <div class="ch-search">
              <Icon name="search" :size="13" />
              <input v-model="designSearch" placeholder="搜索" />
            </div>
            <button class="ch-sort" @click="designSort = designSort === 'desc' ? 'asc' : 'desc'">
              <Icon name="chart" :size="13" />{{ designSort === 'desc' ? '降序' : '升序' }}
            </button>
          </div>
        </div>
        <div class="bar-wrap"><EChart :option="reviewerOption" height="100%" /></div>
        <button v-if="reviewerOver" class="ch-more" @click="designExpand = !designExpand">
          {{ designExpand ? '收起' : `展开全部 ${reviewerSorted.length} 项` }}<Icon :name="designExpand ? 'chevronUp' : 'chevronDown'" :size="13" />
        </button>
      </div>
      <div class="card ch rise">
        <div class="ch-hd">
          <h3>人审标签分布</h3>
          <div class="ch-tools">
            <div class="ch-search">
              <Icon name="search" :size="13" />
              <input v-model="designSearch" placeholder="搜索" />
            </div>
            <button class="ch-sort" @click="designSort = designSort === 'desc' ? 'asc' : 'desc'">
              <Icon name="chart" :size="13" />{{ designSort === 'desc' ? '降序' : '升序' }}
            </button>
          </div>
        </div>
        <div class="bar-wrap"><EChart :option="humanTagOption" height="100%" /></div>
        <button v-if="humanTagOver" class="ch-more" @click="designExpand = !designExpand">
          {{ designExpand ? '收起' : `展开全部 ${humanTagSorted.length} 项` }}<Icon :name="designExpand ? 'chevronUp' : 'chevronDown'" :size="13" />
        </button>
      </div>
      <div class="card ch rise">
        <div class="ch-hd">
          <h3>广告主ID分布</h3>
          <div class="ch-tools">
            <div class="ch-search">
              <Icon name="search" :size="13" />
              <input v-model="designSearch" placeholder="搜索" />
            </div>
            <button class="ch-sort" @click="designSort = designSort === 'desc' ? 'asc' : 'desc'">
              <Icon name="chart" :size="13" />{{ designSort === 'desc' ? '降序' : '升序' }}
            </button>
          </div>
        </div>
        <div class="bar-wrap"><EChart :option="advertiserOption" height="100%" /></div>
        <button v-if="advertiserOver" class="ch-more" @click="designExpand = !designExpand">
          {{ designExpand ? '收起' : `展开全部 ${advertiserSorted.length} 项` }}<Icon :name="designExpand ? 'chevronUp' : 'chevronDown'" :size="13" />
        </button>
      </div>
    </div>

    <!-- 明细表（元素 / 聚类簇 融合视图） -->
    <div class="card table-card rise">
      <div class="tc-bar">
        <div class="tc-bar-top">
          <div class="seg-mini tc-mode" v-tip="'聚类簇 = 明细样本按 class_id 聚合的簇视图；元素 = 逐条素材明细'">
            <button :class="{ on: detailView==='cluster' }" @click="detailView='cluster'"><Icon name="tags" :size="13" />聚类簇</button>
            <button :class="{ on: detailView==='element' }" @click="detailView='element'"><Icon name="grid" :size="13" />元素</button>
          </div>
          <span class="tc-mode-count" v-if="detailView==='cluster'">共 {{ displayClusterGroups.length }} 簇 · {{ displayClusterGroups.reduce((s, c) => s + c.total, 0) }} 素材</span>
          <div class="watch-seg" v-tip="'关注维度筛选：全部 / 只看已关注簇 / 只看已关注元素'">
            <button class="watch-seg-btn" :class="{ on: watchFilter==='' }" @click="watchFilter=''">全部</button>
            <button class="watch-seg-btn" :class="{ on: watchFilter==='cluster' }" @click="watchFilter='cluster'"><Icon name="star" :size="12" />我的簇关注<span v-if="watchedClusters.length" class="watch-seg-cnt">{{ watchedClusters.length }}</span></button>
            <button class="watch-seg-btn" :class="{ on: watchFilter==='element' }" @click="watchFilter='element'"><Icon name="star" :size="12" />我的元素关注<span v-if="watchedElements.length" class="watch-seg-cnt">{{ watchedElements.length }}</span></button>
          </div>
          <!-- 图三独立时间筛选：单独控制审核判定统计 + 明细列表（默认近7天） -->
          <div class="dt-range tc-verify-range">
            <button
              v-for="r in verifyRangeOptions"
              :key="r.v"
              class="dt-range-btn"
              :class="{ active: (r.v === 'custom') ? verifyCustomRange : (!verifyCustomRange && verifyRange === r.v) }"
              @click="setVerifyRange(r.v)"
            >{{ r.l }}</button>
          </div>
          <div class="dt-range-custom" v-if="verifyCustomRange">
            <input type="date" v-model="verifyStart" class="dt-date-input" @change="loadDetailSamples" />
            <span class="dt-range-sep">至</span>
            <input type="date" v-model="verifyEnd" class="dt-date-input" @change="loadDetailSamples" />
          </div>
          <span v-if="detailLoading" class="tc-verify-loading">加载中…</span>
        </div>

        <!-- 通用筛选 chips（聚类簇 / 元素 共用） -->
        <div class="chips-row">
          <div class="seg-mini" v-tip="'切换明细展示方式：列表 / 卡片'">
            <button :class="{ on: isListMode }" @click="setListCard('list')"><Icon name="list" :size="13" />列表</button>
            <button :class="{ on: !isListMode }" @click="setListCard('card')"><Icon name="grid" :size="13" />卡片</button>
          </div>
          <div v-if="isCardMode" class="cols-pick">
            <span>行数</span>
            <button v-for="n in [1,4]" :key="n" :class="{ on: cols===n }" @click="cols=n">{{ n }}</button>
            <button :class="{ on: cols==='custom' }" @click="cols='custom'">自定义</button>
            <input v-if="cols==='custom'" class="col-inp" type="number" min="1" max="12" v-model="customCols" />
          </div>
          <div class="chips-group">
            <div class="chips">
              <button v-for="t in types" :key="t" class="chip" :class="{ on: typeFilter===t }" @click="setType(t)">
                {{ t }}<b>{{ typeCount(t) }}</b>
              </button>
            </div>
          </div>
          <div class="chips-group">
            <div class="chips">
              <button v-for="o in verifyOptions" :key="o.key" class="chip" :class="['v-'+o.key, { on: verifyFilter===o.key }]" @click="setVerify(o.key)">
                {{ o.label }}<b>{{ verifyCount(o.key) }}</b>
              </button>
            </div>
          </div>
          <div class="chips-group dims-group">
            <div class="dim-sels">
              <div class="ind-sel">
                <span class="ind-lb">一级行业</span>
                <select class="ind-dd" :value="industryL1Filter" @change="setIndustryL1($event.target.value)">
                  <option v-for="o in industryL1Options" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="ind-sel">
                <span class="ind-lb">二级行业</span>
                <select class="ind-dd" :value="industryL2Filter" :disabled="industryL2Options.length <= 1" @change="setIndustryL2($event.target.value)">
                  <option v-for="o in industryL2Options" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="ind-sel">
                <span class="ind-lb">审核人</span>
                <select class="ind-dd" :value="reviewerFilter" @change="setReviewer($event.target.value)">
                  <option v-for="o in reviewerOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="ind-sel">
                <span class="ind-lb">广告主ID</span>
                <select class="ind-dd" :value="advertiserIdFilter" @change="setAdvertiser($event.target.value)">
                  <option v-for="o in advertiserIdOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="ind-sel">
                <span class="ind-lb">人审标签</span>
                <select class="ind-dd" :value="humanTagFilter" @change="setHumanTag($event.target.value)">
                  <option v-for="o in humanTagTypes" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
            </div>
            <!-- 图三按钮组：全选 / 只看标注 / 重置筛选（人审标签筛选右侧） -->
            <div class="filter-ops">
              <button class="sel-btn" @click="toggleAll"><Icon name="check" :size="14" />{{ allChecked ? '取消全选' : '全选' }}</button>
              <button class="mode-btn" :class="{ on: onlyAnnotated }" @click="onlyAnnotated = !onlyAnnotated"><Icon name="edit" :size="14" />{{ onlyAnnotated ? '只看标注中' : '只看标注' }}</button>
              <button class="mode-btn reset-btn" @click="resetFilters" v-tip="'重置全部筛选条件'"><Icon name="refresh" :size="14" />重置筛选</button>
            </div>
          </div>
        </div>
        <!-- 元素视图：操作栏已移除（行首勾选框选中后可直接下载/提需） -->
      </div>

      <!-- 聚类簇视图：列表 / 卡片（与元素视图同一份 samples 数据） -->
      <template v-if="detailView==='cluster'">
        <div v-if="!clusterGroups.length" class="cluster-empty">暂无聚类簇数据（该标签明细中未匹配到 class_id 以 c 开头的聚类）</div>
        <div v-else-if="watchFilter && !displayClusterGroups.length" class="cluster-empty">{{ watchFilter === 'cluster' ? '暂无关注的簇，点击簇前方的星形图标即可加入关注' : '暂无关注的元素，点击元素前方的星形图标即可加入关注' }}</div>

        <!-- 列表模式：行式簇列表（带列名表头） -->
        <div v-else-if="clusterViewMode==='list'" class="cluster-list">
          <div class="cr-head">
            <span class="cr-h cr-h-watch"></span>
            <label class="cbx cr-cbx cr-h-cbx" :class="{ on: allClustersChecked }" @click.stop="toggleAllClusters" :title="allClustersChecked ? '取消全选所有簇' : '全选所有簇'"><Icon v-if="allClustersChecked" name="check" :size="12" /></label>
            <span class="cr-h cr-h-preview">预览</span>
            <span class="cr-h cr-h-cid">聚类ID</span>
            <span class="cr-h cr-h-total">簇数量</span>
            <span class="cr-h cr-h-precision">簇精度</span>
            <span class="cr-h cr-h-compose">聚合量构成</span>
            <span class="cr-h cr-h-tags">机审标签</span>
            <span class="cr-h cr-h-tags">人审标签</span>
            <span class="cr-h cr-h-ind">一级行业/二级行业</span>
            <span class="cr-h cr-h-adv">广告主</span>
            <span class="cr-h cr-h-caret"></span>
          </div>
          <div v-for="c in pagedClusterGroups" :key="c.classId" class="cluster-row" :class="{ open: expandedCluster === c.classId }">
            <div class="cr-main" @click="toggleClusterExpand(c.classId)">
              <!-- 关注：点击加入/移出我的关注，加入后自动切到只看关注 -->
              <button class="cr-watch" :class="{ on: isWatchedCluster(c.classId) }" :title="isWatchedCluster(c.classId) ? '取消关注' : '加入我的关注'" @click.stop="toggleWatchCluster(c.classId)"><Icon name="star" :size="14" /></button>
              <!-- 第一列：选择（勾选后可直接下载/提需，无需进入选择模式） -->
              <label class="cbx cr-cbx" :class="{ on: clusterChecked[c.classId] }" @click.stop="toggleClusterCheck(c)"><Icon v-if="clusterChecked[c.classId]" name="check" :size="12" /></label>
              <!-- 第二列：预览（审核元素值 = 簇代表素材；文本素材直接显示文本） -->
              <div class="cr-preview" :class="{ 'cr-preview-text': c.preview && c.preview.isText }">
                <div v-if="c.preview && c.preview.isText" class="cr-text" :title="c.preview.elementValue">{{ c.preview.elementValue }}</div>
                <VideoPlayer v-else-if="c.preview && c.preview.isVideo && isEmbeddableMedia(c.preview.elementValue)" :src="c.preview.elementValue" :raw-url="c.preview.elementValue" />
                <img v-else-if="c.preview && isEmbeddableMedia(c.preview.elementValue)" v-lazy-img :data-src="c.preview.elementValue" :data-raw-url="c.preview.elementValue" referrerpolicy="no-referrer" @error="onMediaError" alt="" />
                <Icon v-else-if="c.preview" name="link" :size="18" />
                <span v-if="c.preview && c.preview.isText" class="cr-pv-type">T</span>
                <span v-else-if="c.preview" class="cr-pv-type">{{ c.preview.isVideo ? 'V' : 'I' }}</span>
              </div>
              <!-- 聚类ID -->
              <div class="cr-cid" :title="c.classId">{{ c.classId }}</div>
              <!-- 簇数量 -->
              <div class="cr-total"><b>{{ c.total }}</b><em>素材</em></div>
              <!-- 簇精度：簇内一致数量 ÷ (一致 + 误杀)，不随数据源（全部/一致/漏放/误杀）变化 -->
              <div class="cr-precision" :title="clusterPrecisionTip(c)">
                <b :class="{ 'prec-empty': c.clusterPrecision === null || c.clusterPrecision === undefined }">{{ c.clusterPrecision === null || c.clusterPrecision === undefined ? '—' : c.clusterPrecision + '%' }}</b>
                <em>簇精度</em>
              </div>
              <!-- 聚合量构成：机审占比 / 人审占比 / 人审通过占比（三色条） -->
              <div class="cr-compose">
                <div class="cc-bars">
                  <span v-for="b in clusterPctBars(c)" :key="b.key" class="cc-bar" :title="`${b.label} ${b.pct}%`">
                    <i :style="{ width: Math.min(b.pct, 100) + '%', background: b.color }"></i>
                  </span>
                </div>
                <div class="cc-lbls">
                  <span v-for="b in clusterPctBars(c)" :key="b.key" class="cc-lbl"><i :style="{ background: b.color }"></i>{{ b.label }} {{ b.pct }}%</span>
                </div>
              </div>
              <!-- 机审标签 -->
              <div class="cr-tags">
                <span v-for="t in clusterTagList(c.machineTags).slice(0, 3)" :key="t.id" class="ct-tag ct-machine" :title="`${t.name} · ${t.count} 个 · ${t.pct}%`">{{ t.name }}</span>
                <span v-if="!c.machineTags || !c.machineTags.length" class="ct-empty">—</span>
              </div>
              <!-- 人审标签 -->
              <div class="cr-tags">
                <span v-for="t in clusterTagList(c.humanTags).slice(0, 3)" :key="t.id" class="ct-tag ct-human" :title="`${t.name} · ${t.count} 个 · ${t.pct}%`">{{ t.name }}</span>
                <span v-if="!c.humanTags || !c.humanTags.length" class="ct-empty">—</span>
              </div>
              <!-- 一级行业/二级行业（数量占比） -->
              <div class="cr-ind">
                <span v-for="ind in (c.industries || []).slice(0, 2)" :key="ind.name" class="cr-ind-item" :title="`${ind.name} · ${ind.count} 个 · ${ind.pct}%`">{{ ind.name }}<em>{{ ind.pct }}%</em></span>
                <span v-if="!c.industries || !c.industries.length" class="ct-empty">—</span>
              </div>
              <!-- 广告主 -->
              <div class="cr-adv">
                <span v-for="a in (c.advertisers || []).slice(0, 2)" :key="a.name" class="cr-adv-item" :title="`${a.name} · ${a.count} 个`">{{ a.name }}</span>
                <span v-if="!c.advertisers || !c.advertisers.length" class="ct-empty">—</span>
              </div>
              <span class="cr-caret"><Icon :name="expandedCluster === c.classId ? 'chevronUp' : 'chevronDown'" :size="14" /></span>
            </div>
            <!-- 点击行 → 下拉出该簇下的元素素材（复用元素视图的列表/卡片呈现，含行数） -->
            <div v-if="expandedCluster === c.classId" class="cr-body">
              <div class="cr-body-hd">
                <span>簇 {{ c.classId }} · 共 {{ c.elements.length }} 个素材</span>
                <div v-if="c.elements.length > CLUSTER_PAGE_SIZE" class="cr-pager">
                  <button class="cr-page-btn" :disabled="clusterPageNo(c) <= 1" @click.stop="clusterPagePrev(c)">&#8249;</button>
                  <span class="cr-page-info">{{ clusterPageNo(c) }} / {{ clusterPageCount(c) }}</span>
                  <button class="cr-page-btn" :disabled="clusterPageNo(c) >= clusterPageCount(c)" @click.stop="clusterPageNext(c)">&#8250;</button>
                </div>
                <button v-if="c.elements.length" class="btn btn-soft btn-xs" @click.stop="clearClusterCheck(c.classId)">清除本簇勾选</button>
              </div>
              <!-- 簇特征（可编辑文字总结）：行业/审核员/人审标签/广告主/套路，一条文字概述 -->
              <div v-if="c.elements.length" class="cluster-feature">
                <div class="cf-summary">
                  <div class="cf-summary-hd">
                    <span class="cf-label">簇特征总结（可编辑）</span>
                    <button class="btn btn-ghost btn-xs" :disabled="clusterFeatureGenerating[c.classId]" @click.stop="generateClusterSummary(c)">{{ clusterFeatureGenerating[c.classId] ? '生成中…' : 'AI 生成' }}</button>
                  </div>
                  <template v-if="clusterFeatureDraft[c.classId] !== undefined">
                    <textarea class="cf-textarea" v-autosize v-model="clusterFeatureDraft[c.classId]" rows="2" placeholder="根据簇内素材 OCR/ASR 总结套路，可手动编辑"></textarea>
                    <div class="cf-summary-btns">
                      <button class="btn btn-primary btn-xs" :disabled="clusterFeatureSaving[c.classId]" @click.stop="saveClusterFeature(c)">{{ clusterFeatureSaving[c.classId] ? '保存中…' : '保存' }}</button>
                      <button class="btn btn-ghost btn-xs" @click.stop="cancelFeatureEdit(c)">取消</button>
                    </div>
                  </template>
                  <template v-else>
                    <div v-if="featureSummaryOf(c)" class="cf-summary-text" @click.stop="startFeatureEdit(c)" :title="'点击编辑套路总结'">{{ featureSummaryOf(c) }}</div>
                    <div v-else class="cf-summary-empty" @click.stop="startFeatureEdit(c)">点击「AI 生成」或此处填写套路总结</div>
                  </template>
                </div>
              </div>
              <div v-if="!c.elements.length" class="cr-empty">该簇暂无素材明细</div>
              <!-- 元素粒度 · 列表（表格，与元素视图一致） -->
              <div v-else-if="viewMode==='table'" class="tbl-wrap">
                <table class="tbl">
                  <thead>
                    <tr>
                      <th class="ck"></th>
                      <th class="media-col">审核元素值</th>
                      <th>OCR内容</th>
                      <th>ASR内容</th>
                      <th>审核标签ID</th>
                      <th>AI评测人审标签</th>
                      <th>AMS 一级行业</th>
                      <th>AMS 二级行业</th>
                      <th>审核员</th>
                      <th>广告主ID</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" :class="{ sel: selected.has(s.id) }">
                      <td class="ck"><label class="cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label></td>
                      <td class="media-col">
                        <div class="media-preview-cell">
                          <div class="mp-thumb" @click.stop="onThumbClick(s)">
                            <div v-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                              <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                              <button v-if="!cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                            </div>
                            <a v-else-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" />视频加载失败，打开原链接</a>
                            <img v-else-if="isEmbeddableMedia(s.mediaUrl)" v-lazy-img :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" referrerpolicy="no-referrer" @error="onMediaError" />
                            <Icon v-else name="link" :size="20" />
                          </div>
                          <div class="mp-info">
                            <a v-if="isEmbeddableMedia(s.mediaUrl)" class="mp-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl">
                              {{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}
                            </a>
                            <span v-else-if="s.mediaUrl" class="mp-link" :title="s.mediaUrl">{{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}</span>
                            <span v-else class="mp-link">—</span>
                            <span v-if="s.dcId" class="mp-dcid">创意ID：{{ s.dcId }}</span>
                            <span v-if="s.elementFingerprint" class="mp-fp" :title="s.elementFingerprint">指纹：{{ s.elementFingerprint.length > 20 ? s.elementFingerprint.slice(0, 20) + '…' : s.elementFingerprint }}</span>
                          </div>
                        </div>
                      </td>
                      <td class="expand-cell">
                        <div v-if="s.ocrContent" class="ocr-full">{{ s.ocrContent }}</div>
                        <span v-else class="muted">—</span>
                      </td>
                      <td class="expand-cell">
                        <div v-if="s.asrContent" class="ocr-full">{{ s.asrContent }}</div>
                        <span v-else class="muted">—</span>
                      </td>
                      <td><span class="mtag">{{ s.machineTag }}</span></td>
                      <td><span class="htag">{{ s.humanTag && String(s.humanTag).replace(/[\[\]]/g, '').trim() ? s.humanTag : '通过' }}</span></td>
                      <td>{{ s.firstLevelIndustryName || '—' }}</td>
                      <td>{{ s.secondLevelIndustryName || '—' }}</td>
                      <td>{{ s.reviewerName || '—' }}</td>
                      <td>{{ s.advertiserId || s.uid || '—' }}</td>
                      <td class="remark-cell"><MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" compact readonly hide-when-empty /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <!-- 元素粒度 · 卡片（行数跟随 activeCols，与元素视图一致） -->
              <div v-else class="cards" :class="{ single: activeCols===1 }" :style="activeCols > 1 ? { gridTemplateColumns: `repeat(${activeCols}, minmax(0, 1fr))` } : {}">
                <template v-if="activeCols===1">
                  <div v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" class="mcard card" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
                    <div class="m-media" :class="{ 'm-media-text': isCardText(s) }" @click.stop>
                      <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
                      <template v-if="isCardText(s)">
                        <span v-if="s.verifyStatus" class="mp-verify-badge" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                        <div class="m-text-bold">{{ s.mediaUrl || '（无文本内容）' }}</div>
                      </template>
                      <template v-else>
                        <div class="mc-type-group mc-type-group-lg">
                          <span class="m-type" :class="isVideoByUrl(s.mediaUrl) ? 'vid' : 'img'"><Icon :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="11" />{{ cardTypeText(s) }}</span>
                          <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                        </div>
                        <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                          <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                        </div>
                        <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                        <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />视频加载失败，打开原链接</a>
                        <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
                        <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />打开原链接</a>
                      </template>
                    </div>
                    <div class="m-body">
                      <div class="m-head" style="cursor:pointer">
                        <span class="mh-dot" :class="verifyBadge(s).cls"></span>
                        <span class="mh-id">{{ s.id }}</span>
                        <span class="mh-type">{{ cardTypeText(s) }}</span>
                        <span class="mh-ind" v-if="s.firstLevelIndustryName || s.secondLevelIndustryName">{{ s.firstLevelIndustryName }}<template v-if="s.secondLevelIndustryName"> / {{ s.secondLevelIndustryName }}</template></span>
                      </div>
                      <div class="m-tags" @click.stop>
                        <span class="mt-tag mt-machine" v-if="s.machineTag">机审: {{ s.machineTag }}</span>
                        <span class="mt-tag mt-human">人审: {{ humanTagText(s) }}</span>
                        <span class="mt-tag mt-reviewer" v-if="s.reviewerName">审核人: {{ s.reviewerName }}</span>
                        <span class="mt-tag mt-adid">广告主ID: {{ s.advertiserId || s.uid || '无' }}</span>
                        <span class="mt-tag mt-dcid" v-if="s.dcId">DCID: {{ s.dcId }}</span>
                        <span class="mt-tag mt-fp" v-if="s.elementFingerprint" :title="s.elementFingerprint">审核物理指纹（md5）: {{ s.elementFingerprint.length > 12 ? s.elementFingerprint.slice(0, 12) + '…' : s.elementFingerprint }}</span>
                        <a v-if="s.mediaUrl" class="mt-tag mt-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" />原文链接</a>
                      </div>
                      <div class="m-section" v-if="!isCardText(s)" @click.stop>
                        <div class="ms-hd clickable" @click="toggleCardSection(s, 'ocr')">OCR 内容<Icon :name="cardSectionOpen(s, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                        <div class="ms-body" :class="{ muted: !s.ocrContent, collapsed: !cardSectionOpen(s, 'ocr') }">{{ s.ocrContent || '—' }}</div>
                      </div>
                      <div class="m-section" v-if="!isCardText(s)" @click.stop>
                        <div class="ms-hd clickable" @click="toggleCardSection(s, 'asr')">ASR 内容<Icon :name="cardSectionOpen(s, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                        <div class="ms-body" :class="{ muted: !s.asrContent, collapsed: !cardSectionOpen(s, 'asr') }">{{ s.asrContent || '—' }}</div>
                      </div>
                      <MaterialAnnotations class="m-supp" :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" />
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" class="mcard card compact" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
                    <div class="m-media" v-if="!isCardText(s)">
                      <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
                      <div class="mc-type-group">
                        <span class="m-type-sm">{{ isVideoByUrl(s.mediaUrl) ? 'V' : 'I' }}</span>
                        <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                      </div>
                      <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                        <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)"></video>
                      </div>
                      <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                      <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
                      <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
                      <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
                    </div>
                    <div class="mc-info">
                      <div class="mc-r1">
                        <span class="mc-badge mc-ind-badge" :class="{ on: s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' }">{{ s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' ? `${s.firstLevelIndustryName}${s.secondLevelIndustryName ? '/' + s.secondLevelIndustryName : ''}` : '行业' }}</span>
                        <span class="mc-badge mc-machine-badge" v-if="machineTagText(s)" :title="machineTagText(s)">机审:{{ machineTagText(s).length > 12 ? machineTagText(s).slice(0, 12) + '…' : machineTagText(s) }}</span>
                        <span class="mc-badge mc-human-badge" :title="humanTagText(s)">人审:{{ humanTagText(s).length > 8 ? humanTagText(s).slice(0, 8) + '…' : humanTagText(s) }}</span>
                        <a v-if="s.mediaUrl && !isCardText(s)" class="mc-link-icon" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" /></a>
                      </div>
                      <div class="mc-text" v-if="isCardText(s)">{{ s.mediaUrl || '（无文本内容）' }}</div>
                      <div class="mc-r3" @click.stop>
                        <MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" lastOnly />
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- 卡片模式：簇卡片网格（点击卡片展开簇内素材） -->
        <div v-else class="cluster-cards" :class="{ single: activeCols === 1 }" :style="activeCols > 1 ? gridStyle : {}">
          <div v-for="c in pagedClusterGroups" :key="c.classId" class="cluster-card-item" :class="{ open: expandedCluster === c.classId }">
            <div class="cci-main" @click="toggleClusterExpand(c.classId)">
              <div class="cci-media" :class="{ 'cci-media-text': c.preview && c.preview.isText, 'cci-media-video': c.preview && c.preview.isVideo && isEmbeddableMedia(c.preview.elementValue) }">
                <label class="cbx cci-cbx" :class="{ on: clusterChecked[c.classId] }" @click.stop="toggleClusterCheck(c)"><Icon v-if="clusterChecked[c.classId]" name="check" :size="12" /></label>
                <div v-if="c.preview && c.preview.isText" class="cr-text" :title="c.preview.elementValue">{{ c.preview.elementValue }}</div>
                <VideoPlayer v-else-if="c.preview && c.preview.isVideo && isEmbeddableMedia(c.preview.elementValue)" :src="c.preview.elementValue" :raw-url="c.preview.elementValue" autoRatio />
                <img v-else-if="c.preview && isEmbeddableMedia(c.preview.elementValue)" v-lazy-img :data-src="c.preview.elementValue" :data-raw-url="c.preview.elementValue" referrerpolicy="no-referrer" @error="onMediaError" alt="" />
                <Icon v-else-if="c.preview" name="link" :size="22" />
                <span v-if="c.preview && c.preview.isText" class="cr-pv-type">T</span>
                <span v-else-if="c.preview" class="cr-pv-type">{{ c.preview.isVideo ? 'V' : 'I' }}</span>
                <span class="cci-total"><b>{{ c.total }}</b> 素材</span>
              </div>
              <div class="cci-body">
                <div class="cci-hd">
                  <button class="cr-watch" :class="{ on: isWatchedCluster(c.classId) }" :title="isWatchedCluster(c.classId) ? '取消关注' : '加入我的关注'" @click.stop="toggleWatchCluster(c.classId)"><Icon name="star" :size="14" /></button>
                  <span class="cr-cid" :title="c.classId">{{ c.classId }}</span>
                  <span class="cr-caret"><Icon :name="expandedCluster === c.classId ? 'chevronUp' : 'chevronDown'" :size="14" /></span>
                </div>
                <div class="cci-compose">
                  <div class="cc-bars">
                    <span v-for="b in clusterPctBars(c)" :key="b.key" class="cc-bar" :title="`${b.label} ${b.pct}%`">
                      <i :style="{ width: Math.min(b.pct, 100) + '%', background: b.color }"></i>
                    </span>
                  </div>
                  <div class="cc-lbls">
                    <span v-for="b in clusterPctBars(c)" :key="b.key" class="cc-lbl"><i :style="{ background: b.color }"></i>{{ b.label }} {{ b.pct }}%</span>
                  </div>
                </div>
                <div class="cci-tags">
                  <span v-for="t in clusterTagList(c.machineTags).slice(0, 2)" :key="'m'+t.id" class="ct-tag ct-machine" :title="`${t.name} · ${t.count} 个 · ${t.pct}%`">{{ t.name }}</span>
                  <span v-for="t in clusterTagList(c.humanTags).slice(0, 2)" :key="'h'+t.id" class="ct-tag ct-human" :title="`${t.name} · ${t.count} 个 · ${t.pct}%`">{{ t.name }}</span>
                  <span v-if="!c.machineTags?.length && !c.humanTags?.length" class="ct-empty">—</span>
                </div>
                <div class="cci-meta">
                  <span v-for="ind in (c.industries || []).slice(0, 1)" :key="ind.name" class="cci-meta-item" :title="`${ind.name} · ${ind.count} 个 · ${ind.pct}%`"><i class="cci-mi-dot" style="background:var(--brand)"></i>{{ ind.name }}<em>{{ ind.pct }}%</em></span>
                  <span v-for="a in (c.advertisers || []).slice(0, 1)" :key="a.name" class="cci-meta-item" :title="`${a.name} · ${a.count} 个`"><i class="cci-mi-dot" style="background:var(--orange)"></i>{{ a.name }}</span>
                </div>
              </div>
            </div>
            <!-- 点击卡片 → 下拉该簇素材（与列表模式同一份 samples，复用元素呈现） -->
            <div v-if="expandedCluster === c.classId" class="cr-body">
              <div class="cr-body-hd">
                <span>簇 {{ c.classId }} · 共 {{ c.elements.length }} 个素材</span>
                <div v-if="c.elements.length > CLUSTER_PAGE_SIZE" class="cr-pager">
                  <button class="cr-page-btn" :disabled="clusterPageNo(c) <= 1" @click.stop="clusterPagePrev(c)">&#8249;</button>
                  <span class="cr-page-info">{{ clusterPageNo(c) }} / {{ clusterPageCount(c) }}</span>
                  <button class="cr-page-btn" :disabled="clusterPageNo(c) >= clusterPageCount(c)" @click.stop="clusterPageNext(c)">&#8250;</button>
                </div>
                <button v-if="c.elements.length" class="btn btn-soft btn-xs" @click.stop="clearClusterCheck(c.classId)">清除本簇勾选</button>
              </div>
              <!-- 簇特征（可编辑文字总结）：行业/审核员/人审标签/广告主/套路，一条文字概述 -->
              <div v-if="c.elements.length" class="cluster-feature">
                <div class="cf-summary">
                  <div class="cf-summary-hd">
                    <span class="cf-label">簇特征总结（可编辑）</span>
                    <button class="btn btn-ghost btn-xs" :disabled="clusterFeatureGenerating[c.classId]" @click.stop="generateClusterSummary(c)">{{ clusterFeatureGenerating[c.classId] ? '生成中…' : 'AI 生成' }}</button>
                  </div>
                  <template v-if="clusterFeatureDraft[c.classId] !== undefined">
                    <textarea class="cf-textarea" v-autosize v-model="clusterFeatureDraft[c.classId]" rows="2" placeholder="根据簇内素材 OCR/ASR 总结套路，可手动编辑"></textarea>
                    <div class="cf-summary-btns">
                      <button class="btn btn-primary btn-xs" :disabled="clusterFeatureSaving[c.classId]" @click.stop="saveClusterFeature(c)">{{ clusterFeatureSaving[c.classId] ? '保存中…' : '保存' }}</button>
                      <button class="btn btn-ghost btn-xs" @click.stop="cancelFeatureEdit(c)">取消</button>
                    </div>
                  </template>
                  <template v-else>
                    <div v-if="featureSummaryOf(c)" class="cf-summary-text" @click.stop="startFeatureEdit(c)" :title="'点击编辑套路总结'">{{ featureSummaryOf(c) }}</div>
                    <div v-else class="cf-summary-empty" @click.stop="startFeatureEdit(c)">点击「AI 生成」或此处填写套路总结</div>
                  </template>
                </div>
              </div>
              <div v-if="!c.elements.length" class="cr-empty">该簇暂无素材明细</div>
              <div v-else-if="viewMode==='table'" class="tbl-wrap">
                <table class="tbl">
                  <thead>
                    <tr>
                      <th class="ck"></th>
                      <th class="media-col">审核元素值</th>
                      <th>OCR内容</th>
                      <th>ASR内容</th>
                      <th>审核标签ID</th>
                      <th>AI评测人审标签</th>
                      <th>AMS 一级行业</th>
                      <th>AMS 二级行业</th>
                      <th>审核员</th>
                      <th>广告主ID</th>
                      <th>备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" :class="{ sel: selected.has(s.id) }">
                      <td class="ck"><label class="cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label></td>
                      <td class="media-col">
                        <div class="media-preview-cell">
                          <div class="mp-thumb" @click.stop="onThumbClick(s)">
                            <div v-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                              <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                              <button v-if="!cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                            </div>
                            <a v-else-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" />视频加载失败，打开原链接</a>
                            <img v-else-if="isEmbeddableMedia(s.mediaUrl)" v-lazy-img :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" referrerpolicy="no-referrer" @error="onMediaError" />
                            <Icon v-else name="link" :size="20" />
                          </div>
                          <div class="mp-info">
                            <a v-if="isEmbeddableMedia(s.mediaUrl)" class="mp-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl">
                              {{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}
                            </a>
                            <span v-else-if="s.mediaUrl" class="mp-link" :title="s.mediaUrl">{{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}</span>
                            <span v-else class="mp-link">—</span>
                            <span v-if="s.dcId" class="mp-dcid">创意ID：{{ s.dcId }}</span>
                            <span v-if="s.elementFingerprint" class="mp-fp" :title="s.elementFingerprint">指纹：{{ s.elementFingerprint.length > 20 ? s.elementFingerprint.slice(0, 20) + '…' : s.elementFingerprint }}</span>
                          </div>
                        </div>
                      </td>
                      <td class="expand-cell">
                        <div v-if="s.ocrContent" class="ocr-full">{{ s.ocrContent }}</div>
                        <span v-else class="muted">—</span>
                      </td>
                      <td class="expand-cell">
                        <div v-if="s.asrContent" class="ocr-full">{{ s.asrContent }}</div>
                        <span v-else class="muted">—</span>
                      </td>
                      <td><span class="mtag">{{ s.machineTag }}</span></td>
                      <td><span class="htag">{{ s.humanTag && String(s.humanTag).replace(/[\[\]]/g, '').trim() ? s.humanTag : '通过' }}</span></td>
                      <td>{{ s.firstLevelIndustryName || '—' }}</td>
                      <td>{{ s.secondLevelIndustryName || '—' }}</td>
                      <td>{{ s.reviewerName || '—' }}</td>
                      <td>{{ s.advertiserId || s.uid || '—' }}</td>
                      <td class="remark-cell"><MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" compact readonly hide-when-empty /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="cards" :class="{ single: activeCols===1 }" :style="activeCols > 1 ? { gridTemplateColumns: `repeat(${activeCols}, minmax(0, 1fr))` } : {}">
                <template v-if="activeCols===1">
                  <div v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" class="mcard card" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
                    <div class="m-media" :class="{ 'm-media-text': isCardText(s) }" @click.stop>
                      <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
                      <template v-if="isCardText(s)">
                        <span v-if="s.verifyStatus" class="mp-verify-badge" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                        <div class="m-text-bold">{{ s.mediaUrl || '（无文本内容）' }}</div>
                      </template>
                      <template v-else>
                        <div class="mc-type-group mc-type-group-lg">
                          <span class="m-type" :class="isVideoByUrl(s.mediaUrl) ? 'vid' : 'img'"><Icon :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="11" />{{ cardTypeText(s) }}</span>
                          <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                        </div>
                        <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                          <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                        </div>
                        <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                        <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />视频加载失败，打开原链接</a>
                        <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
                        <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />打开原链接</a>
                      </template>
                    </div>
                    <div class="m-body">
                      <div class="m-head" style="cursor:pointer">
                        <span class="mh-dot" :class="verifyBadge(s).cls"></span>
                        <span class="mh-id">{{ s.id }}</span>
                        <span class="mh-type">{{ cardTypeText(s) }}</span>
                        <span class="mh-ind" v-if="s.firstLevelIndustryName || s.secondLevelIndustryName">{{ s.firstLevelIndustryName }}<template v-if="s.secondLevelIndustryName"> / {{ s.secondLevelIndustryName }}</template></span>
                      </div>
                      <div class="m-tags" @click.stop>
                        <span class="mt-tag mt-machine" v-if="s.machineTag">机审: {{ s.machineTag }}</span>
                        <span class="mt-tag mt-human">人审: {{ humanTagText(s) }}</span>
                        <span class="mt-tag mt-reviewer" v-if="s.reviewerName">审核人: {{ s.reviewerName }}</span>
                        <span class="mt-tag mt-adid">广告主ID: {{ s.advertiserId || s.uid || '无' }}</span>
                        <span class="mt-tag mt-dcid" v-if="s.dcId">DCID: {{ s.dcId }}</span>
                        <span class="mt-tag mt-fp" v-if="s.elementFingerprint" :title="s.elementFingerprint">审核物理指纹（md5）: {{ s.elementFingerprint.length > 12 ? s.elementFingerprint.slice(0, 12) + '…' : s.elementFingerprint }}</span>
                        <a v-if="s.mediaUrl" class="mt-tag mt-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" />原文链接</a>
                      </div>
                      <div class="m-section" v-if="!isCardText(s)" @click.stop>
                        <div class="ms-hd clickable" @click="toggleCardSection(s, 'ocr')">OCR 内容<Icon :name="cardSectionOpen(s, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                        <div class="ms-body" :class="{ muted: !s.ocrContent, collapsed: !cardSectionOpen(s, 'ocr') }">{{ s.ocrContent || '—' }}</div>
                      </div>
                      <div class="m-section" v-if="!isCardText(s)" @click.stop>
                        <div class="ms-hd clickable" @click="toggleCardSection(s, 'asr')">ASR 内容<Icon :name="cardSectionOpen(s, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                        <div class="ms-body" :class="{ muted: !s.asrContent, collapsed: !cardSectionOpen(s, 'asr') }">{{ s.asrContent || '—' }}</div>
                      </div>
                      <MaterialAnnotations class="m-supp" :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" />
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div v-for="(s, si) in clusterPaged(c)" :key="s.id || s.elementFingerprint || si" class="mcard card compact" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
                    <div class="m-media" v-if="!isCardText(s)">
                      <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
                      <div class="mc-type-group">
                        <span class="m-type-sm">{{ isVideoByUrl(s.mediaUrl) ? 'V' : 'I' }}</span>
                        <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                      </div>
                      <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                        <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)"></video>
                      </div>
                      <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                      <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
                      <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
                      <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
                    </div>
                    <div class="mc-info">
                      <div class="mc-r1">
                        <span class="mc-badge mc-ind-badge" :class="{ on: s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' }">{{ s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' ? `${s.firstLevelIndustryName}${s.secondLevelIndustryName ? '/' + s.secondLevelIndustryName : ''}` : '行业' }}</span>
                        <span class="mc-badge mc-machine-badge" v-if="machineTagText(s)" :title="machineTagText(s)">机审:{{ machineTagText(s).length > 12 ? machineTagText(s).slice(0, 12) + '…' : machineTagText(s) }}</span>
                        <span class="mc-badge mc-human-badge" :title="humanTagText(s)">人审:{{ humanTagText(s).length > 8 ? humanTagText(s).slice(0, 8) + '…' : humanTagText(s) }}</span>
                        <a v-if="s.mediaUrl && !isCardText(s)" class="mc-link-icon" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" /></a>
                      </div>
                      <div class="mc-text" v-if="isCardText(s)">{{ s.mediaUrl || '（无文本内容）' }}</div>
                      <div class="mc-r3" @click.stop>
                        <MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" lastOnly />
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- 簇列表分页：每页数量（20/50/100）+ 翻页 -->
        <div v-if="displayClusterGroups.length" class="cluster-list-pager">
          <span class="clp-total">共 {{ displayClusterGroups.length }} 簇</span>
          <div class="clp-size">
            <span class="clp-size-label">每页</span>
            <button v-for="n in [20, 50, 100]" :key="n" class="clp-size-btn" :class="{ on: Number(clusterListPageSize) === n }" @click="setClusterListPageSize(n)">{{ n }}</button>
          </div>
          <div class="clp-nav">
            <button class="cr-page-btn" :disabled="Number(clusterListPage) <= 1" @click="setClusterListPage(Number(clusterListPage) - 1)">&#8249;</button>
            <span class="cr-page-info">{{ Number(clusterListPage) }} / {{ clusterListPageCount }}</span>
            <button class="cr-page-btn" :disabled="Number(clusterListPage) >= clusterListPageCount" @click="setClusterListPage(Number(clusterListPage) + 1)">&#8250;</button>
          </div>
        </div>
      </template>

      <!-- 元素视图：表格 / 卡片 -->
      <template v-else>
      <div v-if="viewMode==='table'" class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th class="ck"><label class="cbx" :class="{ on: allChecked }" @click="toggleAll" :title="allChecked ? '取消全选' : '全选当前页'"><Icon v-if="allChecked" name="check" :size="12" /></label></th>
              <th class="el-watch-th"><Icon name="star" :size="12" /></th>
              <th class="media-col">审核元素值</th>
              <th>OCR内容</th>
              <th>ASR内容</th>
              <th>审核标签ID</th>
              <th>AI评测人审标签</th>
              <th>AMS 一级行业</th>
              <th>AMS 二级行业</th>
              <th>审核员</th>
              <th>广告主ID</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in paged" :key="s.id" :class="{ sel: selected.has(s.id) }">
              <td class="ck"><label class="cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label></td>
              <td class="el-watch-cell"><button class="cr-watch el-watch" :class="{ on: isWatchedElement(s.id) }" :title="isWatchedElement(s.id) ? '取消元素关注' : '加入我的元素关注'" @click.stop="toggleWatchElement(s.id)"><Icon name="star" :size="13" /></button></td>
              <td class="media-col">
                <div class="media-preview-cell">
                  <div class="mp-thumb" @click.stop="onThumbClick(s)">
                    <div v-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                      <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                      <button v-if="!cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                    </div>
                    <a v-else-if="isEmbeddableMedia(s.mediaUrl) && isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" />视频加载失败，打开原链接</a>
                    <img v-else-if="isEmbeddableMedia(s.mediaUrl)" v-lazy-img :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" referrerpolicy="no-referrer" @error="onMediaError" />
                    <Icon v-else name="link" :size="20" />
                  </div>
                  <div class="mp-info">
                    <a v-if="isEmbeddableMedia(s.mediaUrl)" class="mp-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl">
                      {{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}
                    </a>
                    <span v-else-if="s.mediaUrl" class="mp-link" :title="s.mediaUrl">{{ s.mediaUrl.length > 40 ? s.mediaUrl.slice(0, 40) + '…' : s.mediaUrl }}</span>
                    <span v-else class="mp-link">—</span>
                    <span v-if="s.dcId" class="mp-dcid">创意ID：{{ s.dcId }}</span>
                    <span v-if="s.elementFingerprint" class="mp-fp" :title="s.elementFingerprint">指纹：{{ s.elementFingerprint.length > 20 ? s.elementFingerprint.slice(0, 20) + '…' : s.elementFingerprint }}</span>
                  </div>
                </div>
              </td>
              <td class="expand-cell">
                <div v-if="s.ocrContent" class="ocr-full">{{ s.ocrContent }}</div>
                <span v-else class="muted">—</span>
              </td>
              <td class="expand-cell">
                <div v-if="s.asrContent" class="ocr-full">{{ s.asrContent }}</div>
                <span v-else class="muted">—</span>
              </td>
              <td><span class="mtag">{{ s.machineTag }}</span></td>
              <td><span class="htag">{{ s.humanTag && String(s.humanTag).replace(/[\[\]]/g, '').trim() ? s.humanTag : '通过' }}</span></td>
              <td>{{ s.firstLevelIndustryName || '—' }}</td>
              <td>{{ s.secondLevelIndustryName || '—' }}</td>
              <td>{{ s.reviewerName || '—' }}</td>
              <td>{{ s.advertiserId || s.uid || '—' }}</td>
              <td class="remark-cell"><MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" compact readonly hide-when-empty /></td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-if="!paged.length" icon="star" :title="watchFilter ? (watchFilter==='cluster' ? '暂无已关注簇对应的元素' : '暂无已关注的元素') : '暂无明细'" :desc="watchFilter ? '当前为关注筛选视图，点击下方按钮查看全部元素' : '当前筛选条件下没有误杀样本'">
          <button v-if="watchFilter" class="btn btn-soft btn-sm" @click="watchFilter=''">查看全部元素</button>
        </EmptyState>
      </div>

      <!-- 卡片展示：复用素材分类卡片形式（点击卡片打开相似检索弹窗） -->
      <div v-else class="cards" :class="{ single: activeCols===1 }" :style="gridStyle">
        <template v-if="activeCols===1">
          <div v-for="s in paged" :key="s.id" class="mcard card" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
            <div class="m-media" :class="{ 'm-media-text': isCardText(s) }" @click.stop>
              <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
              <template v-if="isCardText(s)">
                <span v-if="s.verifyStatus" class="mp-verify-badge" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                <div class="m-text-bold">{{ s.mediaUrl || '（无文本内容）' }}</div>
              </template>
              <template v-else>
                <div class="mc-type-group mc-type-group-lg">
                  <span class="m-type" :class="isVideoByUrl(s.mediaUrl) ? 'vid' : 'img'"><Icon :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="11" />{{ cardTypeText(s) }}</span>
                  <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
                </div>
                <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                  <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)" @click.stop></video>
                </div>
                <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
                <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />视频加载失败，打开原链接</a>
                <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
                <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />打开原链接</a>
              </template>
            </div>
            <div class="m-body">
              <div class="m-head" style="cursor:pointer">
                <button class="cr-watch mw-watch" :class="{ on: isWatchedElement(s.id) }" :title="isWatchedElement(s.id) ? '取消元素关注' : '加入我的元素关注'" @click.stop="toggleWatchElement(s.id)"><Icon name="star" :size="13" /></button>
                <span class="mh-dot" :class="verifyBadge(s).cls"></span>
                <span class="mh-id">{{ s.id }}</span>
                <span class="mh-type">{{ cardTypeText(s) }}</span>
                <span class="mh-ind" v-if="s.firstLevelIndustryName || s.secondLevelIndustryName">{{ s.firstLevelIndustryName }}<template v-if="s.secondLevelIndustryName"> / {{ s.secondLevelIndustryName }}</template></span>
              </div>
              <div class="m-tags" @click.stop>
                <span class="mt-tag mt-machine" v-if="s.machineTag">机审: {{ s.machineTag }}</span>
                <span class="mt-tag mt-human">人审: {{ humanTagText(s) }}</span>
                <span class="mt-tag mt-reviewer" v-if="s.reviewerName">审核人: {{ s.reviewerName }}</span>
                <span class="mt-tag mt-adid">广告主ID: {{ s.advertiserId || s.uid || '无' }}</span>
                <span class="mt-tag mt-dcid" v-if="s.dcId">DCID: {{ s.dcId }}</span>
                <span class="mt-tag mt-fp" v-if="s.elementFingerprint" :title="s.elementFingerprint">审核物理指纹（md5）: {{ s.elementFingerprint.length > 12 ? s.elementFingerprint.slice(0, 12) + '…' : s.elementFingerprint }}</span>
                <a v-if="s.mediaUrl" class="mt-tag mt-link" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" />原文链接</a>
              </div>
              <div class="m-section" v-if="!isCardText(s)" @click.stop>
                <div class="ms-hd clickable" @click="toggleCardSection(s, 'ocr')">OCR 内容<Icon :name="cardSectionOpen(s, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                <div class="ms-body" :class="{ muted: !s.ocrContent, collapsed: !cardSectionOpen(s, 'ocr') }">{{ s.ocrContent || '—' }}</div>
              </div>
              <div class="m-section" v-if="!isCardText(s)" @click.stop>
                <div class="ms-hd clickable" @click="toggleCardSection(s, 'asr')">ASR 内容<Icon :name="cardSectionOpen(s, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                <div class="ms-body" :class="{ muted: !s.asrContent, collapsed: !cardSectionOpen(s, 'asr') }">{{ s.asrContent || '—' }}</div>
              </div>
              <MaterialAnnotations class="m-supp" :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" />
            </div>
          </div>
        </template>
        <!-- 多列：紧凑卡片 -->
        <template v-else>
          <div v-for="s in paged" :key="s.id" class="mcard card compact" :class="{ sel: selected.has(s.id) }" @click="openDetail(s)">
            <div class="m-media" v-if="!isCardText(s)">
              <label class="card-cbx" :class="{ on: selected.has(s.id) }" @click.stop="toggle(s.id)"><Icon v-if="selected.has(s.id)" name="check" :size="12" /></label>
              <div class="mc-type-group">
                <span class="m-type-sm">{{ isVideoByUrl(s.mediaUrl) ? 'V' : 'I' }}</span>
                <span v-if="s.verifyStatus" class="mc-verify-tag" :class="verifyBadge(s).cls">{{ verifyBadge(s).label }}</span>
              </div>
              <div v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="vid-thumb">
                <video v-lazy-video :data-src="s.mediaUrl" :data-raw-url="s.mediaUrl" :data-vid="s.id" controls playsinline muted @error="onErr(s.id)" @loadedmetadata="syncVideoState($event.target, s.id)"></video>
              </div>
              <button v-if="isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" class="speed-btn" @click.stop="cycleSpeed(s.id)">{{ speedLabel(s.id) }}</button>
              <a v-else-if="isVideoByUrl(s.mediaUrl) && cardMediaErr(s.id) && s.mediaUrl" class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
              <img v-else-if="!isVideoByUrl(s.mediaUrl) && !cardMediaErr(s.id) && !isLinkOnly(s)" v-lazy-img :data-src="previewSrc(s.mediaUrl)" :data-raw-url="s.mediaUrl" :data-vid="s.id" referrerpolicy="no-referrer" @error="onErr(s.id)" alt="" />
              <a v-else class="m-fallback" :href="previewSrc(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
            </div>
            <div class="mc-info">
              <div class="mc-r1">
                <button class="cr-watch mw-watch" :class="{ on: isWatchedElement(s.id) }" :title="isWatchedElement(s.id) ? '取消元素关注' : '加入我的元素关注'" @click.stop="toggleWatchElement(s.id)"><Icon name="star" :size="13" /></button>
                <span class="mc-badge mc-ind-badge" :class="{ on: s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' }">{{ s.firstLevelIndustryName && s.firstLevelIndustryName !== '未知' ? `${s.firstLevelIndustryName}${s.secondLevelIndustryName ? '/' + s.secondLevelIndustryName : ''}` : '行业' }}</span>
                <span class="mc-badge mc-machine-badge" v-if="machineTagText(s)" :title="machineTagText(s)">机审:{{ machineTagText(s).length > 12 ? machineTagText(s).slice(0, 12) + '…' : machineTagText(s) }}</span>
                <span class="mc-badge mc-human-badge" :title="humanTagText(s)">人审:{{ humanTagText(s).length > 8 ? humanTagText(s).slice(0, 8) + '…' : humanTagText(s) }}</span>
                <a v-if="s.mediaUrl && !isCardText(s)" class="mc-link-icon" :href="resolveSignedSrc(s.mediaUrl)" target="_blank" @click.stop :title="s.mediaUrl"><Icon name="link" :size="11" /></a>
              </div>
              <div class="mc-text" v-if="isCardText(s)">{{ s.mediaUrl || '（无文本内容）' }}</div>
              <div class="mc-r3" @click.stop>
                <MaterialAnnotations :tag-id="tag.id" :sample-id="s.id" :media-url="s.mediaUrl || ''" lastOnly />
              </div>
            </div>
          </div>
        </template>
        <EmptyState v-if="!paged.length" icon="star" :title="watchFilter ? (watchFilter==='cluster' ? '暂无已关注簇对应的元素' : '暂无已关注的元素') : '暂无明细'" :desc="watchFilter ? '当前为关注筛选视图，点击下方按钮查看全部元素' : '当前筛选条件下没有误杀样本'">
          <button v-if="watchFilter" class="btn btn-soft btn-sm" @click="watchFilter=''">查看全部元素</button>
        </EmptyState>
      </div>

      <Pager :total="filtered.length" v-model:page="page" v-model:page-size="pageSize" />
      </template>
    </div>

    <!-- 选择浮条 -->
    <transition name="pop">
      <div v-if="selected.size" class="sel-bar">
        <span>已选 <b>{{ selected.size }}</b> 条样本</span>
        <button class="btn-clear" @click="selected = new Set()">清空</button>
        <button class="btn btn-primary btn-sm" @click="exportSelectedExcel" v-tip="'将已勾选样本导出为 Excel'"><Icon name="download" :size="15" />导出选中</button>
        <button class="btn btn-primary btn-sm" @click="goTicket" v-tip="'用已勾选样本发起问题提需'"><Icon name="ticket" :size="15" />发起提需</button>
      </div>
    </transition>

    <!-- TRAG 相似素材检索弹窗（点击卡片打开，与素材分类一致） -->
    <TragSearchModal :visible="tragSearchVisible" :material="tragSearchMaterial" :cats="[]" :tag-id="tag.id" :show-attribution="false" @close="closeTragSearch" />
  </div>
</template>

<style scoped>
.back { display: inline-flex; align-items: center; justify-content: center; color: var(--brand); font-size: 14px; font-weight: 600; padding: 0; width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--brand); background: var(--brand-soft); transition: all .18s; box-shadow: 0 1px 6px rgba(79,124,255,.1); flex: none; }
.back:hover { background: var(--brand); color: #fff; border-color: var(--brand); transform: translateX(-2px); box-shadow: 0 3px 12px rgba(79,124,255,.25); }
.ph { position: sticky; top: 112px; z-index: 90; display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; background: #fff; padding: 12px 0; }
.ph-main { display: flex; align-items: center; gap: 14px; }
.ph-ic { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; background: var(--brand-soft); color: var(--brand); flex: none; }
.tag-id { display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 800; color: var(--text-1); letter-spacing: -.5px; line-height: 1.1; }
.tag-name-row { margin-top: 4px; }
.tag-name { font-size: 15px; color: var(--text-3); font-weight: 500; }
.page-sub { width: 100%; margin-top: 12px; }
.global-date-bar { display: flex; align-items: center; gap: 12px; padding: 0; background: none; border: none; border-radius: 0; flex-wrap: wrap; box-shadow: none; }
.gdb-ic { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--brand); color: #fff; flex: none; }
.gdb-ic :deep(svg) { color: #fff; }
.gdb-label { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--text-3); white-space: nowrap; }
.gdb-right { margin-left: auto; }
.global-date-bar :deep(.drf-btn) { padding: 7px 16px; font-size: 14px; }
.global-date-bar :deep(.drf-custom input[type="date"]) { height: 34px; font-size: 14px; }
.global-date-bar :deep(.drf-sep) { font-size: 14px; }

.overview { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-bottom: 18px; }
.kpi-card { display: flex; align-items: center; gap: 16px; padding: 22px 24px; }
.kpi-card .mk-ic { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; flex-shrink: 0; }
.kpi-card em { font-style: normal; font-size: 13px; color: var(--text-3); display: block; margin-bottom: 4px; }
.kpi-card b { font-size: 30px; font-weight: 800; line-height: 1; }
.kpi-card b small { font-size: 16px; font-weight: 700; }
.kpi-card b.red { color: var(--red); }
.gauge-card { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 30px 28px; text-align: center; }
.ring { width: 168px; height: 168px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; transition: background .8s; }
.ring-in { width: 128px; height: 128px; border-radius: 50%; background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-shadow: inset 0 1px 3px rgba(0,0,0,.04); }
.ring-in b { font-size: 44px; font-weight: 800; line-height: 1; letter-spacing: -1px; }
.ring-in small { font-size: 18px; font-weight: 700; }
.ring-in span { display: block; font-size: 12px; color: var(--text-3); margin-top: 6px; }
.ring-in .ring-label { font-size: 15px; font-weight: 700; color: var(--text-2); margin-top: 8px; letter-spacing: .5px; }
.gauge-meta { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 16px; }
.gm-row { font-size: 15px; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
.gm-row .dot { width: 9px; height: 9px; border-radius: 50%; }
.gm-row b { font-size: 24px; font-weight: 800; color: var(--text-1); margin-left: 2px; }
.gm-leg { display: flex; align-items: center; justify-content: center; gap: 20px; margin-top: 4px; flex-wrap: wrap; }
.gm-leg span { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); }
.gm-leg i { width: 10px; height: 10px; border-radius: 3px; }
.mini-kpis { display: grid; grid-template-rows: 1fr 1fr; gap: 18px; }
.mk { display: flex; align-items: center; gap: 16px; padding: 0 24px; }
.mk-ic { width: 46px; height: 46px; border-radius: 13px; display: grid; place-items: center; }
.mk em { font-style: normal; font-size: 13px; color: var(--text-3); display: block; }
.mk b { font-size: 30px; font-weight: 800; }
.mk b.red { color: var(--red); }
.ring-chg, .mk-chg { display: flex; align-items: center; gap: 4px; margin-top: 6px; font-size: 12px; font-weight: 700; color: var(--text-4); white-space: nowrap; }
.ring-chg i, .mk-chg i { font-style: normal; font-weight: 500; color: var(--text-4); }
.ring-chg.up, .mk-chg.up { color: #22c55e; }
.ring-chg.down, .mk-chg.down { color: #ef4444; }
.ring-chg.flat, .mk-chg.flat { color: var(--text-4); }

.charts-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 15px; font-weight: 700; color: var(--text-1); }
.charts-hd-bar { width: 4px; height: 16px; border-radius: 2px; background: linear-gradient(180deg, var(--red), #ff7a6b); flex: none; }
.charts-hd :deep(svg) { color: var(--red); }
.charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-bottom: 18px; align-items: stretch; min-height: 420px; }
.ch { padding: 20px 22px; display: flex; flex-direction: column; }
.ch h3 { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.ch-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 10px; }
.ch-hd h3 { margin-bottom: 0; white-space: nowrap; }
.ch-tools { display: flex; align-items: center; gap: 8px; }
.ch-search { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: 8px; background: #fff; transition: all .18s; max-width: 110px; }
.ch-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.ch-search :deep(svg) { color: var(--text-3); flex: none; }
.ch-search input { border: none; outline: none; background: none; width: 100%; font-size: 12px; color: var(--text-1); }
.ch-search input::placeholder { color: var(--text-3); }
.ch-sort { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 12px; color: var(--text-2); background: #fff; cursor: pointer; transition: all .18s; white-space: nowrap; }
.ch-sort:hover { border-color: var(--brand); color: var(--brand); }
.ch-pie .pie-wrap { flex: 1; display: flex; align-items: center; }
.ch-pie .pie-wrap > div { width: 100%; }
.ch .bar-wrap { flex: 1; min-height: 180px; }
.ch-more { display: flex; align-items: center; justify-content: center; gap: 4px; width: 100%; margin-top: 10px; height: 32px; border: 1px dashed var(--border-strong); border-radius: 9px; font-size: 12px; color: var(--text-2); background: var(--bg-soft); cursor: pointer; transition: all .18s; }
.ch-more:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }


.table-card { padding: 22px 24px; }
.tc-bar { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; gap: 16px; flex-wrap: wrap; }
.chips-row { display: flex; align-items: flex-start; gap: 10px 18px; flex: 1 1 100%; flex-wrap: wrap; }
.chips-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chips-label { font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; min-width: 56px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); font-size: 13px; font-weight: 600; color: var(--text-2); background: #fff; transition: all .18s; cursor: pointer; }
.chip:hover { border-color: var(--brand); color: var(--brand); }
.chip.on { border-color: var(--brand); background: var(--brand); color: #fff; box-shadow: 0 4px 12px rgba(79,124,255,.28); }
.chip b { color: var(--text-4); font-weight: 700; }
.chip:hover b { color: var(--brand); }
.chip.on b { color: #fff; }

/* 维度筛选（一级行业/二级行业/审核人/广告主ID）下拉 */
.dims-group { align-items: flex-start; }
.dim-sels { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ind-sel { display: flex; align-items: center; gap: 5px; }
.ind-lb { font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; }
.ind-dd {
  appearance: none; -webkit-appearance: none;
  height: 32px; max-width: 150px; padding: 0 26px 0 10px;
  border: 1.5px solid var(--border-strong); border-radius: 8px;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237a8296' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center;
  font-size: 12.5px; color: var(--text-2); cursor: pointer;
  text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
  transition: all .18s;
}
.ind-dd:hover { border-color: var(--brand); }
.ind-dd:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); outline: none; }
.ind-dd:disabled { opacity: .55; cursor: not-allowed; background-color: #f7f9fc; }

/* 图三按钮组：全选 / 只看标注（人审标签筛选右侧） */
.filter-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sel-btn { display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--brand); font-size: 13px; color: var(--brand); background: var(--brand-soft); cursor: pointer; font-weight: 600; transition: all .18s; }
.sel-btn:hover { background: var(--brand); color: #fff; }
.mode-btn { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); font-size: 13px; color: var(--text-2); background: #fff; cursor: pointer; transition: all .18s; }
.mode-btn:hover, .mode-btn.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.mode-btn.reset-btn { color: #b06000; border-color: #f0d9a8; background: #fef7e0; }
.mode-btn.reset-btn:hover { background: #fdecc8; border-color: #e8b95c; color: #8a4a00; }
.remark-cell { min-width: 230px; }
    .fp-cell { min-width: 160px; }
.remark-input { width: 100%; border: 1px solid transparent; border-radius: 6px; padding: 5px 8px; font-size: 13px; color: var(--text-1); background: transparent; transition: all .15s; }
.remark-input:hover { border-color: var(--border); background: var(--bg-soft); }
.remark-input:focus { border-color: var(--brand); background: #fff; outline: none; box-shadow: 0 0 0 3px rgba(79,124,255,.1); }

.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 940px; }
.tbl th { text-align: left; padding: 16px 14px; color: var(--text-2); font-weight: 700; border-bottom: 2px solid var(--border-strong); white-space: nowrap; font-size: 14px; background: var(--bg-soft); letter-spacing: .2px; }
.tbl th:first-child { border-top-left-radius: 10px; }
.tbl th:last-child { border-top-right-radius: 10px; }
.tbl td { padding: 36px 14px; border-bottom: 1px solid var(--border); color: var(--text-1); font-size: 14px; }
.tbl th.type-col, .tbl td.type-col { min-width: 130px; }
.tbl tbody tr { transition: background .15s; }
.tbl tbody tr:hover { background: var(--bg-soft); }
.tbl tbody tr.sel { background: var(--brand-soft); }
.ck { width: 44px; }
.cbx { width: 18px; height: 18px; border-radius: 6px; border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: #fff; cursor: pointer; transition: all .18s; }
.cbx.on { background: var(--brand); border-color: var(--brand); }
.type-tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 7px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.type-tag.img { background: var(--brand-soft); color: var(--brand); }
.type-tag.vid { background: #fff1e6; color: #d97a1a; }
.type-tag.txt { background: #e8f5e9; color: #2e7d32; }
.type-tag.page { background: #f3e5f5; color: #7b1fa2; }
.mtag { padding: 3px 9px; border-radius: 7px; background: var(--brand-soft); color: var(--brand); font-weight: 600; font-size: 12px; }
.htag { padding: 3px 9px; border-radius: 7px; background: #f0f2f6; color: var(--text-2); font-size: 12px; }
.ellip { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.expand-cell { min-width: 200px; max-width: 380px; }
.ocr-full { font-size: 12.5px; line-height: 1.6; color: var(--text-1); white-space: pre-wrap; word-break: break-word; height: 132px; min-height: 56px; max-height: 420px; resize: vertical; overflow: auto; }
.expand-wrap { position: relative; }
.expand-wrap .expand-text { line-height: 1.5; word-break: break-all; cursor: pointer; }
.expand-wrap:not(.open) .expand-text { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.expand-wrap.open .expand-text { white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.expand-btn { display: inline-flex; align-items: center; gap: 2px; margin-top: 4px; font-size: 12px; color: var(--brand); background: none; border: none; cursor: pointer; padding: 0; font-weight: 600; }
.expand-btn:hover { text-decoration: underline; }
.muted { color: var(--text-4); }
.remark { color: var(--text-3); }
.link a { color: var(--brand); }
.link a:hover { text-decoration: underline; }

.sel-bar { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 18px; padding: 12px 16px 12px 22px; background: #1d2433; color: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(29,36,51,.35); z-index: 200; }
.sel-bar b { color: #8fb0ff; font-size: 16px; }
.btn-clear { color: #aeb6c6; font-size: 13px; }
.btn-clear:hover { color: #fff; }
@media (max-width: 1000px) { .overview, .charts { grid-template-columns: 1fr; } }

/* ===== 审核元素值预览列 ===== */
.media-col { min-width: 340px; }
.media-preview-cell { display: flex; align-items: flex-start; gap: 12px; }
.mp-thumb { width: 220px; height: 180px; border-radius: 8px; overflow: hidden; background: #f0f2f6; flex-shrink: 0; position: relative; cursor: pointer; transition: transform .15s; border: 1px solid var(--border); }
.mp-thumb:hover { transform: scale(1.04); border-color: var(--brand); }
.mp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; background: #000; }
.mp-verify-badge { position: absolute; top: 6px; right: 6px; z-index: 4; padding: 2px 8px; border-radius: 6px; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .5px; pointer-events: none; white-space: nowrap; line-height: 1; }
.mp-verify-badge.v-consistent { background: #1fb574; box-shadow: 0 2px 8px rgba(31,181,116,.45); }
.mp-verify-badge.v-miss { background: #f5a000; box-shadow: 0 2px 8px rgba(245,160,0,.45); }
.mp-verify-badge.v-fp { background: #e5484d; box-shadow: 0 2px 8px rgba(229,72,77,.45); }
.mp-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; }
.mp-link { color: var(--brand); font-size: 12px; word-break: break-all; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mp-link:hover { text-decoration: underline; }
.mp-dcid { color: var(--text-3); font-size: 11px; font-weight: 500; }
.mp-fp { color: var(--text-3); font-size: 11px; font-family: monospace; word-break: break-all; }
.media-err-fallback { white-space: nowrap; }

/* 元素指纹列 */
.fp-cell { min-width: 100px; }
.fp-val { color: var(--text-2); font-size: 12px; font-family: monospace; }

/* ===== 每日精度趋势 ===== */
.daily-trend-card {
  padding: 22px 26px 18px;
  border: 1px solid var(--border-light);
  box-shadow: 0 2px 16px rgba(20, 30, 60, .05);
}

.dt-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.dt-hd-left { display: flex; align-items: center; gap: 12px; }
.dt-hd-ic {
  width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0;
  display: grid; place-items: center;
  background: linear-gradient(135deg, #4f7cff, #6a5cff);
  color: #fff; box-shadow: 0 4px 12px rgba(79, 124, 255, .28);
}
.dt-hd-titles { display: flex; flex-direction: column; gap: 3px; }
.dt-hd-left h3 { font-size: 16px; font-weight: 700; color: var(--text-1); line-height: 1.1; }
.dt-sub {
  font-size: 11.5px; color: #6b7a99; font-weight: 600;
  padding: 2px 9px; border-radius: 20px; background: #f0f4ff; width: fit-content;
}
.dt-hd-right { display: flex; align-items: center; gap: 10px; }

.dt-body { width: 100%; }
.dt-chart { width: 100%; position: relative; }
.dt-chart > div { height: 340px; }

/* 时间粒度切换 */
.dt-range { display: inline-flex; align-items: center; padding: 2px; border-radius: 10px; background: #f0f2f6; border: 1px solid var(--border-light); }
.dt-range-btn {
  height: 26px; padding: 0 12px; border: none; border-radius: 8px; background: transparent;
  color: var(--text-3); font-size: 12px; cursor: pointer; transition: all .18s; white-space: nowrap;
}
.dt-range-btn:hover { color: var(--brand); }
.dt-range-btn.active { background: #fff; color: var(--brand); font-weight: 700; box-shadow: 0 2px 6px rgba(20,30,60,.08); }

/* 自定义时间区间 */
.dt-range-custom { display: inline-flex; align-items: center; gap: 6px; }
.dt-date-input {
  height: 30px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 8px;
  font-size: 12px; color: var(--text-2); background: #fff; outline: none; transition: border-color .18s;
}
.dt-date-input:focus { border-color: var(--brand); }
.dt-range-sep { font-size: 12px; color: var(--text-4); }

/* 图例区（主图例 + 事件图例，位于图表上方） */
.dt-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 10px; padding: 9px 14px; border-radius: 10px; background: #fafbfd; border: 1px solid var(--border-light); }
.dt-legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; }
.dt-legend-item.main { color: #5a6478; font-weight: 500; }
.dt-legend-item.off { color: #c3cad6; }
.dt-lg-line { width: 16px; height: 0; border-top: 3px solid #f97316; border-radius: 2px; }
.dt-lg-bar { width: 10px; height: 9px; border-radius: 2px; }
.dt-lg-bar.fp { background: linear-gradient(180deg, #a5ddfb, #7dd3fc); }
.dt-lg-bar.vol { background: linear-gradient(180deg, #d7dde8, #cbd5e1); }
.dt-lg-dot { width: 8px; height: 8px; border-radius: 50%; }
.dt-lg-dot.img { background: #9ca3af; }
.dt-lg-dot.txt { background: #9ca3af; }
.dt-lg-dot.vid { background: #9ca3af; }
.dt-lg-rule { width: 14px; height: 0; border-top: 2px dashed #9ca3af; }
.dt-legend-divider { width: 1px; height: 14px; background: #e2e6ee; margin: 0 2px; }
.dt-legend-tip { font-size: 11px; color: #a8b0bd; margin-left: auto; }

/* 下拉筛选（行业/元素） */
.cf-select { position: relative; display: inline-flex; align-items: center; }
.cf-select select {
  appearance: none; -webkit-appearance: none;
  height: 30px; padding: 0 28px 0 12px; border: 1px solid var(--border-strong); border-radius: 9px;
  background: #fff; color: var(--text-2); font-size: 12px; cursor: pointer; outline: none; transition: all .18s;
}
.cf-select select:hover { border-color: var(--brand); }
.cf-select :deep(svg) { position: absolute; right: 8px; pointer-events: none; color: var(--text-4); }

.dt-footer {
  margin-top: 14px; padding: 9px 14px; border-radius: 10px;
  background: #f7f9fc; border: 1px solid var(--border-light);
  font-size: 11px; color: var(--text-4); line-height: 1.6;
}

/* 数据表（弱化：无外框、无表头底色、无hover，紧凑行距） */
.daily-table-wrap { margin-top: 8px; }
.daily-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.daily-table thead th {
  padding: 3px 8px; text-align: center; font-weight: 500; color: var(--text-4);
  background: transparent; border-bottom: 1px solid var(--border-light); font-size: 11px;
  letter-spacing: .2px;
}
.daily-table tbody td { padding: 3px 8px; text-align: center; border-bottom: 1px solid #f4f6fa; color: var(--text-2); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.daily-table tbody tr:last-child td { border-bottom: none; }
.daily-table .mono { font-variant-numeric: tabular-nums; }
.daily-table-t thead th { min-width: 64px; white-space: nowrap; }
.daily-table-t .dt-metric-hd { min-width: 56px; }
.daily-table-t .dt-metric { font-weight: 600; color: var(--text-3); text-align: center; letter-spacing: .5px; }
.daily-table-t .dt-prec-cell { min-width: 72px; }
.dt-prec { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; }
.dt-prec > b { font-size: 12.5px; font-weight: 700; }
.dt-prec-bar { width: 40px; height: 3px; border-radius: 2px; background: #f1f4f8; overflow: hidden; }
.dt-prec-bar i { display: block; height: 100%; border-radius: 2px; transition: width .4s; }

@media (max-width: 920px) {
  .dt-hd { flex-direction: column; align-items: flex-start; gap: 12px; }
  .dt-hd-right { flex-wrap: wrap; }
}

/* ===== 数据洞察看板（KPI 卡下） ===== */
.insight-card { padding: 0; border: 1px solid var(--border-light); box-shadow: 0 2px 16px rgba(20,30,60,.05); overflow: hidden; margin-bottom: 18px; }
.insight-hd { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; transition: background .18s; }
.insight-hd:hover { background: #fafbff; }
.insight-hd-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.insight-hd-ic { font-size: 18px; line-height: 1; }
.insight-hd-left h3 { font-size: 16px; font-weight: 700; color: var(--text-1); }
.insight-collapse { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--border-strong); border-radius: 9px; background: #fff; color: var(--text-3); cursor: pointer; transition: all .18s; }
.insight-collapse:hover { border-color: var(--brand); color: var(--brand); }

.insight-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 20px 0; }
.insight-tab {
  height: 28px; padding: 0 14px; border-radius: 999px; border: 1px solid #e2e8f0;
  background: #fff; color: #334155; font-size: 12px; cursor: pointer; transition: all .18s;
}
.insight-tab:hover { border-color: var(--brand); color: var(--brand); }
.insight-tab.active { background: #1e293b; border-color: #1e293b; color: #fff; font-weight: 600; }

.insight-body { padding: 14px 20px 20px; }
.insight-grid { display: grid; grid-template-columns: 65fr 35fr; gap: 20px; align-items: stretch; }
.insight-chart-col { min-width: 0; }
.insight-drill-col { min-width: 0; display: flex; flex-direction: column; gap: 10px; border-left: 1px dashed var(--border-strong); padding-left: 20px; }
.insight-drill-col .dt-insight-table-wrap { max-height: 290px; }
@media (max-width: 920px) {
  .insight-grid { grid-template-columns: 1fr; }
  .insight-drill-col { border-left: none; padding-left: 0; border-top: 1px dashed var(--border-strong); padding-top: 16px; }
}
.insight-loading { display: flex; align-items: center; justify-content: center; height: 220px; color: var(--text-4); font-size: 13px; }
.insight-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; height: 220px; color: var(--text-4); font-size: 13px; }
.insight-empty :deep(svg) { color: #c3cad6; }

/* ===== 日精度卡内：行业置值下钻 + 精度快照 ===== */
.dt-insight { display: grid; grid-template-columns: 1fr; gap: 22px; margin-top: 18px; padding-top: 18px; border-top: 1px dashed var(--border-strong); }
.dt-insight-block { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.dt-insight-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dt-insight-hd h4 { font-size: 13px; font-weight: 700; color: #1e293b; }
.dt-insight-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dt-insight-table-wrap { border: 1px solid var(--border-light); border-radius: 12px; overflow: auto; max-height: 320px; }
.dt-insight-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dt-insight-table thead th {
  padding: 9px 14px; text-align: left; font-weight: 700; color: var(--text-2);
  background: #f7f9fc; border-bottom: 1.5px solid var(--border-strong); font-size: 11.5px; letter-spacing: .3px;
  position: sticky; top: 0;
}
.dt-insight-table tbody td { padding: 9px 14px; border-bottom: 1px solid var(--border-light); color: var(--text-2); font-variant-numeric: tabular-nums; }
.dt-insight-table tbody tr:last-child td { border-bottom: none; }
.dt-insight-table tbody tr { transition: background .15s; }
.dt-insight-table tbody tr:hover { background: #f5f8ff; }
.di-ind { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #1e293b; }
.di-elem { color: #64748b; font-size: 11.5px; }
.di-prec { text-align: right; }
.di-prec b { font-weight: 700; }
.di-fp { text-align: right; color: #1e293b; }
.di-empty { text-align: center; color: var(--text-4); padding: 20px 14px !important; }

@media (max-width: 920px) {
  .dt-insight { grid-template-columns: 1fr; }
}

/* 审核判定筛选 chips 三色态 */
.chip.v-consistent.on { border-color: #1fb574; background: #1fb574; color: #fff; box-shadow: 0 4px 12px rgba(31,181,116,.28); }
.chip.v-miss.on { border-color: #f5a000; background: #f5a000; color: #fff; box-shadow: 0 4px 12px rgba(245,160,0,.28); }
.chip.v-fp.on { border-color: #f0454b; background: #f0454b; color: #fff; box-shadow: 0 4px 12px rgba(240,69,75,.28); }

/* 明细表审核判定徽章 */
.vstatus { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 7px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.vstatus i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.vstatus.vs-consistent { background: #e6f7f0; color: #1a9d68; }
.vstatus.vs-consistent i { background: #1fb574; }
.vstatus.vs-miss { background: #fef6e7; color: #b9791a; }
.vstatus.vs-miss i { background: #f5a000; }
.vstatus.vs-fp { background: #fdecec; color: #d63a40; }
.vstatus.vs-fp i { background: #f0454b; }

/* ===== 展示方式切换（表格 / 卡片） ===== */
.seg-mini, .cols-pick { display: flex; align-items: center; background: #f0f2f6; border-radius: 9px; padding: 3px; gap: 2px; }
.seg-mini button, .cols-pick button { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 12px; border-radius: 7px; font-size: 12.5px; color: var(--text-3); background: none; border: none; cursor: pointer; transition: all .15s; white-space: nowrap; }
.seg-mini button.on, .cols-pick button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); font-weight: 600; }
.cols-pick { padding: 3px 3px 3px 10px; }
.cols-pick > span { font-size: 12px; color: var(--text-4); margin-right: 4px; }
.col-inp { width: 46px; height: 26px; margin-left: 4px; border: 1px solid var(--border-strong); border-radius: 6px; font-size: 12px; text-align: center; }

/* ===== 卡片网格（复用素材分类卡片形式） ===== */
.cards { display: grid; gap: 18px; }
.cards.single { display: flex; flex-direction: column; }
.mcard { overflow: hidden; transition: all .2s; position: relative; border: 1.5px solid #dbeee2; border-radius: 16px; background: #fff; box-shadow: 0 2px 10px rgba(30,120,70,.05); }
.mcard:hover { box-shadow: 0 6px 22px rgba(30,120,70,.12); border-color: #b9e3c9; }
.mcard.sel { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.cards.single .mcard { display: flex; align-items: flex-start; }
.cards.single .m-media { width: 540px; aspect-ratio: 4/3; flex-shrink: 0; border-right: none; }
.cards.single .m-body { max-height: 405px; overflow-y: auto; }
.cards:not(.single) .mcard { display: flex; flex-direction: column; cursor: pointer; container-type: inline-size; }
.cards:not(.single) .mcard.compact .m-media { width: 100%; flex: 0 0 auto; min-height: 0; max-width: none; padding: 4px; aspect-ratio: 4/3; }
.cards:not(.single) .mcard.compact .m-media img,
.cards:not(.single) .mcard.compact .m-media video { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.mcard.compact .mc-info { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; background: #fff; border-top: 1px solid #eef2ee; flex: 0 0 auto; min-height: 0; position: relative; }
.mc-r1 { display: flex; align-items: center; gap: 6px; font-size: 13px; min-width: 0; overflow: hidden; flex-wrap: wrap; }
.mc-r1 .mc-dot { width: 9px; height: 9px; border-radius: 50%; background: #c6ccd8; flex-shrink: 0; }
.mc-r1 .mc-dot.done { background: var(--brand); }
.mc-type-tag { font-size: 11px; padding: 3px 7px; border-radius: 5px; background: #f0f2f6; color: var(--text-3); flex-shrink: 0; white-space: nowrap; }
.mc-link-icon { display: flex; color: var(--text-4); margin-left: auto; flex-shrink: 0; transition: color .15s; }
.mc-link-icon:hover { color: var(--brand); }
.mc-text { font-size: 12px; font-weight: 700; color: var(--text-1); line-height: 1.5; white-space: pre-wrap; word-break: break-word; padding: 6px 8px; background: #f7f9fc; border-left: 3px solid var(--green); border-radius: 5px; max-height: 80px; overflow-y: auto; }
.mc-r3 { display: flex; }
.mc-badge { font-size: 11px; font-weight: 600; padding: 3px 7px; border-radius: 5px; background: #f0f2f6; color: var(--text-4); flex-shrink: 0; }
.mc-badge.mc-ind-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; font-weight: 700; font-size: 11px; color: var(--brand); background: #e8eaff; border: 1.5px solid #b3c6ff; }
.mc-badge.on { background: #e8f5ed; color: #2ec16a; }
.mc-badge.mc-machine-badge { background: #e8f0fe; color: #1a73e8; flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
.mc-badge.mc-human-badge { background: #e6f4ea; color: #137333; flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
.mc-badge.mc-fp-badge { background: #eceff1; color: #37474f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; flex-shrink: 0; }
.mc-adid-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; background: #fce4ec; color: #c62828; font-weight: 600; }
.mc-adid-badge:not(.on) { background: #f1f3f5; color: #9aa3b2; }
.mc-verify-badge { font-weight: 700; }
.mc-verify-badge.mv-consistent { background: #e6f7f0; color: #1a9d68; }
.mc-verify-badge.mv-miss { background: #fef6e7; color: #b9791a; }
.mc-verify-badge.mv-fp { background: #fdecec; color: #d63a40; }
.mc-supp-sm { width: 100%; font-size: 11px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 5px; background: #fafbfc; color: var(--text-2); line-height: 1.3; }
.mc-supp-sm::placeholder { color: var(--text-4); font-size: 10px; }
.mc-supp-sm:focus { border-color: var(--brand); outline: none; }

.m-media { position: relative; background: #12161f; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 12px; box-sizing: border-box; }
.m-media-text { background: #f7f9fc; align-items: flex-start; justify-content: flex-start; overflow: auto; }
.m-text-bold { font-weight: 700; font-size: 14px; color: var(--text-1); line-height: 1.7; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--green); padding: 12px 14px; width: 100%; box-sizing: border-box; }
.m-media img, .m-media video { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; border-radius: 8px; box-sizing: border-box; }
.m-type { position: absolute; top: 14px; left: 14px; z-index: 2; display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .3px; background: rgba(30,35,48,.88); color: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.3); line-height: 1; white-space: nowrap; }
.m-type.vid { background: transparent; box-shadow: none; text-shadow: 0 1px 4px rgba(0,0,0,.55); }
.m-type.img { background: rgba(30,35,48,.88); }
.m-type-sm { position: absolute; top: 6px; left: 6px; z-index: 2; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(45,52,66,.75); color: #dfe4ee; }
/* 多列紧凑卡片：V 标识与误杀徽章并排（误杀在 V 右侧） */
.mc-type-group { position: absolute; top: 6px; left: 6px; z-index: 2; display: flex; align-items: center; gap: 4px; }
.mc-type-group .m-type-sm { position: static; }
/* 单列卡片：类型标签（Video）与误杀徽章并排，误杀在类型右侧 */
.mc-type-group-lg { position: absolute; top: 14px; left: 14px; z-index: 2; display: flex; align-items: center; gap: 6px; }
.mc-type-group-lg .m-type { position: static; }
.mc-verify-tag { padding: 2px 8px; border-radius: 6px; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .5px; pointer-events: none; white-space: nowrap; line-height: 1; }
.mc-verify-tag.v-consistent { background: #1fb574; box-shadow: 0 2px 8px rgba(31,181,116,.45); }
.mc-verify-tag.v-miss { background: #f5a000; box-shadow: 0 2px 8px rgba(245,160,0,.45); }
.mc-verify-tag.v-fp { background: #e5484d; box-shadow: 0 2px 8px rgba(229,72,77,.45); }
.m-fallback { display: flex; flex-direction: column; align-items: center; gap: 6px; color: #8b94a8; font-size: 12px; padding: 16px; text-align: center; }
.vid-thumb { position: relative; width: 100%; height: 100%; cursor: pointer; background: linear-gradient(135deg, #1a1e2a 0%, #252a3a 50%, #1a1e2a 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center; min-height: 180px; }
.vid-thumb video { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; }
.speed-btn { position: absolute; bottom: 8px; right: 8px; z-index: 5; padding: 4px 10px; border-radius: 8px; background: rgba(20,24,34,.6); color: #fff; font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,.25); cursor: pointer; backdrop-filter: blur(4px); transition: all .15s; }
.speed-btn:hover { background: rgba(40,120,255,.85); border-color: rgba(255,255,255,.5); transform: scale(1.05); }
.card-cbx { position: absolute; top: 12px; right: 12px; z-index: 3; width: 22px; height: 22px; border-radius: 7px; border: 1.5px solid rgba(255,255,255,.7); background: rgba(0,0,0,.3); backdrop-filter: blur(4px); display: grid; place-items: center; color: #fff; cursor: pointer; }
.card-cbx.on { background: var(--brand); border-color: var(--brand); }

.m-body { flex: 1; padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-y: auto; }
.m-head { display: flex; align-items: center; gap: 10px; }
.m-tags { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
.mt-tag { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 5px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.mt-machine { background: #e8f0fe; color: #1a73e8; }
.mt-human { background: #e6f4ea; color: #137333; }
.mt-reviewer { background: #fef7e0; color: #b06000; }
.mt-adid { background: #fce4ec; color: #c62828; }
.mt-dcid { background: #f3e8fd; color: #7b1fa2; }
.mt-fp { background: #eceff1; color: #37474f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mt-link { background: #f0f1f3; color: var(--brand); text-decoration: none; }
.mt-link:hover { background: #e8eaff; }
.mt-verify { font-weight: 700; }
.mt-verify.mv-consistent { background: #e6f7f0; color: #1a9d68; }
.mt-verify.mv-miss { background: #fef6e7; color: #b9791a; }
.mt-verify.mv-fp { background: #fdecec; color: #d63a40; }
.mh-dot { width: 9px; height: 9px; border-radius: 50%; background: #c6ccd8; flex-shrink: 0; }

/* ===== 聚类簇（与明细融合，一行一簇 / 卡片网格） ===== */
.tc-bar-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.tc-bar-right { display: flex; align-items: center; gap: 12px; margin-left: auto; flex-wrap: wrap; }
.tc-bar-sub { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.tc-mode .btn { font-weight: 600; }
.tc-mode-count { font-size: 12px; color: var(--text-3); font-weight: 600; }
.watch-seg {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 3px; border-radius: 8px; background: #eef2f8;
}
.watch-seg-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
  color: #64748b; background: transparent; border: none; cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.watch-seg-btn:hover { color: #334155; background: rgba(255,255,255,.7); }
.watch-seg-btn .icon { color: #d97706; }
.watch-seg-btn.on { background: #4f7cff; color: #fff; box-shadow: 0 2px 6px rgba(79,124,255,.35); }
.watch-seg-btn.on .icon { color: #fff; fill: #fff; }
.watch-seg-cnt {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: #f59e0b; color: #fff; font-size: 10px; font-weight: 700; line-height: 1;
}
.watch-seg-btn.on .watch-seg-cnt { background: #fff; color: #4f7cff; }
.tc-verify-range { margin-left: auto; }
.tc-verify-loading { font-size: 12px; color: var(--text-4); }
.cluster-empty { padding: 30px 0; text-align: center; font-size: 13px; color: var(--text-4); }
.cluster-list { display: flex; flex-direction: column; gap: 10px; }
.cr-head { display: grid; grid-template-columns: 24px 20px 92px 84px 66px 72px 172px minmax(108px, 1fr) minmax(108px, 1fr) minmax(122px, 1fr) minmax(122px, 1fr) 20px; gap: 10px; align-items: center; padding: 10px 14px; font-size: 12px; color: var(--text-2); font-weight: 800; letter-spacing: .3px; background: #eef2f8; border: 1px solid var(--border); border-bottom: none; border-radius: 12px 12px 0 0; white-space: nowrap; }
.cr-head + .cluster-row { border-top-left-radius: 0; border-top-right-radius: 0; }
.cr-h { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cluster-row { border: 1px solid var(--border); border-radius: 12px; background: #fff; overflow: hidden; transition: all .18s; }
.cluster-row:hover { border-color: var(--brand); box-shadow: 0 4px 14px rgba(79,124,255,.08); }
.cluster-row.open { border-color: var(--brand); }
.cr-main { display: grid; grid-template-columns: 24px 20px 92px 84px 66px 72px 172px minmax(108px, 1fr) minmax(108px, 1fr) minmax(122px, 1fr) minmax(122px, 1fr) 20px; gap: 10px; align-items: center; padding: 38px 16px; cursor: pointer; }
.cr-h-watch { width: 16px; }
.cr-watch {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0; padding: 0;
  color: #cbd5e1; background: transparent; border: none; cursor: pointer;
  transition: color .15s, background .15s, transform .15s;
}
.cr-watch:hover { color: #f59e0b; background: rgba(245,158,11,.14); transform: scale(1.06); }
.cr-watch.on { color: #f59e0b; }
.cr-watch.on .icon { fill: #f59e0b; }
/* 元素视图表格：关注列与按钮 */
.el-watch-th { width: 40px; color: #d97706; text-align: center; padding-left: 4px !important; padding-right: 4px !important; }
.el-watch-cell { width: 40px; text-align: center; padding-left: 4px !important; padding-right: 4px !important; }
.el-watch { width: 20px; height: 20px; }
/* 元素视图卡片：标题区关注按钮 */
.mw-watch { margin-right: 2px; }
.cr-cbx { justify-self: start; }
.cr-preview { width: 84px; height: 112px; border-radius: 9px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); flex-shrink: 0; position: relative; display: grid; place-items: center; }
.cr-preview video, .cr-preview img { width: 100%; height: 100%; object-fit: cover; }
.cr-preview-text { justify-items: start; }
.cr-text { position: relative; width: 100%; height: 100%; padding: 7px 9px; box-sizing: border-box; font-size: 10.5px; line-height: 1.45; color: var(--text-1); background: #f4f6f9; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; word-break: break-all; white-space: pre-wrap; border-left: 2.5px solid var(--green); }
.cr-pv-type { position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; border-radius: 4px; background: rgba(0,0,0,.55); color: #fff; font-size: 9px; font-weight: 700; display: grid; place-items: center; }
.cr-cid { font-size: 12.5px; font-weight: 700; color: var(--text-1); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-total { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.cr-total b { font-size: 16px; font-weight: 800; color: var(--text-1); font-variant-numeric: tabular-nums; line-height: 1.1; }
.cr-total em { font-style: normal; font-size: 10px; color: var(--text-4); }
.cr-precision { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.cr-precision b { font-size: 16px; font-weight: 800; color: var(--brand); font-variant-numeric: tabular-nums; line-height: 1.1; }
.cr-precision b.prec-empty { color: var(--text-4); }
.cr-precision em { font-style: normal; font-size: 10px; color: var(--text-4); }
.cr-compose { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cc-bars { display: flex; gap: 3px; height: 8px; }
.cc-bar { flex: 1; background: #f0f2f6; border-radius: 4px; overflow: hidden; }
.cc-bar i { display: block; height: 100%; border-radius: 4px; transition: width .4s; }
.cc-lbls { display: flex; gap: 8px; flex-wrap: wrap; }
.cc-lbl { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--text-3); white-space: nowrap; }
.cc-lbl i { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.cr-tags { display: flex; gap: 4px; flex-wrap: wrap; min-width: 0; }
.ct-tag { font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.ct-machine { background: #e0f2fe; color: #0369a1; }
.ct-human { background: #f3e8ff; color: #7e22ce; }
.ct-empty { font-size: 11px; color: var(--text-4); }
.cr-ind { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cr-ind-item { font-size: 11px; color: var(--text-2); display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cr-ind-item em { font-style: normal; font-size: 10px; font-weight: 700; color: var(--brand); flex-shrink: 0; }
.cr-adv { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cr-adv-item { font-size: 11px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.cr-caret { justify-self: center; color: var(--text-3); }
.cr-body { border-top: 1px dashed var(--border); padding: 12px 14px 16px; background: #fafbfc; }
.cr-body-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.cr-pager { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.cr-page-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text-2); font-size: 14px; line-height: 1; cursor: pointer; transition: all .15s; }
.cr-page-btn:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
.cr-page-btn:disabled { opacity: .35; cursor: not-allowed; }
.cr-page-info { font-size: 11px; font-weight: 700; color: var(--text-2); font-variant-numeric: tabular-nums; }
.cr-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--text-4); }
/* 簇特征（可编辑）：行业占比 / 审核人分布 / 人审标签分布 / 广告主分布 + 素材内容特征总结（套路） */
.cluster-feature { margin-bottom: 12px; padding: 12px 14px; background: #fff; border: 1px solid var(--border); border-radius: 12px; }
.cf-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px 16px; }
.cf-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cf-label { font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: .2px; }
.cf-tags { display: flex; flex-wrap: wrap; gap: 5px; min-height: 22px; }
.cf-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--text-2); background: var(--bg-soft); border: 1px solid var(--border); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf-tag em { font-style: normal; font-weight: 700; color: var(--brand); font-size: 10px; }
.cf-tag-human { background: #f3e8ff; color: #7e22ce; border-color: #e4d4f8; }
.cf-tag-human em { color: #7e22ce; }
.cf-tag-reviewer { background: #eef7ff; color: #0369a1; border-color: #d8ecfb; }
.cf-tag-reviewer em { color: #0369a1; }
.cf-tag-adv { background: #fff7ed; color: #c2410c; border-color: #ffe4cc; }
.cf-tag-adv em { color: #c2410c; }
.cf-empty { font-size: 11px; color: var(--text-4); }
.cf-summary { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
.cf-summary-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.cf-summary-text { font-size: 12.5px; color: var(--text-1); line-height: 1.6; cursor: pointer; padding: 8px 10px; background: var(--bg-soft); border-radius: 8px; transition: background .15s; }
.cf-summary-text:hover { background: #eef2ff; }
.cf-summary-empty { font-size: 12px; color: var(--text-4); cursor: pointer; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 8px; text-align: center; transition: all .15s; }
.cf-summary-empty:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.cf-textarea { width: 100%; min-height: 60px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 12.5px; color: var(--text-1); line-height: 1.6; resize: vertical; font-family: inherit; background: #fff; transition: border-color .15s; box-sizing: border-box; }
.cf-textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.cf-summary-btns { display: flex; gap: 8px; margin-top: 8px; }
.btn-xs { height: 26px; padding: 0 10px; font-size: 12px; border-radius: 7px; }
@media (max-width: 900px) { .cf-grid { grid-template-columns: 1fr 1fr; } }
/* 簇列表分页：每页数量 + 翻页 */
.cluster-list-pager { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 16px 4px 4px; flex-wrap: wrap; }
.clp-total { font-size: 12px; color: var(--text-3); font-weight: 600; }
.clp-size { display: inline-flex; align-items: center; gap: 6px; }
.clp-size-label { font-size: 12px; color: var(--text-3); }
.clp-size-btn { min-width: 36px; height: 26px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; color: var(--text-2); font-size: 12px; font-weight: 600; cursor: pointer; transition: all .15s; }
.clp-size-btn:hover { border-color: var(--brand); color: var(--brand); }
.clp-size-btn.on { background: var(--brand); border-color: var(--brand); color: #fff; }
.clp-nav { display: inline-flex; align-items: center; gap: 8px; }
.clp-nav .cr-page-btn { width: 26px; height: 26px; font-size: 15px; }
/* 聚类簇卡片模式：簇卡片网格 */
.cluster-cards { display: grid; gap: 14px; }
.cluster-cards.single { display: flex; flex-direction: column; }
.cluster-card-item { border: 1px solid var(--border); border-radius: 14px; background: #fff; overflow: hidden; transition: all .18s; }
.cluster-card-item:hover { border-color: var(--brand); box-shadow: 0 6px 18px rgba(79,124,255,.1); transform: translateY(-1px); }
.cluster-card-item.open { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.cci-main { cursor: pointer; }
.cci-media { position: relative; height: 176px; background: var(--bg-soft); display: grid; place-items: center; overflow: hidden; }
.cci-media.cci-media-video { height: auto; }
.cci-media.cci-media-video .vp { max-height: 176px; }
.cci-media video, .cci-media img { width: 100%; height: 100%; object-fit: cover; }
.cci-media-text { align-items: stretch; }
.cci-media-text .cr-text { font-size: 11.5px; -webkit-line-clamp: 6; padding: 10px 12px; border-left-width: 3px; }
.cci-cbx { position: absolute; left: 9px; top: 9px; z-index: 3; background: rgba(255,255,255,.96); box-shadow: 0 2px 8px rgba(0,0,0,.14); }
.cci-cbx.on { background: var(--brand); box-shadow: 0 2px 8px rgba(79,124,255,.4); }
.cci-total { position: absolute; right: 8px; top: 8px; display: flex; align-items: baseline; gap: 3px; padding: 3px 9px; border-radius: 8px; background: rgba(12,16,26,.66); color: #fff; font-size: 11px; backdrop-filter: blur(4px); }
.cci-total b { font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
.cci-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; }
.cci-hd { display: flex; align-items: center; gap: 8px; }
.cci-hd .cr-cid { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
/* 单列模式：左侧大图 + 右侧信息 */
.cluster-cards.single .cluster-card-item { display: flex; }
.cluster-cards.single .cci-media { width: 400px; height: 240px; flex-shrink: 0; }
.cluster-cards.single .cci-media.cci-media-video { height: auto; }
.cluster-cards.single .cci-media.cci-media-video .vp { max-height: 240px; }
.cluster-cards.single .cci-body { flex: 1; justify-content: center; padding: 16px 20px; }
.cci-compose { display: flex; flex-direction: column; gap: 5px; }
.cci-tags { display: flex; gap: 5px; flex-wrap: wrap; min-height: 22px; }
.cci-meta { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px dashed var(--border); padding-top: 9px; }
.cci-meta-item { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); background: var(--bg-soft); border-radius: 6px; padding: 2px 8px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cci-meta-item em { font-style: normal; font-weight: 700; color: var(--text-2); font-size: 10px; }
.cci-mi-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.cr-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.cr-mini-card { border: 1px solid var(--border); border-radius: 10px; background: #fff; overflow: hidden; transition: all .15s; }
.cr-mini-card:hover { border-color: var(--brand); box-shadow: 0 4px 12px rgba(79,124,255,.1); }
.cmc-media { position: relative; height: 84px; background: var(--bg-soft); display: grid; place-items: center; overflow: hidden; }
.cmc-media video, .cmc-media img { width: 100%; height: 100%; object-fit: cover; }
.cmc-media-text { height: 84px; align-items: stretch; }
.cmc-text { position: relative; width: 100%; height: 100%; padding: 8px 9px; box-sizing: border-box; font-size: 10.5px; line-height: 1.45; color: var(--text-1); background: #f4f6f9; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; word-break: break-all; white-space: pre-wrap; border-left: 2.5px solid var(--green); }
.cmc-fallback { color: var(--text-3); display: grid; place-items: center; width: 100%; height: 100%; }
.cmc-play { position: absolute; right: 5px; bottom: 5px; width: 18px; height: 18px; border-radius: 5px; background: rgba(0,0,0,.5); color: #fff; display: grid; place-items: center; }
.cmc-fp { position: absolute; left: 5px; bottom: 5px; padding: 1px 6px; border-radius: 5px; background: rgba(214,58,64,.92); color: #fff; font-size: 9.5px; font-weight: 700; }
.cmc-info { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px; }
.cmc-type { font-size: 10.5px; font-weight: 700; color: var(--brand); }
.cmc-ind, .cmc-adv, .cmc-dcid { font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmc-link { font-size: 10px; color: var(--brand); display: inline-flex; align-items: center; gap: 3px; text-decoration: none; }
.mh-dot.v-consistent { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.15); }
.mh-dot.v-miss { background: #f5a000; box-shadow: 0 0 0 3px rgba(245,160,0,.15); }
.mh-dot.v-fp { background: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
.mh-id { font-size: 15px; font-weight: 800; color: var(--text-1); }
.mh-type { font-size: 13px; color: var(--text-3); }
.mh-ind { font-size: 13px; font-weight: 700; color: var(--brand); background: #e8eaff; padding: 3px 10px; border-radius: 6px; margin-left: auto; white-space: nowrap; border: 1.5px solid #b3c6ff; }

.m-section { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fafbfc; flex-shrink: 0; }
.ms-hd { display: flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12px; font-weight: 600; color: var(--text-3); background: #f0f2f6; }
.ms-body { padding: 9px 12px; font-size: 12.5px; color: var(--text-1); line-height: 1.6; word-break: break-word; white-space: pre-wrap; max-height: 320px; overflow-y: auto; resize: vertical; transition: max-height .25s ease, padding .25s ease; }
.ms-body.collapsed { max-height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; resize: none; }
.ms-body.muted { color: var(--text-4); font-style: italic; }
.ms-hd.clickable { cursor: pointer; user-select: none; }
.ms-hd.clickable:hover { color: var(--brand); }
.ms-caret { margin-left: auto; color: var(--text-4); }
.m-supp { display: flex; flex-direction: column; gap: 6px; }
.ms-lb { font-size: 13px; font-weight: 700; color: var(--text-2); }
.m-supp-inp { width: 100%; height: 40px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 14px; font-size: 13px; color: var(--text-1); background: #fff; transition: all .15s; box-sizing: border-box; }
.m-supp-inp:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
</style>