<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useTicketFlowStore } from '../../stores/ticketFlow'
import { useAuthStore } from '../../stores/auth'
import { tagStatus, precLevel, isSevere } from '../../data/mock'
import { tagApi, dataMetaApi } from '../../api/index'
import { useRemotePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import EChart from '../../components/EChart.vue'
import EmptyState from '../../components/EmptyState.vue'
import Pager from '../../components/Pager.vue'
import { getShareIdFromUrl, openShare } from '../../utils/share'

// 标签列表（真实 API）：保留 remark 可编辑特性
const TAGS = reactive([])
// 标签 × 元素类型 精度（真实 API）：异常指标同维度，供「各标签精度」柱状图按组合拆分展示
const ELEMENT_PRECISION = reactive([])

const router = useRouter()
const toast = useToastStore()
const ticketFlow = useTicketFlowStore()
const auth = useAuthStore()
const isTicketFlow = computed(() => ticketFlow.active)

// 数据上传态：所有数据由管理员上传到后端，各角色登录后共享
const dataMeta = ref({ updatedAt: '', updatedBy: '', fileName: '', isDraft: false })
const uploaded = computed(() => !!dataMeta.value.updatedAt)
const loading = ref(false)

// 全局时间筛选：由父级「误杀Case分析」顶部时间窗口统一控制（v-model:globalDate 上提）
const props = defineProps({ globalDate: { type: Object, required: true } })
const emit = defineEmits(['update:globalDate'])
const globalDate = computed({
  get: () => props.globalDate,
  set: v => emit('update:globalDate', v),
})

// 标签跟踪不按时间过滤（用户要求去掉时间窗口）：
// 素材图片与数据是固定的，不随时间变动，时间筛选没有业务意义。
// 保留函数签名以免改动调用方，恒返回空区间 = 全量数据。
function dateRange() {
  return {}
}

// 是否已用数据实际周期初始化过时间窗口
let dateInited = false
// 初始化标志：首次设置 globalDate 时阻止 watch 重复触发 loadData，避免丢弃数据后重复加载
let initializing = false

async function loadData() {
  loading.value = true
  try {
    let range = dateRange()
    // 首次加载时用 overview 探测数据实际日期范围作为默认时间窗口
    if (!dateInited) {
      dateInited = true
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
        initializing = true
        globalDate.value = { preset: '', start: p.dataMinDate, end: p.dataMaxDate }
      }
    }

    if (!uploaded.value) {
      TAGS.splice(0, TAGS.length)
      ELEMENT_PRECISION.splice(0, ELEMENT_PRECISION.length)
      return
    }

    const [tags, elemPrec] = await Promise.all([
      tagApi.list(range),
      tagApi.elementPrecision(range),
    ])
    initializing = false

    // 若当前时间窗口无匹配数据（用户手动选了无数据区间），不重置dataMeta
    if ((!tags || !tags.length) && (range.start || range.end)) {
      TAGS.splice(0, TAGS.length)
      ELEMENT_PRECISION.splice(0, ELEMENT_PRECISION.length)
      return
    }

    TAGS.splice(0, TAGS.length, ...(tags || []).map(t => ({ ...t, remark: t.remark || '', fpReason: t.fpReason || '' })))
    ELEMENT_PRECISION.splice(0, ELEMENT_PRECISION.length, ...(elemPrec || []))
  } catch (e) {
    initializing = false
    toast.warn(e.message || '加载标签数据失败')
  } finally {
    loading.value = false
  }
}

// 分享：应用对方发来的 UI 状态
async function applyTagTrackShare(res) {
  const s = res?.uiState || {}
  if (s.globalDate) globalDate.value = s.globalDate
  if (typeof s.kw === 'string') kw.value = s.kw
  if (s.filterTab) filterTab.value = s.filterTab
  if (typeof s.precStatusFilter === 'string') precStatusFilter.value = s.precStatusFilter
  if (typeof s.sortDesc === 'boolean') sortDesc.value = s.sortDesc
  if (s.page) page.value = s.page
  if (s.pageSize) pageSize.value = s.pageSize
  if (typeof s.chartKw === 'string') chartKw.value = s.chartKw
  if (typeof s.chartSortDesc === 'boolean') chartSortDesc.value = s.chartSortDesc
  toast.info('已打开分享的标签跟踪页面，可在此基础上继续操作')
}

