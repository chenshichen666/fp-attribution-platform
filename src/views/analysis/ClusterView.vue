<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { overviewApi, badcaseApi } from '../../api/index'
import { previewSrc, onMediaError, isMediaUrl } from '../../utils/mediaPreview'
import { useRemotePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Pager from '../../components/Pager.vue'

const props = defineProps({ dateRange: { type: Object, default: () => ({}) }, activePanel: { type: String, default: 'cluster' } })

// 当外部不传 activePanel 时（旧用法），用内部 activeTab 控制
const internalTab = ref('ai')

// ===== 浅色主题色板（参照聚类簇改造方案 §三） =====
const CATS = [
  { key: 'left-up',    color: '#ef4444', name: '人机不一致（左上）', desc: '人审 > 60% 且 机审 < 40%' },
  { key: 'right-down', color: '#f97316', name: '人机不一致（右下）', desc: '机审 > 60% 且 人审 < 40%' },
  { key: 'h-human',    color: '#a855f7', name: '横条*人审分歧',      desc: '40% ≤ 人审 ≤ 60% 且 机审两极' },
  { key: 'h-machine',  color: '#0ea5e9', name: '横条*机审分歧',      desc: '40% ≤ 机审 ≤ 60% 且 人审两极' },
  { key: 'center',     color: '#3b82f6', name: '中心·双分歧',        desc: '40% < 机审 < 60% 且 40% < 人审 < 60%' },
  { key: 'dual-high',  color: '#22c55e', name: '双高（其他）',       desc: '机审 > 60% 且 人审 > 60%' },
  { key: 'dual-low',   color: '#94a3b8', name: '双低（其他）',       desc: '机审 < 40% 且 人审 < 40%' },
]

const loading = ref(false)
const rawData = ref({ clusters: [], catStats: {}, total: 0, availableTags: [] })
const selectedTag = ref('')
const tagSearch = ref('')
const elementType = ref('')
const hiddenCats = ref(new Set())
const tipData = reactive({ show: false, x: 0, y: 0, classId: '', cat: '', humanPct: 0, machinePct: 0, total: 0, mh: 0, hh: 0 })
const listSort = ref('size')
const clusterSearch = ref('')
const listCatFilter = ref('')
const listWatchOnly = ref(false)
// 我的关注：跨设备延续（按用户隔离），存关注的聚类簇 classId
const watchedClusters = useRemotePersistedRef('cluster:watch', [])
const highlightedClassId = ref('')
const metricExpanded = ref(true)
const tagDropdownOpen = ref(false)
const tagPickerRef = ref(null)
const svgRef = ref(null)

const detailModal = reactive({ open: false, classId: '', loading: false, elements: [], total: 0, page: 1, pageSize: 25 })

// ===== 加载数据 =====
async function loadData() {
  loading.value = true
  try {
    const params = {}
    if (props.dateRange?.start) params.start = props.dateRange.start
    if (props.dateRange?.end) params.end = props.dateRange.end
    if (selectedTag.value) params.tagId = selectedTag.value
    if (elementType.value) params.elementType = elementType.value
    const data = await overviewApi.clusterQuad(params)
    console.log('cluster-quad response', data)
    if (data && typeof data === 'object') {
      rawData.value = {
        clusters: Array.isArray(data.clusters) ? data.clusters : [],
        catStats: data.catStats || {},
        total: data.total || 0,
        availableTags: Array.isArray(data.availableTags) ? data.availableTags : [],
      }
    } else {
      rawData.value = { clusters: [], catStats: {}, total: 0, availableTags: [] }
    }
    nextTick(() => drawSVG())
  } catch (e) {
    console.error('cluster-quad error', e, String(e), 'stack:', e?.stack)
    rawData.value = { clusters: [], catStats: {}, total: 0, availableTags: [] }
  }
  finally { loading.value = false }
}

function onDocClick(e) {
  if (tagPickerRef.value && !tagPickerRef.value.contains(e.target)) tagDropdownOpen.value = false
}
onMounted(() => { loadData(); document.addEventListener('click', onDocClick) })
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
watch(() => [selectedTag.value, elementType.value, JSON.stringify(props.dateRange)], loadData)

// ===== 标签搜索下拉 =====
const filteredTags = computed(() => {
  const q = tagSearch.value.trim().toLowerCase()
  if (!q) return rawData.value.availableTags || []
  return (rawData.value.availableTags || []).filter(t => String(t).toLowerCase().includes(q))
})
function selectTag(tag) { selectedTag.value = tag; tagSearch.value = tag || ''; tagDropdownOpen.value = false }
function clearTag() { selectedTag.value = ''; tagSearch.value = ''; tagDropdownOpen.value = false }
function focusTagPicker() {
  tagDropdownOpen.value = true
  nextTick(() => {
    const inp = tagPickerRef.value?.querySelector('input')
    if (inp) inp.focus()
  })
}

// ===== 分类统计 =====
const needTag = computed(() => !!rawData.value.needTag)
const visibleClusters = computed(() => (rawData.value.clusters || []).filter(c => !hiddenCats.value.has(c.cat)))
function toggleCat(catKey) {
  const s = new Set(hiddenCats.value)
  if (s.has(catKey)) s.delete(catKey); else s.add(catKey)
  hiddenCats.value = s
  nextTick(() => drawSVG())
}

const catStatsList = computed(() => {
  const stats = rawData.value.catStats || {}
  const total = rawData.value.total || 0
  return CATS.map(c => ({
    ...c,
    count: stats[c.key] || 0,
    pct: total ? Math.round((stats[c.key] || 0) / total * 100) : 0,
  }))
})

// ===== 纯 SVG 散点图 =====
const W = 1000, H = 700
const M = { top: 32, right: 28, bottom: 56, left: 56 }
const PW = W - M.left - M.right
const PH = H - M.top - M.bottom

function fnvHash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function jitterVal(classId, axis) {
  const h = fnvHash(classId + axis)
  return ((h % 700) / 700 - 0.5) * 2.2
}
function toX(pct) { return M.left + (pct / 100) * PW }
function toY(pct) { return M.top + ((100 - pct) / 100) * PH }

function drawSVG() {
  const svg = svgRef.value
  if (!svg) return
  const pb = rawData.value.clusters || []
  const visCats = new Set(CATS.filter(c => !hiddenCats.value.has(c.key)).map(c => c.key))
  let html = ''

  // —— 网格 ——
  for (let i = 0; i <= 100; i += 20) {
    const x = toX(i), y = toY(i)
    html += `<line x1="${x}" y1="${M.top}" x2="${x}" y2="${H - M.bottom}" stroke="rgba(0,0,0,0.07)" stroke-dasharray="4,6" stroke-width="1"/>`
    html += `<line x1="${M.left}" y1="${y}" x2="${W - M.right}" y2="${y}" stroke="rgba(0,0,0,0.07)" stroke-dasharray="4,6" stroke-width="1"/>`
    html += `<text x="${x}" y="${H - M.bottom + 20}" text-anchor="middle" fill="#64748b" font-size="12" font-weight="500">${i}%</text>`
    html += `<text x="${M.left - 10}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="12" font-weight="500">${i}%</text>`
  }

  // —— 坐标轴线（加粗） ——
  html += `<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${H - M.bottom}" stroke="rgba(0,0,0,0.20)" stroke-width="1.5"/>`
  html += `<line x1="${M.left}" y1="${H - M.bottom}" x2="${W - M.right}" y2="${H - M.bottom}" stroke="rgba(0,0,0,0.20)" stroke-width="1.5"/>`

  // —— 坐标轴箭头 ——
  html += `<polygon points="${W - M.right + 6},${H - M.bottom} ${W - M.right - 6},${H - M.bottom - 3.5} ${W - M.right - 6},${H - M.bottom + 3.5}" fill="rgba(0,0,0,0.20)"/>`
  html += `<polygon points="${M.left},${M.top - 6} ${M.left - 3.5},${M.top + 4} ${M.left + 3.5},${M.top + 4}" fill="rgba(0,0,0,0.20)"/>`

  // —— 40 / 60 虚线边界 ——
  ;[40, 60].forEach(v => {
    html += `<line x1="${toX(v)}" y1="${M.top}" x2="${toX(v)}" y2="${H - M.bottom}" stroke="rgba(148,163,184,0.35)" stroke-dasharray="6,4"/>`
    html += `<line x1="${M.left}" y1="${toY(v)}" x2="${W - M.right}" y2="${toY(v)}" stroke="rgba(148,163,184,0.35)" stroke-dasharray="6,4"/>`
  })

  // —— 中心蓝色半透明框 (40-60) ——
  html += `<rect x="${toX(40)}" y="${toY(60)}" width="${toX(60) - toX(40)}" height="${toY(40) - toY(60)}" fill="rgba(59,130,246,0.04)" stroke="rgba(59,130,246,0.2)" stroke-width="1" stroke-dasharray="5,3" rx="3"/>`

  // —— 四角标注 ——
  html += `<text x="${M.left + 8}" y="${M.top + 42}" fill="#ef4444" font-size="14" font-weight="700">人审>60%</text>`
  html += `<text x="${M.left + 8}" y="${M.top + 58}" fill="#ef4444" font-size="14" font-weight="700">机审<40%</text>`
  html += `<text x="${W - M.right - 6}" y="${H - M.bottom - 30}" text-anchor="end" fill="#f97316" font-size="14" font-weight="700">机审>60%</text>`
  html += `<text x="${W - M.right - 6}" y="${H - M.bottom - 16}" text-anchor="end" fill="#f97316" font-size="14" font-weight="700">人审<40%</text>`
  html += `<text x="${W - M.right - 6}" y="${M.top + 28}" text-anchor="end" fill="#22c55e" font-size="12.5" font-weight="600" opacity="0.8">双高·一致</text>`
  html += `<text x="${M.left + 8}" y="${H - M.bottom - 14}" fill="#475569" font-size="12.5" font-weight="700" opacity="0.9">双低</text>`

  // —— 轴标签 ——
  html += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle" fill="#475569" font-size="13" font-weight="600">机审标签命中占比（%）</text>`
  html += `<text x="11" y="${H / 2}" text-anchor="middle" fill="#475569" font-size="13" font-weight="600" transform="rotate(-90,11,${H / 2})">人审标签命中占比（%）</text>`

  // —— 散点（全量簇过多时，按规模降序仅绘制前 MAX_DOTS，保证交互可用） ——
  const MAX_DOTS = 6000
  let dots = pb
  if (dots.length > MAX_DOTS) {
    dots = [...dots].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, MAX_DOTS)
  }
  for (const c of dots) {
    if (!visCats.has(c.cat)) continue
    const cat = CATS.find(x => x.key === c.cat) || {}
    const cx = toX(c.machinePct + jitterVal(c.classId, 'm'))
    const cy = toY(c.humanPct + jitterVal(c.classId, 'h'))
    const r = Math.max(2.5, Math.min(8, Math.log2((c.total || 1) + 1) * 1.5))
    html += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${cat.color || '#94a3b8'}" opacity="0.82" stroke="#fff" stroke-width="1.2"
      data-cid="${c.classId}" data-cat="${c.cat}" data-h="${c.humanPct}" data-m="${c.machinePct}" data-n="${c.total}" data-mh="${c.machineHits}" data-hh="${c.humanHits}"
      style="cursor:pointer;transition:opacity 0.12s" class="scatter-dot"/>`
  }

  svg.innerHTML = html

  svg.querySelectorAll('circle.scatter-dot').forEach(el => {
    el.addEventListener('mousemove', (e) => onDotHover(e, el))
    el.addEventListener('mouseleave', hideTip)
    el.addEventListener('click', () => { const cid = el.dataset.cid; if (cid) openDetail(cid) })
  })
}

function onDotHover(e, el) {
  const ds = el.dataset
  tipData.show = true
  tipData.classId = ds.cid; tipData.cat = ds.cat
  tipData.humanPct = Number(ds.h); tipData.machinePct = Number(ds.m)
  tipData.total = Number(ds.n); tipData.mh = Number(ds.mh); tipData.hh = Number(ds.hh)
  tipData.x = e.clientX + 14; tipData.y = e.clientY - 10
  highlightedClassId.value = ds.cid
}
function hideTip() { tipData.show = false; highlightedClassId.value = '' }

// ===== 簇列表 =====
const sortedClusters = computed(() => {
  let list = [...visibleClusters.value]
  if (clusterSearch.value.trim()) {
    const q = clusterSearch.value.trim().toLowerCase()
    list = list.filter(c => c.classId.toLowerCase().includes(q))
  }
  if (listCatFilter.value) list = list.filter(c => c.cat === listCatFilter.value)
  if (listWatchOnly.value) list = list.filter(c => watchedClusters.value.includes(c.classId))
  if (listSort.value === 'machine') list.sort((a, b) => b.machinePct - a.machinePct)
  else if (listSort.value === 'human') list.sort((a, b) => b.humanPct - a.humanPct)
  else list.sort((a, b) => b.total - a.total)
  return list
})
// 列表渲染上限：全量簇过多时避免一次性渲染数万行 DOM 卡死页面
const LIST_PAGE = 200
const listLimit = ref(LIST_PAGE)
const limitedClusters = computed(() => sortedClusters.value.slice(0, listLimit.value))
const listMore = () => { listLimit.value += LIST_PAGE }
watch(() => [rawData.value.total, clusterSearch.value, listCatFilter.value, listSort.value], () => { listLimit.value = LIST_PAGE })

function onListRowClick(c) { openDetail(c.classId) }
function highlightList(cid) { highlightedClassId.value = cid }
function isWatched(cid) { return watchedClusters.value.includes(cid) }
function toggleWatch(cid) {
  const set = new Set(watchedClusters.value)
  const nowOn = !set.has(cid)
  if (nowOn) set.add(cid)
  else set.delete(cid)
  watchedClusters.value = [...set]
  // 点击关注后，自动展示「我的关注簇」（激活我的关注筛选）
  if (nowOn) listWatchOnly.value = true
}

// ===== 弹窗 =====
async function openDetail(classId) {
  detailModal.open = true; detailModal.classId = classId; detailModal.page = 1; await loadElements()
}
async function loadElements() {
  detailModal.loading = true
  try {
    const params = { classId: detailModal.classId, page: detailModal.page, pageSize: detailModal.pageSize }
    if (selectedTag.value) params.tagId = selectedTag.value
    if (elementType.value) params.elementType = elementType.value
    if (props.dateRange?.start) params.start = props.dateRange.start
    if (props.dateRange?.end) params.end = props.dateRange.end
    const res = await overviewApi.clusterElements(params)
    detailModal.elements = res.elements || []; detailModal.total = res.total || 0
  } catch (e) { detailModal.elements = []; detailModal.total = 0 }
  finally { detailModal.loading = false }
}
function closeDetail() { detailModal.open = false }
function onDetailPageChange(p) { detailModal.page = p; loadElements() }

// ===== 工具 =====
function isVideoType(et) { return et && (et.includes('VIDEO') || et === '4') }
function isImageType(et) { return et && (et.includes('IMAGE') || et === '2' || et === '3') }
function typeLabel(et) { if (isVideoType(et)) return 'Video'; if (isImageType(et)) return 'Image'; return 'Text' }
function fineTypeLabel(t) {
  const s = String(t || '')
  if (s.includes('视频')) return 'Video'
  if (s.includes('图片')) return 'Image'
  return s || '未知'
}
function hasMedia(el) { return el.elementValue && isMediaUrl(el.elementValue) }
function parseTagIds(str) { return String(str || '').replace(/[[\]\s]/g, '').split(',').filter(Boolean) }

const subtitle = computed(() => {
  if (internalTab.value === 'fine') return '基于样本库精标数据 · 两类口径：一致（绿） / 分歧（琥珀）'
  const parts = [`共 ${rawData.value.total || 0} 个聚类簇（已排除 noise）`]
  if (selectedTag.value) parts.push(`标签 ${selectedTag.value}`)
  if (elementType.value === 'image') parts.push('仅图片')
  else if (elementType.value === 'video') parts.push('仅视频')
  return parts.join(' · ')
})

const tipCatInfo = computed(() => CATS.find(c => c.key === tipData.cat) || {})

// ================================================================
//  样本库精标数据（Fine Label / SL2）模块
// ================================================================
const fineLoading = ref(false)
const fineHasData = ref(false)
const fineCount = ref(0)
const fineStats = reactive({ consistent: { clusters: 0, elements: 0, high: { clusters: 0, elements: 0 }, low: { clusters: 0, elements: 0 } }, disagree: { clusters: 0, elements: 0 } })
const fineClusters = ref([])
const fineHistogram = ref([]) // { min, max, count }[]
const fineSort = ref('ratio') // 'ratio' | 'n'
const fineLabelId = ref('') // 精标命中率参照标签（后端必填，否则无法判定占比）
const fineBarBucket = ref(-1) // 点击直方图下钻的区间索引，-1 表示全部
const fineListFilter = ref('') // '' | 'cons_high' | 'cons_low' | 'disagree'
const fineClusterSearch = ref('')

// 切换参照标签 / 排序方式时重新加载精标数据
watch(() => [fineLabelId.value, fineSort.value], () => {
  if (props.activePanel === 'fine') loadFineData()
})

// 精标弹窗
const fineModal = reactive({ open: false, clusterId: '', loading: false, elements: [], total: 0 })

// 加载时机：外部指定 fine 面板
watch(() => props.activePanel, (panel) => {
  if (panel !== 'fine') return
  loadFineData()
})

async function loadFineData() {
  fineLoading.value = true
  try {
    // 未选定标签时后端无法判定「命中率」参照（会退化为全 100% 失真），先取可用标签并默认第一个
    if (!fineLabelId.value) {
      try {
        const lb = await badcaseApi.labels()
        const arr = Array.isArray(lb) ? lb : (Array.isArray(lb?.labels) ? lb.labels : [])
        if (arr.length) fineLabelId.value = String(arr[0])
      } catch { /* 忽略，交由下方请求自然报错 */ }
    }
    const [statsData, clustersData, histData] = await Promise.all([
      badcaseApi.stats(fineLabelId.value),
      badcaseApi.clusters(fineLabelId.value, fineSort.value),
      badcaseApi.histogram(fineLabelId.value),
    ])
    fineStats.consistent = statsData.consistent || { clusters: 0, elements: 0, high: { clusters: 0, elements: 0 }, low: { clusters: 0, elements: 0 } }
    fineStats.disagree = statsData.disagree || { clusters: 0, elements: 0 }
    fineClusters.value = clustersData.clusters || []
    fineHistogram.value = histData.buckets || []
    fineHasData.value = true
    fineCount.value = (clustersData.clusters || []).length
  } catch (e) {
    console.error('fine-label error', e)
    fineHasData.value = false
    fineCount.value = 0
  } finally { fineLoading.value = false }
}

// 组件挂载时检查精标数据是否存在（不依赖 activeTab）
onMounted(async () => {
  try {
    const r = await badcaseApi.hasData()
    fineHasData.value = !!r?.hasData
    fineCount.value = r?.count || 0
  } catch { fineHasData.value = false }
})

const fineFilteredClusters = computed(() => {
  let list = [...fineClusters.value]
  if (fineClusterSearch.value.trim()) {
    const q = fineClusterSearch.value.trim().toLowerCase()
    list = list.filter(c => c.clusterId.toLowerCase().includes(q))
  }
  if (fineBarBucket.value >= 0) {
    const bucket = fineHistogram.value[fineBarBucket.value]
    if (bucket) list = list.filter(c => c.ratio >= bucket.min && c.ratio < bucket.max)
  }
  if (fineListFilter.value) list = list.filter(c => c.zone === fineListFilter.value)
  if (fineSort.value === 'n') list.sort((a, b) => b.total - a.total)
  else list.sort((a, b) => Math.abs(b.ratio - 50) - Math.abs(a.ratio - 50))
  return list
})

function changeFineSort(s) {
  fineSort.value = s
  loadFineData()
}

function fineZoneColor(zone) {
  if (zone === 'disagree') return '#f59e0b'
  if (zone === 'cons_high') return '#4ade80'
  return '#86efac'
}
function fineZoneLabel(zone) {
  if (zone === 'disagree') return '精标分歧'
  if (zone === 'cons_high') return '擦边打标高'
  return '擦边打标低'
}

function fineBarClick(idx) {
  if (fineBarBucket.value === idx) { fineBarBucket.value = -1; return }
  fineBarBucket.value = idx
}

async function openFineDetail(clusterId) {
  fineModal.open = true; fineModal.clusterId = clusterId; fineModal.loading = true
  try {
    const res = await badcaseApi.clusterElements(clusterId)
    fineModal.elements = res.elements || []; fineModal.total = res.total || 0
  } catch { fineModal.elements = []; fineModal.total = 0 }
  finally { fineModal.loading = false }
}
function closeFineDetail() { fineModal.open = false }

// 直方图 SVG 绘制
const fineHistSvg = ref(null)
function drawFineHistogram() {
  const svg = fineHistSvg.value
  if (!svg || !fineHistogram.value.length) return
  const buckets = fineHistogram.value
  const W = 1000, H = 320, M = { top: 20, right: 20, bottom: 40, left: 48 }
  const PW = W - M.left - M.right, PH = H - M.top - M.bottom
  const maxCount = Math.max(...buckets.map(b => b.count), 1)
  const barW = PW / buckets.length - 2

  let html = ''
  // Y 轴刻度
  for (let i = 0; i <= 5; i++) {
    const y = M.top + PH - (i / 5) * PH
    const val = Math.round(maxCount * i / 5)
    html += `<line x1="${M.left}" y1="${y}" x2="${W - M.right}" y2="${y}" stroke="rgba(0,0,0,0.06)" stroke-dasharray="4,4"/>`
    html += `<text x="${M.left - 6}" y="${y + 4}" text-anchor="end" fill="#64748b" font-size="11">${val}</text>`
  }
  // X 轴标签
  buckets.forEach((b, i) => {
    const x = M.left + i * (PW / buckets.length) + (PW / buckets.length) / 2
    html += `<text x="${x}" y="${H - M.bottom + 18}" text-anchor="middle" fill="#64748b" font-size="10">${b.min}%</text>`
  })
  // 分区底色
  html += `<rect x="${M.left}" y="${M.top}" width="${(40 / 100) * PW}" height="${PH}" fill="rgba(34,197,94,0.06)" />`
  html += `<rect x="${M.left + (40 / 100) * PW}" y="${M.top}" width="${(20 / 100) * PW}" height="${PH}" fill="rgba(245,158,11,0.06)" />`
  html += `<rect x="${M.left + (60 / 100) * PW}" y="${M.top}" width="${(40 / 100) * PW}" height="${PH}" fill="rgba(34,197,94,0.06)" />`
  // 40/60 虚线
  ;[40, 60].forEach(v => {
    const x = M.left + (v / 100) * PW
    html += `<line x1="${x}" y1="${M.top}" x2="${x}" y2="${H - M.bottom}" stroke="rgba(148,163,184,0.4)" stroke-dasharray="5,3"/>`
  })
  // 柱状图
  buckets.forEach((b, i) => {
    const barH = maxCount > 0 ? (b.count / maxCount) * PH : 0
    const x = M.left + i * (PW / buckets.length) + 1
    const y = M.top + PH - barH
    const mid = b.min + 5 // 区间中值
    const color = mid < 40 ? '#86efac' : mid > 60 ? '#4ade80' : '#f59e0b'
    const hl = fineBarBucket.value === i
    html += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="2" opacity="${hl ? 1 : 0.75}" stroke="${hl ? '#1e293b' : 'transparent'}" stroke-width="${hl ? 2 : 0}" style="cursor:pointer" data-idx="${i}" class="fine-bar"/>`
    if (b.count > 0) html += `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" fill="#475569" font-size="10" font-weight="600">${b.count}</text>`
  })
  svg.innerHTML = html
  svg.querySelectorAll('rect.fine-bar').forEach(el => {
    el.addEventListener('click', () => fineBarClick(Number(el.dataset.idx)))
  })
}

watch(fineBarBucket, () => {})
watch(fineHistogram, () => nextTick(drawFineHistogram), { deep: true })
</script>

<template>
  <div class="cv-root">
    <!-- ===== 标题行：象限分析 · 聚类簇 + 内部Tab（AI评测数据 / 样本库精标数据） + 公用筛选（标签搜索 + 元素类型） ===== -->
    <header class="cv-header">
      <div class="cv-h-left">
        <div class="cv-h-title-row">
          <h1>象限分析 · 聚类簇</h1>
          <!-- 内部 Tab 切换 -->
          <div class="cv-page-tabbar">
            <button class="cv-page-tab" :class="{ active: internalTab === 'ai' }" @click="internalTab = 'ai'">AI评测数据</button>
          </div>
        </div>
        <span class="cv-h-sub">{{ subtitle }}</span>
      </div>

      <!-- 公用控件：标签搜索 + 元素类型 -->
      <div class="cv-h-ctrls">
        <div class="cv-tag-picker" ref="tagPickerRef">
          <div class="cv-tp-inner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input v-model="tagSearch" placeholder="搜索标签ID…" @focus="tagDropdownOpen = true" @input="tagDropdownOpen = true" />
            <button v-if="selectedTag" @click.stop="clearTag" title="清除">&times;</button>
          </div>
          <div v-if="tagDropdownOpen && filteredTags.length" class="cv-tp-drop">
            <button v-if="!selectedTag" class="on" @click="selectTag('')">全部标签</button>
            <button v-for="t in filteredTags" :key="t" :class="{ on: selectedTag === String(t) }" @click="selectTag(String(t))">{{ t }}</button>
          </div>
        </div>
        <div class="cv-seg">
          <button :class="{ on: !elementType }" @click="elementType = ''">全部</button>
          <button :class="{ on: elementType === 'image' }" @click="elementType = 'image'">图片</button>
          <button :class="{ on: elementType === 'video' }" @click="elementType = 'video'">视频</button>
        </div>
      </div>
    </header>

    <!-- ============ AI评测数据 Panel ============ -->
    <template v-if="internalTab === 'ai'">

    <!-- 未选择标签引导：人机分歧象限需基于具体标签的命中占比 -->
    <div v-if="needTag" class="cv-needtag">
      <div class="cv-needtag-icon">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L4 14.17V4h10.17l6.42 6.42a2 2 0 0 1 0 2.83Z"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/></svg>
      </div>
      <div class="cv-needtag-body">
        <div class="cv-needtag-title">人机分歧象限分析需先选择一个标签</div>
        <div class="cv-needtag-desc">机审占比 / 人审占比 按「该标签」在簇内样本中的命中占比计算（机审命中 = policy_ids 含该标签，人审命中 = 人审标签含该标签），再按 40% / 60% 边界划分七类。未选标签时无法界定「命中标签」，请在上方标签搜索中选择一个标签 ID。</div>
        <button class="cv-needtag-btn" @click="focusTagPicker">去选择标签</button>
      </div>
    </div>

    <!-- 已选标签：七类统计卡 + 散点图 + 簇列表 -->
    <template v-else>

    <!-- 七类统计卡 -->
    <div class="cv-stats">
      <div
        v-for="c in catStatsList" :key="c.key"
        class="cv-stat-card"
        :class="{ dimmed: hiddenCats.has(c.key) }"
        :style="{ '--c': c.color }"
        @click="toggleCat(c.key)"
      >
        <div class="cv-sc-top">
          <i class="cv-sc-dot" :style="{ background: c.color }"></i>
          <span class="cv-sc-label">{{ c.name }}</span>
        </div>
        <div class="cv-sc-bottom">
          <span class="cv-sc-val">{{ c.count }}</span>
          <span class="cv-sc-pct" v-if="c.pct > 0">{{ c.pct }}%</span>
        </div>
      </div>
    </div>

    <!-- 主布局：左散点图 + 右簇列表 -->
    <div class="cv-main">
      <!-- 左：散点图 -->
      <div class="cv-chart">
        <div class="cv-chart-hd">
          <span class="cv-chart-title">人机分歧象限图</span>
          <div class="cv-legend">
            <span
              v-for="c in CATS" :key="c.key"
              class="cv-lgd"
              :class="{ off: hiddenCats.has(c.key) }"
              @click="toggleCat(c.key)"
            >
              <i :style="{ background: c.color }"></i>{{ c.name }}
            </span>
          </div>
        </div>

        <div v-if="loading" class="cv-empty"><span class="cv-spin"></span>加载中…</div>
        <div v-else-if="!rawData.total" class="cv-empty cv-empty-fine" style="min-height:0;padding:40px 0"><span>暂无聚类簇数据</span></div>
        <div v-else class="cv-svg-wrap">