onMounted(() => {
  const shareId = getShareIdFromUrl()
  if (shareId) {
    loadData().then(() => openShare(shareId, applyTagTrackShare).catch(() => toast.warn('分享链接打开失败或已失效')))
  } else {
    loadData()
  }
})
watch(globalDate, () => { if (initializing) return; loadData() }, { deep: true })

// 标签筛选（跨设备延续）
const kw = useRemotePersistedRef('tagtrack:kw', '')
const filterTab = useRemotePersistedRef('tagtrack:filterTab', 'all')
if (filterTab.value === 'red') filterTab.value = 'abnormal'
if (filterTab.value !== 'all' && filterTab.value !== 'abnormal') filterTab.value = 'all'
const sortDesc = useRemotePersistedRef('tagtrack:sortDesc', true)
const tabs = [
  { v: 'all', t: '全部' },
  { v: 'abnormal', t: '异常', dot: 'var(--red)', tip: '异常判定口径：同一标签下的任一元素类型（图片/视频/文本）满足「精度 ≤ 60% 且 FP 量 ≥ 100」时，该标签标记为异常。例：标签15512「擦边暗示性着装与聚焦」的视频类型精度37.2%、FP429，触发异常。' },
]
function tabCount(v) {
  if (v === 'all') return TAGS.length
  if (v === 'abnormal') return TAGS.filter(t => isSevere(t)).length
  return 0
}

// 精度状态选择器（跨设备延续）：替代原精度关注/精度正常 Tab
const precStatusFilter = useRemotePersistedRef('tagtrack:precStatusFilter', '')
const precStatusOptions = [
  { v: '', label: '全部状态' },
  { v: 'red', label: '严重偏低', desc: '<50%' },
  { v: 'orange', label: '偏低', desc: '50%-70%' },
  { v: 'yellow', label: '一般', desc: '70%-80%' },
  { v: 'lightgreen', label: '良好', desc: '80%-90%' },
  { v: 'green', label: '优秀', desc: '≥90%' },
]

// 规整精度值：null/空/NaN → null（表示无数据），否则返回数值
function precVal(p) {
  if (p === null || p === undefined || p === '' || Number.isNaN(Number(p))) return null
  return Number(p)
}

// 精度五档状态（用于状态徽章+进度条配色）
function tagLevel(p) { return precLevel(p) }

// 数组随机洗牌（Fisher–Yates），供图表默认随机呈现
function shuffleArr(a) {
  const r = [...a]
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

// 用户是否主动调整过排序
const listUserSorted = ref(false)
const chartUserSorted = ref(false)
function toggleListSort() { sortDesc.value = !sortDesc.value; listUserSorted.value = true; page.value = 1 }
function onChartSortChange() { chartUserSorted.value = true }

const filtered = computed(() => {
  let arr = TAGS.filter(t => {
    if (filterTab.value === 'abnormal') { if (!isSevere(t)) return false }
    if (precStatusFilter.value && precLevel(t.precision).cls !== precStatusFilter.value) return false
    if (kw.value && !(`${t.id}`.includes(kw.value) || t.name.includes(kw.value))) return false
    return true
  })

  const isDefault = !kw.value && filterTab.value === 'all' && !precStatusFilter.value && !listUserSorted.value
  if (isDefault) {
    const inMid = (t) => { const p = precVal(t.precision); return p !== null && p > 0 && p < 95 }
    const mids = shuffleArr(arr.filter(inMid))
    if (mids.length < arr.length) {
      const rest = shuffleArr(arr.filter(t => !inMid(t) && precVal(t.precision) !== null))
      return [...mids, ...rest]
    }
    return mids
  }

  const hasP = (t) => t.precision !== null && t.precision !== undefined && t.precision !== '' && !Number.isNaN(Number(t.precision))
  arr = [...arr].sort((a, b) => {
    const ha = hasP(a), hb = hasP(b)
    if (ha !== hb) return ha ? -1 : 1
    if (!ha && !hb) return 0
    return sortDesc.value ? Number(b.precision) - Number(a.precision) : Number(a.precision) - Number(b.precision)
  })
  return arr
})

// 分页（跨设备延续）
const page = useRemotePersistedRef('tagtrack:page', 1)
const pageSize = useRemotePersistedRef('tagtrack:pageSize', 20)
const paged = computed(() => {
  if (pageSize.value === 'all') return filtered.value
  const s = (page.value - 1) * Number(pageSize.value)
  return filtered.value.slice(s, s + Number(pageSize.value))
})

// 各标签精度图表：图表专用筛选（跨设备延续）
const chartKw = useRemotePersistedRef('tagtrack:chartKw', '')
const chartSortDesc = useRemotePersistedRef('tagtrack:chartSortDesc', true)

// 图表柱状渐变色：基于标签状态色生成上深下浅的线性渐变
function gradientOf(color) {
  return {
    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color },
      { offset: 1, color: color + 'aa' },
    ],
  }
}

const chartTags = computed(() => {
  const pv = (t) => precVal(t.precision)
  let arr = ELEMENT_PRECISION.filter(t => {
    if (pv(t) === null) return false // 精度无定义的组合不参与图表
    if (filterTab.value === 'abnormal') { if (!t.isAbnormal) return false }
    if (precStatusFilter.value && precLevel(t.precision).cls !== precStatusFilter.value) return false
    if (chartKw.value && !(`${t.id}`.includes(chartKw.value) || (t.name || '').includes(chartKw.value))) return false
    return true
  })

  const isDefault = !chartKw.value && !chartUserSorted.value && filterTab.value === 'all' && !precStatusFilter.value
  if (isDefault) {
    const mids = arr.filter(t => { const p = pv(t); return p > 0 && p < 95 })
    const picked = shuffleArr(mids).slice(0, 20)
    if (picked.length < 20) {
      const rest = shuffleArr(arr.filter(t => !picked.includes(t)))
      picked.push(...rest.slice(0, 20 - picked.length))
    }
    return shuffleArr(picked).slice(0, 20)
  }

  if (chartSortDesc.value) {
    return [...arr].sort((a, b) => pv(b) - pv(a)).slice(0, 20)
  }
  return [...arr].sort((a, b) => pv(a) - pv(b)).slice(0, 20)
})

const chartOption = computed(() => ({
  grid: { left: 40, right: 40, top: 36, bottom: 8, containLabel: true },
  tooltip: {
    trigger: 'axis', axisPointer: { type: 'shadow' },
    backgroundColor: '#fff', borderColor: '#eef1f6', borderWidth: 1,
    padding: [8, 12], textStyle: { color: '#5a6478', fontSize: 12 },
    extraCssText: 'box-shadow:0 6px 24px rgba(20,30,60,.12);border-radius:10px;',
    formatter: p => {
      const i = p[0]
      const t = chartTags.value[i.dataIndex] || {}
      const nameLine = t.name
        ? `<div style="font-size:13px;color:#1a2233;font-weight:600;margin-bottom:2px;max-width:260px;white-space:normal;line-height:1.4">${t.name}</div>`
        : ''
      return nameLine
        + `<div style="font-size:12px;color:#8b94a8;margin-bottom:4px">标签 ID：${t.id ?? i.name} · ${t.elementTypeName || '未知'}</div>`
        + `<div style="font-size:11px;color:${precLevel(t.precision).color};font-weight:600;margin-bottom:4px">${precLevel(t.precision).label}</div>`
        + `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${i.color};margin-right:6px"></span>`
        + `<b style="color:#1a2233;font-size:13px">精度 ${i.value}%</b>`
    },
  },
  xAxis: {
    type: 'category',
    data: chartTags.value.map(t => `${t.id}-${t.elementTypeName || '未知'}`),
    axisLine: { lineStyle: { color: '#eef1f6' } },
    axisTick: { show: false },
    axisLabel: { color: '#8b94a8', fontSize: 11, interval: 0, rotate: chartTags.value.length > 10 ? 35 : 0, margin: 12 },
  },
  yAxis: {
    type: 'value', max: 100, min: 0, interval: 20,
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: '#f0f2f6' } },
    axisLabel: { color: '#8b94a8', fontSize: 12, formatter: '{value}%' },
  },
  series: [{
    type: 'bar', barWidth: 24, barMaxWidth: 38,
    data: chartTags.value.map(t => ({
      value: t.precision,
      itemStyle: { color: gradientOf(precLevel(t.precision).color), borderRadius: [5, 5, 0, 0] },
    })),
    label: {
      show: true, position: 'top', formatter: '{c}%',
      color: '#5a6478', fontSize: 12, fontWeight: 600, distance: 6,
    },
  }],
}))