<svg ref="svgRef" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet" class="cv-svg"></svg>
        </div>

        <div class="cv-chart-foot">横轴 = 机审标签命中占比（%） · 纵轴 = 人审标签命中占比（%） · 虚线 = 40 / 60 边界 · 气泡大小 ∝ 簇规模<span v-if="visibleClusters.length > 6000" class="cv-chart-limit">（簇数过多，散点仅展示规模前 6000 簇）</span></div>
      </div>

      <!-- 右：簇列表 -->
      <div class="cv-list">
        <div class="cv-list-hd">
          <span class="cv-list-title">{{ listWatchOnly ? '我的关注簇' : '聚类簇列表' }}</span>
          <div class="cv-sort-btns">
            <button :class="{ on: listSort === 'size' }" @click="listSort = 'size'">规模</button>
            <button :class="{ on: listSort === 'machine' }" @click="listSort = 'machine'">机审</button>
            <button :class="{ on: listSort === 'human' }" @click="listSort = 'human'">人审</button>
          </div>
        </div>

        <div class="cv-list-ctrl">
          <div class="cv-lsearch">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input v-model="clusterSearch" placeholder="搜索聚类ID…" />
            <button v-if="clusterSearch" @click="clusterSearch = ''">&times;</button>
          </div>
          <div class="cv-lfilters">
            <button :class="{ on: !listCatFilter }" @click="listCatFilter = ''">全部</button>
            <button
              class="cv-watch-filter"
              :class="{ on: listWatchOnly }"
              @click="listWatchOnly = !listWatchOnly"
            >
              <Icon name="star" :size="12" />我的关注<span v-if="watchedClusters.length" class="cv-watch-cnt">{{ watchedClusters.length }}</span>
            </button>
            <button
              v-for="c in CATS" :key="c.key"
              :class="{ on: listCatFilter === c.key }"
              :style="listCatFilter === c.key ? { background: c.color, color: c.key === 'dual-low' ? '#334155' : '#fff', borderColor: c.color } : {}"
              @click="listCatFilter = listCatFilter === c.key ? '' : c.key"
            >{{ c.name }}</button>
          </div>
        </div>

        <div v-if="loading" class="cv-empty"><span class="cv-spin"></span></div>
        <div v-else class="cv-list-body">
          <div
            v-for="c in limitedClusters" :key="c.classId"
            class="cv-lrow"
            :class="{ hl: highlightedClassId === c.classId }"
            @mouseenter="highlightList(c.classId)"
            @mouseleave="highlightList('')"
            @click="onListRowClick(c)"
          >
            <div class="cv-ltop">
              <button
                class="cv-watch"
                :class="{ on: isWatched(c.classId) }"
                :title="isWatched(c.classId) ? '取消关注' : '加入我的关注'"
                @click.stop="toggleWatch(c.classId)"
              ><Icon name="star" :size="13" /></button>
              <span class="cv-lcid">{{ c.classId }}</span>
              <span class="cv-lbadge" :style="{ background: (CATS.find(x => x.key === c.cat) || {}).color, color: c.cat === 'dual-low' ? '#334155' : '#fff' }">{{ (CATS.find(x => x.key === c.cat) || {}).name }}</span>
              <span class="cv-lsize">{{ c.total }}</span>
            </div>
            <div class="cv-lbars">
              <div class="cv-lbar-line">