function openTag(t) { router.push({ name: 'tagDetail', params: { id: t.id } }) }
function openConclusion(t) { router.push({ name: 'sediment', query: { tagId: t.id } }) }
</script>

<template>
  <div class="page-wrap tag-track">
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
      <span class="spin"></span>正在加载标签数据…
    </div>

    <template v-else-if="uploaded">
      <!-- 各标签精度图 -->
      <div class="card chart-card rise">
        <div class="card-hd">
          <h3>各标签精度</h3>
          <div class="chart-filters">
            <div class="cf-search">
              <Icon name="search" :size="14" />
              <input v-model="chartKw" placeholder="标签ID/名" />
            </div>
            <div class="cf-select">
              <select v-model="chartSortDesc" @change="onChartSortChange">
                <option :value="true">精度降序</option>
                <option :value="false">精度升序</option>
              </select>
              <Icon name="chevronDown" :size="14" />
            </div>
          </div>
        </div>
        <EChart :option="chartOption" height="320px" />
      </div>

      <!-- 标签明细 -->
      <div class="card list-card rise">
        <div v-if="isTicketFlow" class="flow-tip">
          <Icon name="ticket" :size="16" />
          <span>提需流程进行中：请点击下方标签进入<b>误杀样本明细</b>，勾选素材后点击「发起提需」</span>
        </div>
        <div class="lc-bar">
          <div class="search">
            <Icon name="search" :size="16" />
            <input v-model="kw" placeholder="搜索标签 ID / 名称…" @input="page=1" />
          </div>
          <div class="seg-tabs">
            <button v-for="t in tabs" :key="t.v" :class="{ on: filterTab===t.v }" @click="filterTab=t.v; page=1">
              <i v-if="t.dot" class="dot" :style="{ background: t.dot }"></i>{{ t.t }}<b>{{ tabCount(t.v) }}</b>
              <span v-if="t.tip" class="tab-tip-wrap">
                <svg class="tab-tip-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                <span class="tab-tip-pop">{{ t.tip }}</span>
              </span>
            </button>
          </div>
          <div class="prec-status-wrap">
            <div class="cf-select prec-status-select">
              <select v-model="precStatusFilter" @change="page=1">
                <option v-for="opt in precStatusOptions" :key="opt.v" :value="opt.v">{{ opt.label }}{{ opt.desc ? ' (' + opt.desc + ')' : '' }}</option>
              </select>
              <Icon name="chevronDown" :size="14" />
            </div>
            <div class="prec-status-tip" title="精度状态说明：严重偏低<50%、偏低50-70%、一般70-80%、良好80-90%、优秀≥90%">
              <Icon name="info" :size="15" />
            </div>
          </div>
          <button class="sort-btn" @click="toggleListSort">
            <Icon name="chart" :size="15" />精度{{ sortDesc ? '降序' : '升序' }}
          </button>
        </div>

        <div v-if="loading" class="list-loading"><span class="spin"></span>正在加载标签数据…</div>
        <div v-else-if="paged.length" class="tag-table">
          <div class="tt-head">
            <span class="col-seq">序号</span>
            <span class="col-id">标签ID</span>
            <span class="col-name">标签名</span>
            <span class="col-status">状态</span>
            <span class="col-prec">精度</span>
            <span class="col-fp">FP数</span>
            <span class="col-rank">精度排序</span>
            <span class="col-fp-reason">误杀归因</span>
            <span class="col-remark">备注</span>
            <span class="col-conc">结论</span>
          </div>
          <div v-for="(t, ti) in paged" :key="t.id" class="tt-row" @click="openTag(t)">
            <span class="col-seq seq-val">{{ (pageSize === 'all' ? 0 : (page - 1) * Number(pageSize)) + ti + 1 }}</span>
            <span class="col-id tid-val">{{ t.id }}</span>
            <span class="col-name name-val">{{ t.name }}</span>
            <span class="col-status">
              <span class="badge" :class="`badge-${tagLevel(t.precision).cls}`">{{ tagLevel(t.precision).label }}</span>
            </span>
            <span class="col-prec prec-cell">
              <span class="bar-track"><i :style="{ width: (precVal(t.precision) ?? 0) + '%', background: tagLevel(t.precision).color }"></i></span>
              <b class="bar-val" :style="{ color: tagLevel(t.precision).color }">{{ precVal(t.precision) === null ? '—' : precVal(t.precision) + '%' }}</b>
            </span>
            <span class="col-fp fp-val">{{ t.fp ?? 0 }}</span>
            <span class="col-rank rank-val">{{ t.rank }}</span>
            <span class="col-fp-reason" @click.stop>
              <input class="remark-input" v-model="t.fpReason" placeholder="填写误杀归因…" />
            </span>
            <span class="col-remark" @click.stop>
              <input class="remark-input" v-model="t.remark" placeholder="点击编辑备注…" />
            </span>
            <span class="col-conc" @click.stop>
              <button class="conc-btn" @click="openConclusion(t)"><Icon name="sediment" :size="14" />结论</button>
            </span>
          </div>
        </div>
        <EmptyState v-else icon="search" title="无匹配结果" desc="未找到符合筛选条件的标签，试试调整搜索词或分档" />

        <Pager v-if="paged.length" :total="filtered.length" v-model:page="page" v-model:page-size="pageSize" />
      </div>
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