<span class="cv-lbar-lbl">机审占比</span>
                <div class="cv-lbar-track"><div class="cv-lbar-fill" :style="{ width: c.machinePct + '%', background: '#0ea5e9' }"></div></div>
                <span class="cv-lbar-val">{{ c.machinePct }}%</span>
              </div>
              <div class="cv-lbar-line">
<span class="cv-lbar-lbl">人审占比</span>
                <div class="cv-lbar-track"><div class="cv-lbar-fill" :style="{ width: c.humanPct + '%', background: '#a855f7' }"></div></div>
                <span class="cv-lbar-val">{{ c.humanPct }}%</span>
              </div>
            </div>
          </div>
          <div v-if="!sortedClusters.length" class="cv-empty">{{ listWatchOnly ? '暂无关注的簇，点击簇前方的星形图标即可加入关注' : '无匹配的聚类簇' }}</div>
          <div v-else-if="sortedClusters.length > listLimit" class="cv-list-more">
            <span>共 {{ sortedClusters.length }} 簇，已显示前 {{ listLimit }} 个（可用搜索/分类筛选缩小范围）</span>
            <button @click="listMore">加载更多</button>
          </div>
        </div>
      </div>
    </div>

    </template>

    <!-- 指标解释面板（散点图下方常驻，可折叠） -->
    <div class="cv-metric-wrap">
      <div class="cv-mp-header" @click="metricExpanded = !metricExpanded">
        <span class="cv-mp-hdot"></span> 指标解释
        <svg class="cv-mp-arrow" :class="{ expanded: metricExpanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="cv-mp-body" :class="{ collapsed: !metricExpanded }">
        <table class="cv-metric-tbl">
          <thead>
            <tr><th>分类</th><th>判定条件</th><th>业务含义</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="cv-mt-dot" style="background:#ef4444"></span>人机不一致（左上）</td>
              <td>人审 > 60% 且 机审 < 40%</td>
              <td>人审多数命中标签、机审多数未命中 → 人机分歧明显，需排查漏放风险</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#f97316"></span>人机不一致（右下）</td>
              <td>机审 > 60% 且 人审 < 40%</td>
              <td>机审多数命中标签、人审多数未命中 → 人机分歧明显，需排查误杀风险</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#a855f7"></span>横条*人审分歧</td>
              <td>40% ≤ 人审 ≤ 60% 且 机审两极 (&gt;60% 或 &lt;40%)</td>
              <td>人审内部意见不统一</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#0ea5e9"></span>横条*机审分歧</td>
              <td>40% ≤ 机审 ≤ 60% 且 人审两极 (&gt;60% 或 &lt;40%)</td>
              <td>机审判定不稳定</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#3b82f6"></span>中心·双分歧</td>
              <td>40% &lt; 机审 &lt; 60% 且 40% &lt; 人审 &lt; 60%</td>
              <td>双方都拿不准，边界争议</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#22c55e"></span>双高（其他）</td>
              <td>机审 > 60% 且 人审 > 60%</td>
              <td>人机一致（共识高）</td>
            </tr>
            <tr>
              <td><span class="cv-mt-dot" style="background:#94a3b8"></span>双低（其他）</td>
              <td>机审 < 40% 且 人审 < 40%</td>
              <td>人机一致（共识低），弱化灰色</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tooltip（深色半透明，参照文档风格） -->
    <div v-if="tipData.show" class="cv-tip" :style="{ left: tipData.x + 'px', top: tipData.y + 'px' }">
      <div class="cv-tip-cid">聚类簇 {{ tipData.classId }}</div>
      <div class="cv-tip-cat" :style="{ background: tipCatInfo.color, color: '#fff' }">{{ tipCatInfo.name || tipData.cat }}</div>
      <div class="cv-tip-row"><span>机审命中占比</span><b>{{ tipData.machinePct }}%</b><span class="cv-tip-sub">（{{ tipData.mh }} / {{ tipData.total }}）</span></div>
      <div class="cv-tip-row"><span>人审命中占比</span><b>{{ tipData.humanPct }}%</b><span class="cv-tip-sub">（{{ tipData.hh }} / {{ tipData.total }}）</span></div>
      <div class="cv-tip-hint">点击查看簇元素明细</div>
    </div>

    <!-- 弹窗 -->
    <teleport to="body">
      <div v-if="detailModal.open" class="cv-modal-mask" @click.self="closeDetail">
        <div class="cv-modal">
          <div class="cv-modal-hd">
            <h3>聚类簇 {{ detailModal.classId }} · 元素明细</h3>
            <button @click="closeDetail"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="cv-modal-body">
            <div v-if="detailModal.loading" class="cv-empty"><span class="cv-spin"></span>正在加载元素…</div>
            <div v-else-if="!detailModal.elements.length" class="cv-empty">该簇暂无元素数据</div>
            <div v-else class="cv-el-list">
              <div v-for="(el, i) in detailModal.elements" :key="i" class="cv-el-row">
                <div class="cv-el-thumb">
                  <template v-if="hasMedia(el) && isVideoType(el.elementType)">
                    <video v-lazy-video :data-src="el.elementValue" :data-raw-url="el.elementValue" controls playsinline muted @error="onMediaError"></video>
                  </template>
                  <template v-else-if="hasMedia(el) && isImageType(el.elementType)">
                    <img :src="previewSrc(el.elementValue)" :data-raw-url="el.elementValue" referrerpolicy="no-referrer" @error="onMediaError" alt="" />
                  </template>
                  <template v-else-if="el.elementValue && isMediaUrl(el.elementValue)">
                    <a :href="previewSrc(el.elementValue)" target="_blank" @click.stop class="cv-el-link">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f7cff" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </template>
                  <template v-else>
                    <div class="cv-el-no-media">{{ typeLabel(el.elementType) }}</div>
                  </template>
                </div>
                <div class="cv-el-info">
                  <div class="cv-el-head">
                    <span class="cv-el-type-badge" :class="{ vid: isVideoType(el.elementType), img: isImageType(el.elementType) }">{{ typeLabel(el.elementType) }}</span>
                    <span class="cv-el-fp" v-if="el.elementFingerprint">{{ el.elementFingerprint.slice(0, 16) }}</span>
                    <span class="cv-el-time" v-if="el.arriveTime">{{ el.arriveTime }}</span>
                  </div>
                  <div v-if="el.ocrContent" class="cv-el-ocr"><span class="cv-el-tag-label">OCR</span>{{ el.ocrContent.slice(0, 180) }}</div>
                  <div v-if="el.asrContent" class="cv-el-ocr asr"><span class="cv-el-tag-label asr">ASR</span>{{ el.asrContent.slice(0, 180) }}</div>
                  <div class="cv-el-tags-row">
                    <span v-if="parseTagIds(el.policyIds).length" class="cv-el-hit mh"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>机审: {{ parseTagIds(el.policyIds).join(', ') }}</span>
                    <span v-else class="cv-el-pass">机审: 通过</span>
                    <span v-if="parseTagIds(el.aiEvaluatePolicyIds).length" class="cv-el-hit hh"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>人审: {{ parseTagIds(el.aiEvaluatePolicyIds).join(', ') }}</span>
                    <span v-else class="cv-el-pass">人审: 通过</span>
                  </div>
                  <div v-if="el.firstLevelIndustry || el.secondLevelIndustry" class="cv-el-ind">{{ el.firstLevelIndustry }}{{ el.secondLevelIndustry ? ' / ' + el.secondLevelIndustry : '' }}</div>
                </div>
              </div>
            </div>
            <Pager v-if="detailModal.total > detailModal.pageSize" :total="detailModal.total" :page-size="detailModal.pageSize" :modelValue="detailModal.page" @update:modelValue="onDetailPageChange" />
          </div>
        </div>
      </div>
    </teleport>
    </template>

    <!-- ============ 样本库精标数据 Panel（已隐藏） ============ -->
    <template v-if="false">

      <!-- 数据加载中提示 -->
      <div v-if="fineLoading" class="cv-empty"><span class="cv-spin"></span>加载中…</div>

      <!-- 完整页面结构（始终展示，无数据时统计为0） -->
      <template v-if="!fineLoading">
        <!-- 三类统计卡 -->
        <div class="cv-stats" style="grid-template-columns: repeat(3, 1fr); gap: 8px">
          <!-- 精标一致·擦边打标高 -->
          <div class="cv-stat-card cv-stat-card-sm" style="--c: #4ade80; cursor: default">
            <div class="cv-sc-top">
              <i class="cv-sc-dot" style="background: #4ade80"></i>
              <span class="cv-sc-label">精标一致·擦边打标高</span>
            </div>
            <div class="cv-sc-bottom">
              <span class="cv-sc-val-sm">{{ fineStats.consistent.high.clusters }}</span>
              <span class="cv-sc-pct">簇</span>
              <span class="cv-sc-pct" style="color: #64748b; margin-left: 2px">{{ fineStats.consistent.high.elements }}元素</span>
            </div>
          </div>
          <!-- 精标一致·擦边打标低 -->
          <div class="cv-stat-card cv-stat-card-sm" style="--c: #86efac; cursor: default">
            <div class="cv-sc-top">
              <i class="cv-sc-dot" style="background: #86efac"></i>
              <span class="cv-sc-label">精标一致·擦边打标低</span>
            </div>
            <div class="cv-sc-bottom">
              <span class="cv-sc-val-sm">{{ fineStats.consistent.low.clusters }}</span>
              <span class="cv-sc-pct">簇</span>
              <span class="cv-sc-pct" style="color: #64748b; margin-left: 2px">{{ fineStats.consistent.low.elements }}元素</span>
            </div>
          </div>
          <!-- 精标分歧 -->
          <div class="cv-stat-card cv-stat-card-sm" style="--c: #f59e0b; cursor: default">
            <div class="cv-sc-top">
              <i class="cv-sc-dot" style="background: #f59e0b"></i>
              <span class="cv-sc-label">精标分歧</span>
            </div>
            <div class="cv-sc-bottom">
              <span class="cv-sc-val-sm">{{ fineStats.disagree.clusters }}</span>
              <span class="cv-sc-pct">簇</span>
              <span class="cv-sc-pct" style="color: #64748b; margin-left: 2px">{{ fineStats.disagree.elements }}元素</span>
            </div>
          </div>
        </div>

        <!-- 元素类型分段 -->
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:2px">
          <div class="cv-seg" style="margin-bottom:0">
            <button :class="{ on: fineBarBucket === -1 }" @click="fineBarBucket = -1">全部</button>
            <button :class="{ on: fineBarBucket >= 0 && fineBarBucket < 4 }" @click="fineBarClick(0)">擦边&lt;40%</button>
            <button :class="{ on: fineBarBucket >= 4 && fineBarBucket < 6 }" @click="fineBarClick(4)">分歧 40-60%</button>
            <button :class="{ on: fineBarBucket >= 6 }" @click="fineBarClick(6)">擦边&gt;60%</button>
          </div>
        </div>

        <!-- 主布局：直方图 + 簇列表 -->
        <div class="cv-main">
          <!-- 左：直方图 -->
          <div class="cv-chart">
            <div class="cv-chart-hd">
              <span class="cv-chart-title">聚类簇分布 · 按擦边标签占比区间统计簇个数</span>
              <div class="cv-legend">
                <span class="cv-lgd"><i style="background: #86efac"></i>一致·低</span>
                <span class="cv-lgd"><i style="background: #f59e0b"></i>分歧</span>
                <span class="cv-lgd"><i style="background: #4ade80"></i>一致·高</span>
              </div>
            </div>
            <div class="cv-svg-wrap">
              <svg v-if="fineHistogram.length" ref="fineHistSvg" viewBox="0 0 1000 320" preserveAspectRatio="xMidYMid meet" class="cv-svg" style="aspect-ratio:3.125/1">
              </svg>
              <div v-else class="cv-empty cv-empty-fine" style="min-height:0;padding:40px 0">
                <span style="display:block;text-align:center;font-size:13px;color:#94a3b8">暂无数据，请先在管理模块上传样本库精标数据</span>
                <span style="display:block;text-align:center;font-size:10.5px;color:#94a3b8;margin-top:4px">X轴 = 擦边标签占比区间（%） · 绿色 = 一致 · 琥珀 = 分歧 · 虚线 = 40 / 60 边界</span>
              </div>
            </div>
          </div>

          <!-- 右：聚类簇列表 -->
          <div class="cv-list">
            <div class="cv-list-hd">
              <span class="cv-list-title">聚类簇列表</span>
              <div class="cv-sort-btns">
                <button :class="{ on: fineSort === 'ratio' }" @click="changeFineSort('ratio')">按一致率</button>
                <button :class="{ on: fineSort === 'n' }" @click="changeFineSort('n')">按规模</button>
              </div>
            </div>
            <div class="cv-list-ctrl">
              <div class="cv-lsearch">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input v-model="fineClusterSearch" placeholder="搜索聚类ID…" />
                <button v-if="fineClusterSearch" @click="fineClusterSearch = ''">&times;</button>
              </div>
              <div class="cv-lfilters">
                <button :class="{ on: !fineListFilter }" @click="fineListFilter = ''">全部</button>
                <button :class="{ on: fineListFilter === 'cons_high' }" style="color:#4ade80;border-color:#4ade80" @click="fineListFilter = fineListFilter === 'cons_high' ? '' : 'cons_high'">精标一致·擦边打标高</button>
                <button :class="{ on: fineListFilter === 'cons_low' }" style="color:#86efac;border-color:#86efac" @click="fineListFilter = fineListFilter === 'cons_low' ? '' : 'cons_low'">精标一致·擦边打标低</button>
                <button :class="{ on: fineListFilter === 'disagree' }" style="color:#f59e0b;border-color:#f59e0b" @click="fineListFilter = fineListFilter === 'disagree' ? '' : 'disagree'">精标分歧</button>
              </div>
            </div>
            <div class="cv-list-body">
              <div
                v-for="c in fineFilteredClusters" :key="c.clusterId"
                class="cv-lrow"
                @click="openFineDetail(c.clusterId)"
              >
                <div class="cv-ltop">
                  <span class="cv-lcid">{{ c.clusterId }}</span>
                  <span class="cv-lbadge" :style="{ background: fineZoneColor(c.zone), color: '#fff' }">{{ fineZoneLabel(c.zone) }}</span>
                  <span class="cv-lsize">{{ c.total }}</span>
                </div>
                <div class="cv-lbars">
                  <div class="cv-lbar-line">
                    <span class="cv-lbar-lbl">擦边占比</span>
                    <div class="cv-lbar-track"><div class="cv-lbar-fill" :style="{ width: c.ratio + '%', background: fineZoneColor(c.zone) }"></div></div>
                    <span class="cv-lbar-val">{{ c.ratio }}%</span>
                  </div>
                </div>
              </div>
              <div v-if="!fineFilteredClusters.length" class="cv-empty">无匹配的聚类簇</div>
            </div>
          </div>
        </div>

        <!-- 指标解释 -->
        <div class="cv-metric-wrap">
          <div class="cv-mp-header">
            <span class="cv-mp-hdot"></span> 指标解释 · 两类口径
          </div>
          <div class="cv-mp-body">
            <table class="cv-metric-tbl">
              <thead>
                <tr><th>分类</th><th>判定条件</th><th>业务含义</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><span class="cv-mt-dot" style="background:#4ade80"></span>精标一致·擦边打标高</td>
                  <td>擦边标签占比 > 60%</td>
                  <td>该标签在此簇中主导，精标结果高度一致</td>
                </tr>
                <tr>
                  <td><span class="cv-mt-dot" style="background:#86efac"></span>精标一致·擦边打标低</td>
                  <td>擦边标签占比 < 40%</td>
                  <td>该标签在此簇中为少数派，精标结果一致（低占比）</td>
                </tr>
                <tr>
                  <td><span class="cv-mt-dot" style="background:#f59e0b"></span>精标分歧</td>
                  <td>40% ≤ 擦边标签占比 ≤ 60%</td>
                  <td>标签在该簇中占比分裂，精标结果存在分歧</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </template>

    <!-- 精标弹窗 -->
    <teleport to="body">
      <div v-if="fineModal.open" class="cv-modal-mask" @click.self="closeFineDetail">
        <div class="cv-modal">
          <div class="cv-modal-hd">
            <h3>簇 {{ fineModal.clusterId }} · 元素明细</h3>
            <button @click="closeFineDetail"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="cv-modal-body">
            <div v-if="fineModal.loading" class="cv-empty"><span class="cv-spin"></span>加载中…</div>
            <div v-else-if="!fineModal.elements.length" class="cv-empty">该簇暂无元素数据</div>
            <div v-else class="cv-el-list">
              <div v-for="(el, i) in fineModal.elements" :key="i" class="cv-el-row">
                <div class="cv-el-thumb">
                  <template v-if="el.elementValue && isMediaUrl(el.elementValue) && (el.elementType || '').includes('视频')">
                    <video v-lazy-video :data-src="el.elementValue" :data-raw-url="el.elementValue" controls playsinline muted @error="onMediaError"></video>
                  </template>
                  <template v-else-if="el.elementValue && isMediaUrl(el.elementValue)">
                    <img :src="previewSrc(el.elementValue)" :data-raw-url="el.elementValue" referrerpolicy="no-referrer" @error="onMediaError" alt="" />
                  </template>
                  <template v-else>
                    <div class="cv-el-no-media">{{ fineTypeLabel(el.elementType) }}</div>
                  </template>
                </div>
                <div class="cv-el-info">
                  <div class="cv-el-head">
                    <span class="cv-el-type-badge" :class="{ vid: (el.elementType || '').includes('视频'), img: (el.elementType || '').includes('图片') }">{{ fineTypeLabel(el.elementType) }}</span>
                    <span class="cv-el-fp" v-if="el.elementFingerprint">{{ el.elementFingerprint.slice(0, 16) }}</span>
                  </div>
                  <div v-if="el.firstLevelIndustry || el.secondLevelIndustry" class="cv-el-ind">{{ el.firstLevelIndustry }}{{ el.secondLevelIndustry ? ' / ' + el.secondLevelIndustry : '' }}</div>
                  <div class="cv-el-tags-row">
                    <span v-for="l in el.fineLabels" :key="l" class="cv-el-hit mh">{{ l }}</span>
                    <span v-if="!el.fineLabels || !el.fineLabels.length" class="cv-el-miss">无标签（通过）</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