.chart-card, .list-card { padding: 22px 24px; margin-bottom: 18px; }
.flow-tip { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; padding: 12px 16px; background: linear-gradient(90deg, var(--brand-soft), #eef2ff); border: 1px solid #d6e0ff; border-radius: 12px; font-size: 13px; color: var(--text-2); }
.flow-tip svg { color: var(--brand); flex-shrink: 0; }
.flow-tip b { color: var(--brand); }
.card-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.card-hd h3 { font-size: 16px; font-weight: 700; }
.hint { font-size: 12px; color: var(--text-4); }

.chart-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cf-select { position: relative; display: flex; align-items: center; }
.cf-select select {
  appearance: none; -webkit-appearance: none;
  height: 36px; padding: 0 32px 0 13px; border: 1px solid var(--border-strong);
  border-radius: 9px; background: #fff; font-size: 13px; color: var(--text-2);
  cursor: pointer; transition: all .18s;
}
.cf-select select:hover { border-color: var(--brand); }
.cf-select select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.cf-select svg { position: absolute; right: 11px; color: var(--text-4); pointer-events: none; }
.cf-search { display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 13px; border: 1px solid var(--border-strong); border-radius: 9px; color: var(--text-3); transition: all .18s; }
.cf-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.cf-search input { width: 130px; font-size: 13px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }
.cf-search input::placeholder { color: var(--text-4); }

.lc-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text-3); min-width: 240px; transition: all .18s; }
.search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.search input { flex: 1; font-size: 14px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }
.seg-tabs { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; }
.seg-tabs button { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; transition: all .18s; }
.seg-tabs button.on { background: #fff; color: var(--text-1); box-shadow: var(--shadow-sm); }
.seg-tabs .dot { width: 7px; height: 7px; border-radius: 50%; }
.seg-tabs b { color: var(--text-4); font-weight: 700; }
.seg-tabs button.on b { color: var(--brand); }
.seg-tabs .tab-tip-wrap { position: relative; display: inline-flex; align-items: center; margin-left: 2px; }
.seg-tabs .tab-tip-icon { color: var(--text-3); cursor: help; opacity: 0.65; transition: opacity .15s; }
.seg-tabs .tab-tip-wrap:hover .tab-tip-icon { opacity: 1; }
.seg-tabs .tab-tip-pop {
  position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  width: 320px; padding: 10px 14px; border-radius: 10px;
  background: #1e293b; color: #f1f5f9; font-size: 12px; line-height: 1.7; font-weight: 400;
  white-space: normal; text-align: left; z-index: 999;
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .18s, visibility .18s;
  box-shadow: 0 8px 30px rgba(0,0,0,.25);
}
.seg-tabs .tab-tip-pop::after {
  content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  border: 6px solid transparent; border-top-color: #1e293b;
}
.seg-tabs .tab-tip-wrap:hover .tab-tip-pop { opacity: 1; visibility: visible; }
.sort-btn { display: flex; align-items: center; gap: 5px; margin-left: auto; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; font-size: 13px; color: var(--text-2); transition: all .18s; }
.sort-btn:hover { border-color: var(--brand); color: var(--brand); }

.prec-status-wrap { display: flex; align-items: center; gap: 6px; }
.prec-status-select select { min-width: 150px; }
.prec-status-tip { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--text-4); cursor: help; transition: all .18s; }
.prec-status-tip:hover { background: var(--bg-soft); color: var(--brand); }