/* ==============================================
   浅色主题 · 聚类簇（参照聚类簇改造方案 §三）
   ============================================== */

.cv-root {
  font-family: 'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif;
  color: #1e293b;
  display: flex; flex-direction: column; gap: 14px;
}

/* ===== Header ===== */
.cv-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cv-h-left { display: flex; flex-direction: column; gap: 4px; }
.cv-h-title-row { display: flex; align-items: center; gap: 10px; }
.cv-h-title-row h1 { font-size: 20px; font-weight: 700; color: #1e293b; margin: 0; }
.cv-h-sub { font-size: 12px; color: #64748b; }
.cv-h-ctrls { display: flex; align-items: center; gap: 8px; }

/* Tag picker */
.cv-tag-picker { position: relative; width: 210px; }
.cv-tp-inner {
  display: flex; align-items: center; gap: 6px;
  background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; padding: 0 10px; height: 34px; transition: border-color .15s;
}
.cv-tp-inner:focus-within { border-color: #4f7cff; }
.cv-tp-inner input {
  flex: 1; border: none; outline: none; font-size: 13px; color: #1e293b;
  background: transparent; min-width: 0; font-family: inherit;
}
.cv-tp-inner input::placeholder { color: #94a3b8; }
.cv-tp-inner button { width: 20px; height: 20px; border-radius: 50%; font-size: 14px; color: #94a3b8; background: transparent; flex-shrink: 0; display: grid; place-items: center; }
.cv-tp-drop {
  position: absolute; top: 38px; left: 0; right: 0; z-index: 200;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.12); max-height: 220px; overflow-y: auto; padding: 5px;
}
.cv-tp-drop button { display: block; width: 100%; text-align: left; padding: 7px 12px; border-radius: 6px; font-size: 13px; color: #1e293b; transition: all .1s; }
.cv-tp-drop button:hover { background: #eef2ff; color: #4f7cff; }
.cv-tp-drop button.on { background: #eef2ff; color: #4f7cff; font-weight: 600; }

/* Segment */
.cv-seg { display: inline-flex; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 2px; }
.cv-seg button { padding: 4px 12px; border-radius: 6px; font-size: 12px; color: #64748b; transition: all .12s; }
.cv-seg button.on { background: #eef2ff; color: #4f7cff; font-weight: 600; }
.cv-seg button:hover:not(.on) { background: #f8fafc; }

/* ===== 未选择标签引导 ===== */
.cv-needtag {
  display: flex; align-items: center; gap: 14px;
  background: linear-gradient(135deg, #f0f4ff 0%, #f8fafc 100%);
  border: 1px dashed #b6c8ff; border-radius: 12px;
  padding: 22px 24px; margin-bottom: 10px;
}
.cv-needtag-icon {
  width: 56px; height: 56px; flex-shrink: 0; border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  background: #eef2ff; color: #4f7cff;
}
.cv-needtag-body { flex: 1; min-width: 0; }
.cv-needtag-title { font-size: 15px; font-weight: 700; color: #1e293b; margin-bottom: 6px; }
.cv-needtag-desc { font-size: 12.5px; line-height: 1.7; color: #475569; max-width: 900px; }
.cv-needtag-btn {
  flex-shrink: 0; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600;
  background: #4f7cff; color: #fff; border: none; cursor: pointer; transition: all .15s;
  box-shadow: 0 2px 6px rgba(79,124,255,0.3);
}
.cv-needtag-btn:hover { background: #3b6aff; transform: translateY(-1px); }

/* ===== 七类统计卡 ===== */
.cv-stats { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
.cv-stat-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 10px 12px; cursor: pointer; transition: all .15s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  display: flex; flex-direction: column; gap: 6px;
}
.cv-stat-card:hover { border-color: var(--c, #4f7cff); box-shadow: 0 2px 8px rgba(0,0,0,0.06); transform: translateY(-1px); }
.cv-stat-card.dimmed { opacity: 0.3; }
.cv-stat-card-sm { padding: 8px 12px; gap: 4px; }
.cv-sc-val-sm { font-size: 22px; font-weight: 800; color: var(--c, #1e293b); font-family: 'JetBrains Mono',monospace; line-height: 1; }
.cv-sc-top { display: flex; align-items: center; gap: 5px; }
.cv-sc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.cv-sc-label { font-size: 10.5px; font-weight: 600; color: #334155; line-height: 1.2; }
.cv-sc-bottom { display: flex; align-items: baseline; gap: 5px; }
.cv-sc-val { font-size: 26px; font-weight: 800; color: var(--c, #1e293b); font-family: 'JetBrains Mono',monospace; line-height: 1; }
.cv-sc-pct { font-size: 11px; color: #94a3b8; font-family: 'JetBrains Mono',monospace; }

/* ===== 主布局 ===== */
.cv-main { display: flex; gap: 12px; align-items: flex-start; }

/* ===== 散点图卡片 ===== */
.cv-chart {
  flex: 1; min-width: 0;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
  padding: 16px 18px 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.cv-chart-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; gap: 8px; flex-wrap: wrap; }
.cv-chart-title { font-size: 13px; font-weight: 600; color: #475569; }
.cv-legend { display: flex; gap: 8px; flex-wrap: wrap; }
.cv-lgd { display: flex; align-items: center; gap: 3px; font-size: 10px; color: #64748b; cursor: pointer; user-select: none; transition: opacity .15s; }
.cv-lgd:hover { color: #1e293b; }
.cv-lgd.off { opacity: 0.3; text-decoration: line-through; }
.cv-lgd i { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.cv-svg-wrap { position: relative; }
.cv-svg { width: 100%; height: auto; display: block; }
.cv-chart-foot { margin-top: 6px; font-size: 10.5px; color: #94a3b8; text-align: center; }
.cv-chart-limit { color: #f59e0b; }

/* ===== 指标解释面板（散点图下方） ===== */
.cv-metric-wrap {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04); overflow: hidden;
}
.cv-mp-header {
  display: flex; align-items: center; gap: 7px;
  padding: 11px 18px; font-size: 13.5px; font-weight: 700; color: #1e293b;
  cursor: pointer; user-select: none; transition: background .12s;
}
.cv-mp-header:hover { background: #f8fafc; }
.cv-mp-hdot { width: 6px; height: 14px; border-radius: 3px; background: #4f7cff; flex-shrink: 0; }
.cv-mp-arrow { margin-left: auto; transition: transform .2s; flex-shrink: 0; }
.cv-mp-arrow.expanded { transform: rotate(180deg); }
.cv-mp-body { overflow: hidden; max-height: 700px; transition: max-height .3s ease, opacity .2s; opacity: 1; }
.cv-mp-body.collapsed { max-height: 0; opacity: 0; }
.cv-metric-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.cv-metric-tbl thead { background: #f1f5f9; }
.cv-metric-tbl th {
  color: #475569; font-weight: 600; font-size: 12px; text-align: left;
  padding: 9px 18px; border-bottom: 2px solid #e2e8f0; white-space: nowrap;
}
.cv-metric-tbl td { padding: 10px 18px; color: #475569; border-bottom: 1px solid #f1f5f9; vertical-align: middle; line-height: 1.5; }
.cv-metric-tbl tbody tr:hover { background: #f8fafc; }
.cv-metric-tbl td:first-child { color: #1e293b; font-weight: 600; white-space: nowrap; }
.cv-mt-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: middle; flex-shrink: 0; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }

/* ===== 簇列表卡片 ===== */
.cv-list {
  width: 360px; flex-shrink: 0;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
  padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  max-height: calc(100vh - 180px); min-height: calc(100vh - 260px); display: flex; flex-direction: column;
}
.cv-list-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.cv-list-title { font-size: 13px; font-weight: 600; color: #1e293b; }
.cv-sort-btns { display: inline-flex; gap: 2px; background: #f1f5f9; border-radius: 6px; padding: 2px; }
.cv-sort-btns button { padding: 3px 9px; border-radius: 5px; font-size: 11px; color: #64748b; transition: all .1s; }
.cv-sort-btns button.on { background: #fff; color: #4f7cff; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }

.cv-list-ctrl { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.cv-lsearch {
  display: flex; align-items: center; gap: 5px; padding: 0 9px; height: 30px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 7px; transition: border-color .12s;
}
.cv-lsearch:focus-within { border-color: #4f7cff; }
.cv-lsearch input { flex: 1; border: none; outline: none; font-size: 12px; color: #1e293b; background: transparent; }
.cv-lsearch input::placeholder { color: #94a3b8; }
.cv-lsearch button { font-size: 14px; color: #94a3b8; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; }

.cv-lfilters { display: flex; flex-wrap: wrap; gap: 5px; }
.cv-lfilters button {
  padding: 4px 10px; border-radius: 5px; font-size: 11px; font-weight: 600; color: #64748b;
  background: #f1f5f9; border: 1px solid #e2e8f0; transition: all .12s; white-space: nowrap;
}
.cv-lfilters button:hover { background: #e2e8f0; color: #334155; }
.cv-watch-filter { display: inline-flex; align-items: center; gap: 3px; }
.cv-watch-filter .icon { color: #d97706; }
.cv-watch-filter.on { background: rgba(245,158,11,0.14); color: #b45309; border-color: #f59e0b; }
.cv-watch-filter.on .icon { fill: #f59e0b; }
.cv-watch-cnt {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px;
  background: #f59e0b; color: #fff; font-size: 10px; font-weight: 700; line-height: 1;
}

.cv-list-body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.cv-list-more { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 6px; font-size: 11.5px; color: #94a3b8; }
.cv-list-more button { padding: 5px 14px; border-radius: 8px; border: 1px solid #d8dee9; background: #fff; color: #4f7cff; font-size: 12px; font-weight: 600; cursor: pointer; }
.cv-list-more button:hover { border-color: #4f7cff; background: #eef2ff; }
.cv-lrow {
  display: flex; flex-direction: column; gap: 4px;
  padding: 7px 8px; border-radius: 7px;
  cursor: pointer; transition: all .1s; border: 1px solid transparent;
}
.cv-lrow:hover, .cv-lrow.hl { background: #eef2ff; border-color: rgba(79,124,255,0.25); }
.cv-ltop { display: flex; align-items: center; gap: 6px; }
.cv-watch {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  color: #cbd5e1; background: transparent; border: none; cursor: pointer;
  transition: color .12s, background .12s, transform .12s; padding: 0;
}
.cv-watch:hover { color: #f59e0b; background: rgba(245,158,11,0.12); }
.cv-watch.on { color: #f59e0b; }
.cv-watch.on .icon { fill: #f59e0b; }
.cv-lcid { font-size: 11px; font-weight: 700; color: #334155; min-width: 30px; font-family: 'JetBrains Mono',monospace; }
.cv-lsize { font-size: 12px; font-weight: 700; color: #64748b; min-width: 22px; text-align: right; font-family: 'JetBrains Mono',monospace; margin-left: auto; }
.cv-lbars { display: flex; flex-direction: column; gap: 2px; }
.cv-lbar-line { display: flex; align-items: center; gap: 3px; }
.cv-lbar-lbl { font-size: 9px; color: #94a3b8; width: 44px; font-weight: 600; flex-shrink: 0; }
.cv-lbar-track { flex: 1; height: 4px; background: #f1f5f9; border-radius: 2px; overflow: hidden; }
.cv-lbar-fill { height: 100%; border-radius: 2px; }
.cv-lbar-val { font-size: 10px; color: #64748b; width: 32px; text-align: right; font-family: 'JetBrains Mono',monospace; }
.cv-lbadge { font-size: 10px; padding: 2px 7px; border-radius: 4px; white-space: nowrap; font-weight: 700; flex-shrink: 0; line-height: 1.4; }

/* ===== Tooltip（保留深色半透明，不影响整体浅色主题） ===== */
.cv-tip {
  position: fixed; z-index: 300; pointer-events: none;
  background: rgba(15,23,42,0.96); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px; padding: 12px 15px; font-size: 11.5px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.25);
  max-width: 270px; color: #e2e8f0;
}
.cv-tip-cid { font-size: 13px; font-weight: 700; color: #38bdf8; margin-bottom: 5px; }
.cv-tip-cat { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-bottom: 7px; }
.cv-tip-row { display: flex; align-items: baseline; gap: 5px; margin: 2px 0; }
.cv-tip-row span { color: #94a3b8; font-size: 10.5px; }
.cv-tip-row b { color: #e2e8f0; font-size: 12px; }
.cv-tip-sub { color: #64748b; font-size: 9.5px; }
.cv-tip-hint { margin-top: 7px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 10px; color: #94a3b8; }

/* ===== 公用 ===== */
.cv-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 36px; color: #94a3b8; font-size: 13px; }
.cv-spin {
  width: 16px; height: 16px; border: 2px solid #e2e8f0;
  border-top-color: #4f7cff; border-radius: 50%; animation: cvSpin .6s linear infinite; display: inline-block;
}
@keyframes cvSpin { to { transform: rotate(360deg); } }
.cv-empty .cv-spin { border-top-color: #4f7cff; }

/* ===== 弹窗（浅色主题） ===== */
.cv-modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35);
  z-index: 9999; display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 20px; overflow: auto;
}
.cv-modal {
  width: 940px; max-width: 94vw; max-height: 86vh;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
  display: flex; flex-direction: column; box-shadow: 0 12px 48px rgba(0,0,0,0.15);
}
.cv-modal-hd {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid #e2e8f0;
  position: sticky; top: 0; background: #fff; z-index: 1;
}
.cv-modal-hd h3 { font-size: 14px; font-weight: 600; color: #1e293b; }
.cv-modal-hd button { width: 30px; height: 30px; border-radius: 7px; display: grid; place-items: center; color: #94a3b8; transition: all .12s; }
.cv-modal-hd button:hover { background: #f1f5f9; color: #1e293b; }
.cv-modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; }

.cv-el-list { display: flex; flex-direction: column; gap: 8px; }
.cv-el-row {
  display: flex; gap: 12px; padding: 20px 12px;
  background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; transition: background .1s;
}
.cv-el-row:hover { background: #eef2ff; border-color: rgba(79,124,255,0.2); }
.cv-el-thumb {
  width: 100px; height: 108px; border-radius: 6px; overflow: hidden;
  background: #e2e8f0; flex-shrink: 0; display: grid; place-items: center;
}
.cv-el-thumb img, .cv-el-thumb video { width: 100%; height: 100%; object-fit: cover; }
.cv-el-no-media { color: #94a3b8; font-size: 10px; }
.cv-el-link { color: #4f7cff; transition: color .1s; }
.cv-el-link:hover { color: #4569f5; }
.cv-el-info { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 11px; }
.cv-el-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cv-el-type-badge { padding: 1.5px 6px; border-radius: 4px; font-size: 9.5px; font-weight: 600; }
.cv-el-type-badge.vid { background: rgba(251,146,60,0.12); color: #f97316; }
.cv-el-type-badge.img { background: rgba(59,130,246,0.12); color: #3b82f6; }
.cv-el-fp { color: #94a3b8; font-family: 'JetBrains Mono',monospace; font-size: 9.5px; }
.cv-el-time { color: #94a3b8; font-size: 9.5px; }
.cv-el-ocr { display: flex; gap: 4px; color: #64748b; line-height: 1.4; align-items: flex-start; }
.cv-el-ocr.asr { color: #64748b; }
.cv-el-tag-label { padding: 1px 5px; border-radius: 3px; font-size: 8.5px; font-weight: 600; flex-shrink: 0; background: #eef2ff; color: #4f7cff; }
.cv-el-tag-label.asr { background: #fce7f3; color: #ec4899; }
.cv-el-tags-row { display: flex; gap: 6px; flex-wrap: wrap; }
.cv-el-hit { display: inline-flex; align-items: center; gap: 2px; padding: 1.5px 5px; border-radius: 4px; font-size: 9.5px; }
.cv-el-hit.mh { background: rgba(34,197,94,0.1); color: #16a34a; }
.cv-el-hit.hh { background: rgba(168,85,247,0.1); color: #9333ea; }
.cv-el-pass { display: inline-flex; align-items: center; gap: 2px; padding: 1.5px 5px; border-radius: 4px; font-size: 9.5px; background: #f0fdf4; color: #16a34a; font-weight: 600; }
.cv-el-miss { padding: 1.5px 5px; border-radius: 4px; font-size: 9.5px; background: #f1f5f9; color: #94a3b8; }
.cv-el-ind { color: #94a3b8; font-size: 9.5px; }

/* ===== 响应式 ===== */
@media (max-width: 1100px) {
  .cv-stats { grid-template-columns: repeat(4, 1fr); }
  .cv-main { flex-direction: column; }
  .cv-list { width: 100%; max-height: 380px; }
}
@media (max-width: 700px) {
  .cv-stats { grid-template-columns: repeat(2, 1fr); }
  .cv-header { flex-direction: column; align-items: stretch; }
.cv-tag-picker { width: 100%; }
}

/* ===== 顶层 Tab 切换（标题右侧） ===== */
.cv-page-tabbar {
  display: flex; gap: 2px;
  padding: 3px; background: #e2e8f0; border-radius: 8px;
}
.cv-page-tab {
  padding: 6px 16px; border-radius: 6px; font-size: 13px; font-weight: 700;
  color: #475569; cursor: pointer; transition: all .15s; border: none; background: transparent;
  white-space: nowrap;
}
.cv-page-tab:hover { color: #1e293b; background: rgba(255,255,255,0.5); }
.cv-page-tab.active { background: #4f7cff; color: #fff; box-shadow: 0 2px 6px rgba(79,124,255,0.35); }
</style>