/* 标签明细表：每列居中对齐 */
.tag-table { display: flex; flex-direction: column; }
.tt-head, .tt-row {
  display: grid;
  grid-template-columns: 0.5fr 1fr 1.1fr 1.1fr 2.2fr 0.7fr 0.9fr 1.4fr 1.8fr 0.7fr;
  align-items: center;
}
.tt-head {
  padding: 14px 8px; background: var(--bg-soft); border-radius: 10px;
  font-size: 13px; font-weight: 600; color: var(--text-3); margin-bottom: 4px;
}
.tt-head > span { text-align: center; }
.tt-row {
  padding: 15px 8px; border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background .18s;
}
.tt-row:last-child { border-bottom: none; }
.tt-row:hover { background: var(--bg-soft); }
.tt-row > span { display: flex; align-items: center; justify-content: center; }
.seq-val { font-size: 13px; font-weight: 600; color: var(--text-4); }
.tid-val { font-size: 14px; font-weight: 600; color: var(--text-2); }
.name-val { font-size: 14px; font-weight: 600; color: var(--text-1); }
.prec-cell { gap: 12px; padding: 0 8px; }
.bar-track { flex: 1; max-width: 200px; height: 8px; background: #eef1f6; border-radius: 6px; overflow: hidden; }
.bar-track i { display: block; height: 100%; border-radius: 6px; transition: width .6s cubic-bezier(.16,1,.3,1); }
.bar-val { font-size: 14px; font-weight: 700; min-width: 50px; text-align: left; }
.rank-val { font-size: 14px; font-weight: 600; color: var(--text-2); }
.fp-val { font-size: 14px; font-weight: 700; color: var(--text-1); }
.col-conc { justify-content: center; }
.conc-btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--brand); background: var(--brand-soft); transition: all .15s; }
.conc-btn:hover { background: var(--brand); color: #fff; }
.badge-yellow { background: #fef9c3; color: #ca8a04; }
.badge-lightgreen { background: #dcfce7; color: #16a34a; }
.remark-input {
  width: 100%; max-width: 220px; height: 36px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: 9px; background: #fff;
  font-size: 13px; color: var(--text-1); text-align: center; transition: all .18s;
}
.remark-input:hover { border-color: var(--border-strong); }
.remark-input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.remark-input::placeholder { color: var(--text-4); }
.init-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; font-size: 14px; color: var(--text-3); }
.init-loading .spin { width: 18px; height: 18px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
.list-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 48px 0; font-size: 14px; color: var(--text-3); }
.list-loading .spin { width: 18px; height: 18px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
@keyframes lspin { to { transform: rotate(360deg); } }
@media (max-width: 900px) {
  .tt-head { display: none; }
  .tt-row { grid-template-columns: 1fr 1fr; gap: 8px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; }
  .col-fp::before { content: 'FP: '; color: var(--text-4); font-weight: 500; }
}
</style>
