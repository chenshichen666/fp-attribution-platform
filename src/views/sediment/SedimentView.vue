<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useAuthStore } from '../../stores/auth'
// 问题分类为固定枚举（写死），行业/分类分布改为后端真实聚合
import { PROBLEM_CATEGORIES } from '../../data/mock'
import { sedimentApi } from '../../api/index.js'
import { usePersistedRef, useRemotePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import KpiCard from '../../components/KpiCard.vue'
import EChart from '../../components/EChart.vue'
import Modal from '../../components/Modal.vue'
import EmptyState from '../../components/EmptyState.vue'
import DateRangeFilter from '../../components/DateRangeFilter.vue'
import { getShareIdFromUrl, openShare } from '../../utils/share'

const toast = useToastStore()
const auth = useAuthStore()
const route = useRoute()

// 素材预览辅助
const mediaErr = ref(new Set())
// 首次失败：先尝试用「原始直连（不重签）」重试一次；仍失败则二级兜底走后端代理（服务端续期 dis_t 代拉）；
// 代理仍失败才降级到「打开原链接」。
function onMediaErr(id, e) {
  const el = e && e.target
  if (el && el.tagName === 'IMG' && retryOriginalSrc(el)) return
  if (el && mediaProxyFallback(el)) return // 已切到代理路径，不标记失败
  if (mediaErr.value.has(id)) return
  mediaErr.value.add(id); mediaErr.value = new Set(mediaErr.value)
}
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  return /^https?:\/\//i.test(url)
}
// 视频扩展名列表
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
// 图片扩展名列表（避免 ads_svp_video__xxx.jpeg 被误判为视频）
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']

// 通过 URL 后缀判断是否为视频（不依赖 type/isVideo 字段）
function isVideoByUrl(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  if (VIDEO_EXT.includes(ext)) return true
  // 明确是图片扩展名 → 不是视频（避免 ads_svp_video__xxx.jpeg 被误判）
  if (IMAGE_EXT.includes(ext)) return false
  if (/video/i.test(clean)) return true
  return false
}

// T0：采用「前端直链 + http→https 升级」模式，直链失败由 onMediaErr 触发「打开原链接」逃生通道。
// 直链失败由 onMediaErr 触发「打开原链接」新标签逃生通道（等价 onMediaError 兜底）。
import { previewSrc, isBadShardUrl, isMediaUrl, retryOriginalSrc, rawHttpsUrlPlain, mediaProxyFallback } from '../../utils/mediaPreview.js'
function safeUrl(url) {
  return previewSrc(url)
}

// 主列表与 KPI 改为真实 API
const SEDIMENTS = ref([])
const SEDIMENT_KPI = ref({ total: 0, realFp: 0, machineRight: 0, updated: 0 })
const dist = ref({ industry: [], category: [] })
const loading = ref(false)

async function loadData() {
  loading.value = true
  try {
    const [list, kpi, distribution] = await Promise.all([sedimentApi.list(), sedimentApi.kpi(), sedimentApi.distribution()])
    SEDIMENTS.value = Array.isArray(list) ? list : []
    SEDIMENT_KPI.value = kpi || { total: 0, realFp: 0, machineRight: 0, updated: 0 }
    dist.value = distribution || { industry: [], category: [] }
  } catch (e) {
    toast.warn(e?.message || '加载结论沉淀数据失败')
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  readTagFilterFromUrl()
  loadData().then(() => {
    // 仅「分享链接」进入时才还原详情弹窗；普通进入保持干净的列表面。
    // 原实现会把上次打开的结论持久化（detailOverlay），每次进入都自动弹出，
    // 干扰正常浏览，故取消自动还原。
    const shareId = getShareIdFromUrl()
    if (shareId) {
      openShare(shareId, applySedimentShare).then(() => {
        const id = detailOverlay.value
        if (id) {
          const s = SEDIMENTS.value.find(x => x.id === id)
          if (s) openDetail(s)
        }
      }).catch(() => toast.warn('分享链接打开失败或已失效'))
    }
  })
})

const kw = useRemotePersistedRef('sediment:kw', '')
const catFilter = useRemotePersistedRef('sediment:catFilter', '')
const indFilter = useRemotePersistedRef('sediment:indFilter', '')
const resultFilter = useRemotePersistedRef('sediment:resultFilter', '') // '' | real_fp | machine_right | updated
const view = useRemotePersistedRef('sediment:view', 'card') // card | list | group
const tagFilter = useRemotePersistedRef('sediment:tagFilter', '') // 按标签过滤（标签跟踪页「结论」入口跳转带入）
const sedDate = useRemotePersistedRef('sediment:sedDate', { preset: '30', start: '', end: '' })
// 打开的详情弹窗自动还原（跨设备延续）：持久化「当前打开的沉淀 id」
const detailOverlay = useRemotePersistedRef('sediment:detailOverlay', '')
function persistDetailOverlay() { detailOverlay.value = detail.value?.id || '' }
function clearDetailOverlay() { if (detailOverlay.value) detailOverlay.value = '' }
// 分享：应用对方发来的 UI 状态
async function applySedimentShare(res) {
  const s = res?.uiState || {}
  if (typeof s.kw === 'string') kw.value = s.kw
  if (s.catFilter) catFilter.value = s.catFilter
  if (s.indFilter) indFilter.value = s.indFilter
  if (s.resultFilter) resultFilter.value = s.resultFilter
  if (s.view) view.value = s.view
  if (s.sedDate) sedDate.value = s.sedDate
  if (s.detailOverlay) detailOverlay.value = s.detailOverlay
  toast.info('已打开分享的沉淀页面，可在此基础上继续操作')
}
// 从 URL 读取标签过滤（标签跟踪页「结论」入口跳转带入，直接进入聚合视图）
function readTagFilterFromUrl() {
  const tid = route.query.tagId
  if (tid) {
    tagFilter.value = String(tid)
    view.value = 'group'
  }
}
const industries = computed(() => Array.from(new Set(SEDIMENTS.value.map(s => s.industryL1).filter(Boolean))).sort())

// 点击 KPI 卡：再次点击同一项可取消筛选
function toggleResult(key) { resultFilter.value = resultFilter.value === key ? '' : key }
function isUpdated(s) { return Array.isArray(s.updates) && s.updates.length > 0 }

const filtered = computed(() => SEDIMENTS.value.filter(s => {
  if (kw.value && !s.title.includes(kw.value) && !s.conclusion.includes(kw.value)
    && !s.desc.includes(kw.value) && !s.tagName.includes(kw.value) && String(s.tagId) !== kw.value) return false
  if (catFilter.value && s.category !== catFilter.value) return false
  if (indFilter.value && s.industryL1 !== indFilter.value) return false
  if (resultFilter.value === 'real_fp' && s.resultType !== 'real_fp') return false
  if (resultFilter.value === 'machine_right' && s.resultType !== 'machine_right') return false
  if (resultFilter.value === 'updated' && !isUpdated(s)) return false
  if (tagFilter.value && String(s.tagId) !== tagFilter.value) return false
  return true
}))

// 按标签聚合视图：将结论按 tagId 分组，统计结论数/真实误杀/机审正确/样本数
const groupExpanded = ref(new Set())
const groupedSediments = computed(() => {
  const map = new Map()
  for (const s of filtered.value) {
    const key = (s.tagId && s.tagId > 0) ? `t${s.tagId}` : 'untagged'
    if (!map.has(key)) map.set(key, { key, tagId: s.tagId || 0, tagName: s.tagName || '未命名标签', items: [] })
    map.get(key).items.push(s)
  }
  const groups = [...map.values()]
  for (const g of groups) {
    g.count = g.items.length
    g.realFp = g.items.filter(x => x.resultType === 'real_fp').length
    g.machineRight = g.items.filter(x => x.resultType === 'machine_right').length
    g.samples = g.items.reduce((sum, x) => sum + (Number(x.samples) || 0), 0)
    g.latest = g.items.reduce((a, b) => (new Date(a.adoptedAt || 0) > new Date(b.adoptedAt || 0) ? a : b))
  }
  groups.sort((a, b) => b.count - a.count)
  return groups
})
function toggleGroup(key) {
  const next = new Set(groupExpanded.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  groupExpanded.value = next
}

function catLabel(c) { return PROBLEM_CATEGORIES.find(x => x.code === c)?.label || c }
function catCls(c) { return { RULE_CHANGE: 'badge-blue', RULE_UNREASONABLE: 'badge-orange', OTHER: 'badge-gray' }[c] }

// 详情
const detailOpen = ref(false)
// 弹窗关闭时清空持久化的结论 id：无论用「关闭」按钮、右上角 X、点遮罩还是 ESC 关闭都生效。
// 原实现只在底部「关闭」按钮里清空，用其他方式关闭会残留 id → 下次进入页面又自动弹出。
watch(detailOpen, (v) => { if (!v) clearDetailOverlay() })
const detail = ref(null)
const detailTitle = computed(() => detail.value
  ? `${detail.value.tagId} - ${detail.value.tagName}-${catLabel(detail.value.category)}`
  : '')
function openDetail(s) { detail.value = s; detailOpen.value = true; persistDetailOverlay() }
function exportOne(s) { toast.success(`「${s.title}」已导出 Word`) }
function exportAll() { toast.success(`已汇总导出 ${filtered.value.length} 条结论为 Word（分页符分隔）`) }

// 删除结论（仅管理员）
const deleteOpen = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
function openDelete(s) { deleteTarget.value = s; deleteOpen.value = true }
async function confirmDelete() {
  const s = deleteTarget.value
  if (!s) return
  deleting.value = true
  try {
    await sedimentApi.remove(s.id)
    deleteOpen.value = false
    if (detail.value?.id === s.id) detailOpen.value = false
    await loadData()
    toast.success(`「${s.title}」已删除`)
  } catch (e) {
    toast.error(e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}

// 素材预览弹窗
const SPEED_OPTIONS = [1, 1.5, 2, 3, 0.5]
const previewOpen = ref(false)
const previewMedia = ref(null)
const previewVideoRef = ref(null)
const videoSpeedMap = ref({})
const previewSpeed = computed(() => {
  if (!previewMedia.value || !previewMedia.value.vid || !previewMedia.value.mediaUrl) return 1
  return videoSpeedMap.value[previewMedia.value.mediaUrl] ?? 1
})
function openPreview(m) {
  if (!m) return
  const vid = isVideoByUrl(m.mediaUrl)
  previewMedia.value = { ...m, vid }
  previewOpen.value = true
  nextTick(() => {
    if (previewVideoRef.value) {
      previewVideoRef.value.playbackRate = vid ? (videoSpeedMap.value[m.mediaUrl] ?? 1) : 1
    }
  })
}
function closePreview() {
  if (previewVideoRef.value) previewVideoRef.value.pause()
  previewOpen.value = false
  previewMedia.value = null
}
function cyclePreviewSpeed() {
  const cur = previewSpeed.value
  const idx = SPEED_OPTIONS.indexOf(cur)
  const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
  if (previewMedia.value && previewMedia.value.mediaUrl) {
    videoSpeedMap.value[previewMedia.value.mediaUrl] = next
  }
  if (previewVideoRef.value) previewVideoRef.value.playbackRate = next
}

// 图表（数据来自后端真实聚合 dist）
const industryOption = computed(() => ({
  grid: { left: 8, right: 28, top: 10, bottom: 8, containLabel: true },
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  xAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#f0f2f6' } }, axisLabel: { color: '#8b94a8' } },
  yAxis: { type: 'category', inverse: true, data: dist.value.industry.map(d => d.name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#5a6478' } },
  series: [{ type: 'bar', barWidth: 13, data: dist.value.industry.map(d => d.value), itemStyle: { color: '#4f7cff', borderRadius: [0, 7, 7, 0] }, label: { show: true, position: 'right', color: '#5a6478', fontSize: 11, fontWeight: 600 } }],
}))
const catOption = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
  legend: { bottom: 0, icon: 'circle', textStyle: { color: '#5a6478', fontSize: 12 } },
  series: [{ type: 'pie', radius: ['50%', '72%'], center: ['50%', '42%'], itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 }, label: { show: false },
    data: dist.value.category.map((d, i) => ({ name: catLabel(d.code), value: d.value, itemStyle: { color: ['#4f7cff', '#f5a000', '#94a3b8', '#7c6df0', '#1fb574'][i % 5] } })) }],
}))

// ===== 新增/编辑结论沉淀 =====
const RESULT_TYPES = [
  { code: 'real_fp', label: '真实误杀' },
  { code: 'machine_right', label: '机审正确' },
]
const editOpen = ref(false)
const editMode = ref('create') // 'create' | 'edit'
const editForm = ref({
  title: '', type: '', category: 'OTHER', resultType: 'real_fp',
  tagId: 0, tagName: '', tags: [], industry: '', industryL1: '', industryL2: '',
  submitter: '', handler: '',
  desc: '', feature: '', conclusion: '', fpReason: '',
  relatedMaterials: [], handleInfo: '',
  dcId: '', opsAdvertiserName: '', elementFingerprint: '', aiEvaluateReviewerName: '',
  updateReason: '',
})
const editSaving = ref(false)
const materialUrlInput = ref('')

function openCreate() {
  editMode.value = 'create'
  editForm.value = {
    title: '', type: '', category: 'OTHER', resultType: 'real_fp',
    tagId: 0, tagName: '', tags: [], industry: '', industryL1: '', industryL2: '',
    submitter: auth.user?.name || '', handler: '',
    desc: '', feature: '', conclusion: '', fpReason: '',
    relatedMaterials: [], handleInfo: '',
    dcId: '', opsAdvertiserName: '', elementFingerprint: '', aiEvaluateReviewerName: '',
    updateReason: '',
  }
  editOpen.value = true
}

function openEdit(s) {
  editMode.value = 'edit'
  editForm.value = {
    title: s.title || '', type: s.type || '', category: s.category || 'OTHER',
    resultType: s.resultType || 'real_fp',
    tagId: s.tagId || 0, tagName: s.tagName || '', tags: s.tags || [],
    industry: s.industry || '',
    industryL1: s.industryL1 || s.industry || '',
    industryL2: s.industryL2 || '',
    submitter: s.submitter || '', handler: s.handler || '',
    desc: s.desc || '', feature: s.feature || '', conclusion: s.conclusion || '',
    fpReason: s.fpReason || '',
    relatedMaterials: Array.isArray(s.relatedMaterials) ? JSON.parse(JSON.stringify(s.relatedMaterials)) : [],
    handleInfo: s.handleInfo || '',
    dcId: s.dcId || '', opsAdvertiserName: s.opsAdvertiserName || '',
    elementFingerprint: s.elementFingerprint || '', aiEvaluateReviewerName: s.aiEvaluateReviewerName || '',
    updateReason: '',
  }
  editOpen.value = true
}

// 添加素材链接（自动检测类型）
function addMaterialUrl() {
  const url = materialUrlInput.value.trim()
  if (!url) return
  const vid = isVideoByUrl(url)
  const id = `mat-${Date.now()}-${editForm.value.relatedMaterials.length}`
  editForm.value.relatedMaterials.push({
    id, mediaUrl: url, type: vid ? 'video' : 'image',
    ocr: '', asr: '',
  })
  materialUrlInput.value = ''
}

function removeMaterial(idx) {
  editForm.value.relatedMaterials.splice(idx, 1)
}

async function saveEdit() {
  if (!editForm.value.title.trim()) {
    toast.error('标题不能为空')
    return
  }
  if (!editForm.value.conclusion.trim()) {
    toast.error('专家结论不能为空')
    return
  }
  editSaving.value = true
  try {
    if (editMode.value === 'create') {
      await sedimentApi.create(editForm.value)
      toast.success('结论沉淀已新增')
    } else {
      await sedimentApi.edit(editForm.value.id || detail.value?.id, editForm.value)
      toast.success('结论沉淀已更新')
    }
    editOpen.value = false
    if (detail.value && editMode.value === 'edit') {
      // 刷新详情
      const updated = await sedimentApi.detail(detail.value.id)
      detail.value = updated
    }
    await loadData()
  } catch (e) {
    toast.error(e?.message || '保存失败')
  } finally {
    editSaving.value = false
  }
}

// ===== 转工单 =====
const toTicketOpen = ref(false)
const toTicketTarget = ref(null)
const toTicketSaving = ref(false)

function openToTicket(s) {
  toTicketTarget.value = s
  toTicketOpen.value = true
}

async function confirmToTicket() {
  const s = toTicketTarget.value
  if (!s) return
  toTicketSaving.value = true
  try {
    const result = await sedimentApi.toTicket(s.id)
    toast.success(`已创建工单（${result.ticketId}），已进入公共池`)
    toTicketOpen.value = false
  } catch (e) {
    toast.error(e?.message || '转工单失败')
  } finally {
    toTicketSaving.value = false
  }
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <div>
        <h1 class="page-title"><Icon name="sediment" :size="22" />结论沉淀</h1>
        <p class="page-sub">归因知识库 · 全文检索 · 行业与问题分类分布 · Word 导出</p>
      </div>
      <div class="ph-actions">
        <button class="btn btn-ghost btn-sm" @click="exportAll"><Icon name="download" :size="15" />汇总导出</button>
        <button class="btn btn-primary btn-sm" @click="openCreate"><Icon name="plus" :size="15" />新增结论</button>
      </div>
    </div>

    <!-- 4 KPI：均可点击筛选，沉淀结论数=全部 -->
    <div class="kpi-row">
      <div class="kpi-click" :class="{ active: resultFilter==='' }" @click="resultFilter=''">
        <KpiCard icon="sediment" label="沉淀结论数" :value="SEDIMENT_KPI.total" color="blue" />
        <span class="kpi-flag">查看全部</span>
      </div>
      <div class="kpi-click" :class="{ active: resultFilter==='real_fp' }" @click="toggleResult('real_fp')">
        <KpiCard icon="fpcount" label="真实误杀" :value="SEDIMENT_KPI.realFp" color="red" />
        <span class="kpi-flag">点击筛选</span>
      </div>
      <div class="kpi-click" :class="{ active: resultFilter==='machine_right' }" @click="toggleResult('machine_right')">
        <KpiCard icon="checkCircle" label="机审正确" :value="SEDIMENT_KPI.machineRight" color="green" />
        <span class="kpi-flag">点击筛选</span>
      </div>
      <div class="kpi-click" :class="{ active: resultFilter==='updated' }" @click="toggleResult('updated')">
        <KpiCard icon="edit" label="已更新" :value="SEDIMENT_KPI.updated" color="orange" />
        <span class="kpi-flag">点击筛选</span>
      </div>
    </div>

    <div class="main-grid">
      <!-- 左：结论库 -->
      <div class="card lib-card rise">
        <div class="lib-bar">
          <div class="search">
            <Icon name="search" :size="16" /><input v-model="kw" placeholder="关键词全文检索…" />
          </div>
          <DateRangeFilter v-model="sedDate" />
          <select class="field sm" v-model="catFilter">
            <option value="">全部问题分类</option>
            <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
          </select>
          <select class="field sm" v-model="indFilter">
            <option value="">全部行业</option>
            <option v-for="ind in industries" :key="ind" :value="ind">{{ ind }}</option>
          </select>
          <div class="view-seg">
            <button :class="{ on: view==='card' }" @click="view='card'" title="卡片视图"><Icon name="grid" :size="15" /></button>
            <button :class="{ on: view==='list' }" @click="view='list'" title="列表视图"><Icon name="list" :size="15" /></button>
            <button :class="{ on: view==='group' }" @click="view='group'" title="按标签聚合"><Icon name="tags" :size="15" /></button>
          </div>
        </div>

        <!-- 卡片视图 -->
        <div v-if="filtered.length && view==='card'" class="sed-cards">
          <div v-for="s in filtered" :key="s.id" class="sed-card" :class="{ updated: isUpdated(s) }" @click="openDetail(s)">
            <span v-if="isUpdated(s)" class="upd-corner"><Icon name="edit" :size="11" />已更新</span>
            <div class="sc-top">
              <span class="badge badge-blue">{{ s.tagId }}-{{ s.tagName }}</span>
              <span v-if="s.industryL1 || s.industryL2" class="badge badge-gray">{{ s.industryL1 }}{{ s.industryL2 ? '/' + s.industryL2 : '' }}</span>
              <span class="badge" :class="s.resultType==='real_fp' ? 'badge-red' : 'badge-green'">
                {{ s.resultType==='real_fp' ? '真实误杀' : '机审正确' }}
              </span>
              <span class="badge" :class="catCls(s.category)">{{ catLabel(s.category) }}</span>
              <span class="sc-date">{{ s.adoptedAt?.slice(0, 10) || '—' }}</span>
            </div>
            <p class="sc-conc">{{ s.conclusion }}</p>
            <div class="sc-foot">
              <span class="sc-people"><Icon name="user" :size="13" />提需：{{ s.submitter }} · 处理：{{ s.handler }}</span>
              <button class="sc-exp-txt" @click.stop="exportOne(s)"><Icon name="download" :size="13" />导出 Word</button>
              <button v-if="auth.isAdmin" class="sc-del-txt" @click.stop="openDelete(s)"><Icon name="trash" :size="13" />删除</button>
            </div>
          </div>
        </div>

        <!-- 列表视图 -->
        <div v-else-if="filtered.length && view==='list'" class="sed-list">
          <div class="sl-head">
            <span class="c-tag">标签 ID - 标签名</span>
            <span class="c-cat">问题分类</span>
            <span class="c-ind">行业</span>
            <span class="c-time">入库时间</span>
            <span class="c-sub">提需人</span>
            <span class="c-han">处理人</span>
            <span class="c-op"></span>
          </div>
          <div v-for="s in filtered" :key="s.id" class="sl-row" @click="openDetail(s)">
            <span class="c-tag">
              <b class="mono">{{ s.tagId }}</b> · {{ s.tagName }}
              <span v-if="isUpdated(s)" class="upd-mini"><Icon name="edit" :size="10" />已更新</span>
            </span>
            <span class="c-cat"><span class="badge" :class="catCls(s.category)">{{ catLabel(s.category) }}</span></span>
            <span class="c-ind">{{ s.industryL1 }}{{ s.industryL2 ? '/' + s.industryL2 : '' }}</span>
            <span class="c-time mono dim">{{ s.adoptedAt?.slice(0, 10) || '—' }}</span>
            <span class="c-sub">{{ s.submitter }}</span>
            <span class="c-han">{{ s.handler }}</span>
            <span class="c-op">
              <button class="sc-exp" @click.stop="exportOne(s)"><Icon name="download" :size="14" /></button>
              <button v-if="auth.isAdmin" class="sc-del" @click.stop="openDelete(s)"><Icon name="trash" :size="14" /></button>
            </span>
          </div>
        </div>
        <!-- 按标签聚合视图 -->
        <div v-else-if="filtered.length && view==='group'" class="sed-groups">
          <div v-for="g in groupedSediments" :key="g.key" class="sed-group">
            <div class="sg-hd" @click="toggleGroup(g.key)">
              <span class="badge badge-blue">{{ g.tagId > 0 ? g.tagId + '-' + g.tagName : g.tagName }}</span>
              <span class="sg-stats">
                <span class="sg-stat"><i class="sg-dot total"></i>结论 {{ g.count }}</span>
                <span class="sg-stat"><i class="sg-dot red"></i>真实误杀 {{ g.realFp }}</span>
                <span class="sg-stat"><i class="sg-dot green"></i>机审正确 {{ g.machineRight }}</span>
                <span class="sg-stat"><i class="sg-dot gray"></i>样本 {{ g.samples }}</span>
              </span>
              <Icon :name="groupExpanded.has(g.key) ? 'chevronUp' : 'chevronDown'" :size="16" class="sg-arrow" />
            </div>
            <div v-if="groupExpanded.has(g.key)" class="sg-body">
              <div v-for="s in g.items" :key="s.id" class="sg-item" @click="openDetail(s)">
                <span class="badge" :class="s.resultType==='real_fp' ? 'badge-red' : 'badge-green'">{{ s.resultType==='real_fp' ? '真实误杀' : '机审正确' }}</span>
                <p class="sg-conc" :title="s.conclusion">{{ s.conclusion }}</p>
                <span class="sg-meta">{{ s.submitter }} · {{ s.handler }} · {{ s.adoptedAt?.slice(0, 10) || '—' }}</span>
              </div>
            </div>
          </div>
        </div>
        <EmptyState v-else icon="search" title="无匹配结论" desc="未找到符合条件的归因结论，试试调整关键词或筛选" />
      </div>

      <!-- 右：图表 -->
      <div class="side-charts">
        <div class="card sch rise"><h3>行业分布</h3><EChart :option="industryOption" height="200px" /></div>
        <div class="card sch rise"><h3>问题分类分布</h3><EChart :option="catOption" height="220px" /></div>
      </div>
    </div>

    <!-- 详情 -->
    <Modal v-model="detailOpen" :title="detailTitle" width="640px">
      <div v-if="detail" class="detail">
        <div class="d-tags">
          <span class="badge badge-blue">{{ detail.tagId }}-{{ detail.tagName }}</span>
          <span v-if="detail.industryL1 || detail.industryL2" class="badge badge-gray">{{ detail.industryL1 }}{{ detail.industryL2 ? '/' + detail.industryL2 : '' }}</span>
          <span class="badge" :class="detail.resultType==='real_fp' ? 'badge-red' : 'badge-green'">
            {{ detail.resultType==='real_fp' ? '真实误杀' : '机审正确' }}
          </span>
          <span class="badge" :class="catCls(detail.category)">{{ catLabel(detail.category) }}</span>
          <span v-if="isUpdated(detail)" class="badge badge-orange"><Icon name="edit" :size="11" />已更新</span>
        </div>

        <!-- 1 问题描述 + 已关联素材 -->
        <div class="d-sec"><h4><i class="n">1</i>问题描述</h4>
          <p>{{ detail.desc }}</p>
          <div class="rm-block">
            <div class="rm-head"><Icon name="image" :size="13" />已关联素材（{{ (detail.relatedMaterials || []).length }}）</div>
            <div class="rm-grid" v-if="(detail.relatedMaterials || []).length">
              <div v-for="m in detail.relatedMaterials" :key="m.id" class="rm-item">
                <div class="rm-thumb clickable" :class="{ vid: isVideoByUrl(m.mediaUrl) && isValidHttpUrl(m.mediaUrl), 'text-type': !isVideoByUrl(m.mediaUrl) && (!m.mediaUrl || !isValidHttpUrl(m.mediaUrl)) }" @click="openPreview(m)">
                  <video v-if="isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" v-lazy-video :data-src="m.mediaUrl" controls playsinline muted @error="onMediaErr(m.id)"></video>
<img v-else-if="!isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" :src="rawHttpsUrlPlain(m.mediaUrl)" :data-raw-url="m.mediaUrl" referrerpolicy="no-referrer" alt="" @error="onMediaErr(m.id, $event)" />
                  <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl) && mediaErr.has(m.id)" class="rm-link-preview" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" /><span>打开原链接</span></a>
                  <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && !isMediaUrl(m.mediaUrl)" class="rm-link-preview" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" /><span>打开原链接</span></a>
                  <div v-else-if="m.mediaUrl && !isValidHttpUrl(m.mediaUrl)" class="rm-text-preview">{{ m.mediaUrl.slice(0, 60) }}{{ m.mediaUrl.length > 60 ? '…' : '' }}</div>
                  <div v-else-if="(m.ocr || m.asr)" class="rm-text-preview">{{ (m.ocr || m.asr).slice(0, 60) }}{{ (m.ocr || m.asr).length > 60 ? '…' : '' }}</div>
                  <template v-else>
                    <Icon :name="isVideoByUrl(m.mediaUrl) ? 'film' : 'image'" :size="20" />
                    <span class="rm-type">{{ m.type }}</span>
                  </template>
                  <span v-if="m.mediaUrl || m.ocr || m.asr" class="rm-zoom"><Icon name="search" :size="12" /></span>
                </div>
                <span class="rm-id mono">{{ m.id }}</span>
              </div>
            </div>
            <p v-else class="rm-empty">无</p>
          </div>
        </div>
        <div class="rm-block" v-if="detail && detail.similarMaterials && detail.similarMaterials.length">
          <p>{{ detail.conclusion }}</p>
          <div class="d-tip"><Icon name="info" :size="13" />此处沉淀的是需求工单中的专家结论，并非最终的误杀归因。</div>
        </div>

        <!-- 3 误杀归因（来自标签明细 误杀归因列） -->
        <div class="d-sec"><h4><i class="n">3</i>误杀归因</h4>
          <p :class="{ none: !detail.fpReason || detail.fpReason==='无' }">{{ detail.fpReason || '无' }}</p>
        </div>

        <!-- 4 处理信息 -->
        <div class="d-sec"><h4><i class="n">4</i>处理信息</h4>
          <div class="d-info">
            <div><span>标签 ID - 标签名</span><b>{{ detail.tagId }} - {{ detail.tagName }}</b></div>
            <div><span>问题分类</span><b>{{ catLabel(detail.category) }}</b></div>
            <div><span>结果类型</span><b>{{ detail.resultType==='real_fp' ? '真实误杀' : '机审正确' }}</b></div>
            <div><span>一级行业</span><b>{{ detail.industryL1 || detail.industry || '-' }}</b></div>
            <div><span>二级行业</span><b>{{ detail.industryL2 || '-' }}</b></div>
            <div><span>提需人</span><b>{{ detail.submitter }}</b></div>
            <div><span>处理人</span><b>{{ detail.handler }}</b></div>
            <div><span>入库时间</span><b>{{ detail.adoptedAt }}</b></div>
            <div v-if="detail.dcId"><span>创意ID(DCID)</span><b class="mono">{{ detail.dcId }}</b></div>
            <div v-if="detail.opsAdvertiserName"><span>客户主体名称</span><b>{{ detail.opsAdvertiserName }}</b></div>
            <div v-if="detail.elementFingerprint"><span>审核物理指纹(md5)</span><b class="mono" style="font-size:12px">{{ detail.elementFingerprint }}</b></div>
            <div v-if="detail.aiEvaluateReviewerName"><span>审核人</span><b>{{ detail.aiEvaluateReviewerName }}</b></div>
          </div>
        </div>

        <!-- 5 更新记录 -->
        <div v-if="isUpdated(detail)" class="d-sec"><h4><i class="n">5</i>更新记录</h4>
          <div class="upd-timeline">
            <div v-for="(u, i) in detail.updates" :key="i" class="upd-item">
              <span class="upd-dot"></span>
              <div class="upd-body">
                <div class="upd-meta"><b>{{ u.by }}</b><span class="upd-time">{{ u.at }}</span></div>
                <p class="upd-reason">{{ u.reason }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
<button class="btn btn-ghost btn-sm" @click="detailOpen=false; clearDetailOverlay()">关闭</button>
        <button v-if="auth.isAdmin" class="btn btn-danger-outline btn-sm" @click="openDelete(detail)"><Icon name="trash" :size="15" />删除</button>
        <button class="btn btn-primary-outline btn-sm" @click="openToTicket(detail)"><Icon name="ticket" :size="15" />转工单</button>
        <button class="btn btn-primary-outline btn-sm" @click="openEdit(detail)"><Icon name="edit" :size="15" />编辑</button>
        <button class="btn btn-primary btn-sm" @click="exportOne(detail)"><Icon name="download" :size="15" />导出 Word</button>
      </template>
    </Modal>

    <!-- 删除结论确认弹窗（仅管理员） -->
    <Modal v-model="deleteOpen" title="删除结论" width="440px">
      <div v-if="deleteTarget" class="del-body">
        <div class="del-ic"><Icon name="alert" :size="30" /></div>
        <p class="del-warn">确认删除结论「{{ deleteTarget.title }}」？</p>
        <p class="del-tip">删除后该条结论及其更新记录将无法恢复，请谨慎操作。</p>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="deleteOpen=false" :disabled="deleting">取消</button>
        <button class="btn btn-danger btn-sm" :disabled="deleting" @click="confirmDelete">
          <Icon name="trash" :size="15" />{{ deleting ? '删除中…' : '确认删除' }}
        </button>
      </template>
    </Modal>

    <!-- 新增/编辑结论沉淀弹窗 -->
    <Modal v-model="editOpen" :title="editMode==='create' ? '新增结论沉淀' : '编辑结论沉淀'" width="640px">
      <div class="edit-form">
        <div class="form-group">
          <label>标题</label>
          <input v-model="editForm.title" placeholder="请输入标题" />
        </div>
        <div class="form-group">
          <label>问题分类</label>
          <select v-model="editForm.category">
            <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>结果类型</label>
          <select v-model="editForm.resultType">
            <option v-for="r in RESULT_TYPES" :key="r.code" :value="r.code">{{ r.label }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>标签 ID - 标签名</label>
          <input v-model="editForm.tagName" placeholder="请输入标签名" />
        </div>
        <div class="form-group">
          <label>一级行业</label>
          <input v-model="editForm.industryL1" placeholder="如 医疗健康" />
        </div>
        <div class="form-group">
          <label>二级行业</label>
          <input v-model="editForm.industryL2" placeholder="如 医疗美容" />
        </div>
        <div class="form-group">
          <label>提需人</label>
          <input v-model="editForm.submitter" placeholder="请输入提需人" />
        </div>
        <div class="form-group">
          <label>处理人</label>
          <input v-model="editForm.handler" placeholder="请输入处理人" />
        </div>
        <div class="form-group">
          <label>问题描述</label>
          <textarea v-model="editForm.desc" placeholder="请输入问题描述"></textarea>
        </div>
        <div class="form-group">
          <label>专家结论</label>
          <textarea v-model="editForm.conclusion" placeholder="请输入专家结论"></textarea>
        </div>
        <div class="form-group">
          <label>误杀归因</label>
          <textarea v-model="editForm.fpReason" placeholder="请输入误杀归因"></textarea>
        </div>
        <div class="form-group">
          <label>已关联素材</label>
          <div class="rm-block">
            <div class="rm-head"><Icon name="image" :size="13" />已关联素材（{{ (editForm.relatedMaterials || []).length }}）</div>
            <div class="rm-grid" v-if="(editForm.relatedMaterials || []).length">
              <div v-for="(m, idx) in editForm.relatedMaterials" :key="m.id" class="rm-item">
                <div class="rm-thumb clickable" :class="{ vid: isVideoByUrl(m.mediaUrl) && isValidHttpUrl(m.mediaUrl), 'text-type': !isVideoByUrl(m.mediaUrl) && (!m.mediaUrl || !isValidHttpUrl(m.mediaUrl)) }" @click="openPreview(m)">
                  <video v-if="isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" v-lazy-video :data-src="m.mediaUrl" controls playsinline muted @error="onMediaErr(m.id)"></video>
<img v-else-if="!isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" :src="rawHttpsUrlPlain(m.mediaUrl)" :data-raw-url="m.mediaUrl" referrerpolicy="no-referrer" alt="" @error="onMediaErr(m.id, $event)" />
                  <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl) && mediaErr.has(m.id)" class="rm-link-preview" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" /><span>打开原链接</span></a>
                  <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && !isMediaUrl(m.mediaUrl)" class="rm-link-preview" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="20" /><span>打开原链接</span></a>
                  <div v-else-if="m.mediaUrl && !isValidHttpUrl(m.mediaUrl)" class="rm-text-preview">{{ m.mediaUrl.slice(0, 60) }}{{ m.mediaUrl.length > 60 ? '…' : '' }}</div>
                  <div v-else-if="(m.ocr || m.asr)" class="rm-text-preview">{{ (m.ocr || m.asr).slice(0, 60) }}{{ (m.ocr || m.asr).length > 60 ? '…' : '' }}</div>
                  <template v-else>
                    <Icon :name="isVideoByUrl(m.mediaUrl) ? 'film' : 'image'" :size="20" />
                    <span class="rm-type">{{ m.type }}</span>
                  </template>
                  <span v-if="m.mediaUrl || m.ocr || m.asr" class="rm-zoom"><Icon name="search" :size="12" /></span>
                </div>
                <span class="rm-id mono">{{ m.id }}</span>
                <button class="rm-del" @click="removeMaterial(idx)"><Icon name="trash" :size="12" /></button>
              </div>
            </div>
            <p v-else class="rm-empty">无</p>
          </div>
          <div class="form-group">
            <label>添加素材链接</label>
            <input v-model="materialUrlInput" placeholder="请输入素材链接" />
            <button class="btn btn-primary btn-sm" @click="addMaterialUrl">添加</button>
          </div>
        </div>
        <div class="form-group">
          <label>更新原因</label>
          <textarea v-model="editForm.updateReason" placeholder="请输入更新原因"></textarea>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="editOpen=false">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="editSaving" @click="saveEdit">
          {{ editSaving ? '保存中…' : '保存' }}
        </button>
      </template>
    </Modal>

    <!-- 转工单确认弹窗 -->
    <Modal v-model="toTicketOpen" title="转工单" width="440px">
      <div v-if="toTicketTarget" class="del-body">
        <div class="del-ic"><Icon name="alert" :size="30" /></div>
        <p class="del-warn">确认将结论「{{ toTicketTarget.title }}」转为工单？</p>
        <p class="del-tip">转为工单后，该条结论将无法再编辑，请谨慎操作。</p>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="toTicketOpen=false" :disabled="toTicketSaving">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="toTicketSaving" @click="confirmToTicket">
          {{ toTicketSaving ? '转单中…' : '确认转单' }}
        </button>
      </template>
    </Modal>

    <!-- 新增/编辑结论弹窗 -->
    <Modal v-model="editOpen" :title="editMode==='create' ? '新增结论沉淀' : '编辑结论沉淀'" width="720px">
      <div class="edit-form">
        <div class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>标题 <span class="req">*</span></label>
            <input v-model="editForm.title" class="field" placeholder="一句话概括结论" />
          </div>
        </div>
        <div class="ef-row">
          <div class="ef-field">
            <label>标签 ID</label>
            <input v-model.number="editForm.tagId" class="field" type="number" placeholder="如 14776" />
          </div>
          <div class="ef-field">
            <label>标签名</label>
            <input v-model="editForm.tagName" class="field" placeholder="如 虚假人设或事件" />
          </div>
          <div class="ef-field">
            <label>一级行业</label>
            <input v-model="editForm.industryL1" class="field" placeholder="如 医疗健康" />
          </div>
          <div class="ef-field">
            <label>二级行业</label>
            <input v-model="editForm.industryL2" class="field" placeholder="如 医疗美容" />
          </div>
        </div>
        <div class="ef-row">
          <div class="ef-field">
            <label>问题分类</label>
            <select v-model="editForm.category" class="field">
              <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
            </select>
          </div>
          <div class="ef-field">
            <label>结果类型</label>
            <select v-model="editForm.resultType" class="field">
              <option v-for="r in RESULT_TYPES" :key="r.code" :value="r.code">{{ r.label }}</option>
            </select>
          </div>
          <div class="ef-field">
            <label>提需人</label>
            <input v-model="editForm.submitter" class="field" placeholder="提需人姓名" />
          </div>
          <div class="ef-field">
            <label>处理人</label>
            <input v-model="editForm.handler" class="field" placeholder="处理人姓名" />
          </div>
        </div>
        <div class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>问题描述</label>
            <textarea v-model="editForm.desc" class="field textarea" rows="3" placeholder="描述审核执行中遇到的问题"></textarea>
          </div>
        </div>
        <div class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>专家结论 <span class="req">*</span></label>
            <textarea v-model="editForm.conclusion" class="field textarea" rows="4" placeholder="解答结论"></textarea>
          </div>
        </div>
        <div class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>误杀归因</label>
            <textarea v-model="editForm.fpReason" class="field textarea" rows="2" placeholder="如适用，填写误杀归因"></textarea>
          </div>
        </div>

        <!-- 关联素材 -->
        <div class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>关联素材（视频/图片链接）</label>
            <div class="mat-input-row">
              <input v-model="materialUrlInput" class="field" placeholder="粘贴视频或图片URL，回车添加" @keydown.enter.prevent="addMaterialUrl" />
              <button class="btn btn-primary btn-sm" @click="addMaterialUrl">添加</button>
            </div>
            <div v-if="editForm.relatedMaterials.length" class="mat-list">
              <div v-for="(m, i) in editForm.relatedMaterials" :key="m.id || i" class="mat-item">
                <Icon :name="isVideoByUrl(m.mediaUrl) ? 'film' : 'image'" :size="14" />
                <span class="mat-url">{{ m.mediaUrl }}</span>
                <span class="mat-type-tag">{{ isVideoByUrl(m.mediaUrl) ? '视频' : '图片' }}</span>
                <button class="mat-del" @click="removeMaterial(i)"><Icon name="close" :size="13" /></button>
              </div>
            </div>
          </div>
        </div>

        <!-- 可选字段 -->
        <div class="ef-row">
          <div class="ef-field">
            <label>创意ID(DCID)</label>
            <input v-model="editForm.dcId" class="field" placeholder="可选" />
          </div>
          <div class="ef-field">
            <label>客户主体名称</label>
            <input v-model="editForm.opsAdvertiserName" class="field" placeholder="可选" />
          </div>
          <div class="ef-field">
            <label>审核人</label>
            <input v-model="editForm.aiEvaluateReviewerName" class="field" placeholder="可选" />
          </div>
        </div>

        <div v-if="editMode==='edit'" class="ef-row">
          <div class="ef-field ef-field-wide">
            <label>更新原因（将记录到更新时间线）</label>
            <input v-model="editForm.updateReason" class="field" placeholder="如：修正结论描述、补充素材等" />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="editOpen=false" :disabled="editSaving">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="editSaving" @click="saveEdit">
          <Icon name="check" :size="15" />{{ editSaving ? '保存中…' : (editMode==='create' ? '新增' : '保存') }}
        </button>
      </template>
    </Modal>

    <!-- 转工单确认弹窗 -->
    <Modal v-model="toTicketOpen" title="转工单" width="440px">
      <div v-if="toTicketTarget" class="del-body">
        <div class="del-ic" style="background:#eff6ff;color:#2563eb"><Icon name="ticket" :size="30" /></div>
        <p class="del-warn">将结论「{{ toTicketTarget.title }}」转为提需工单？</p>
        <p class="del-tip">系统将根据该沉淀记录的标签、行业、关联素材等字段自动创建一份正式工单，并进入公共池待处理人抢单。</p>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="toTicketOpen=false" :disabled="toTicketSaving">取消</button>
        <button class="btn btn-primary btn-sm" :disabled="toTicketSaving" @click="confirmToTicket">
          <Icon name="ticket" :size="15" />{{ toTicketSaving ? '创建中…' : '创建工单' }}
        </button>
      </template>
    </Modal>

    <!-- 素材预览弹窗 -->
    <transition name="fade-scale">
    <div v-if="previewOpen && previewMedia" class="pv-overlay" @click.self="closePreview">
      <div class="pv-modal">
        <button class="pv-close" @click="closePreview"><Icon name="close" :size="18" /></button>
        <div class="pv-media">
<video v-if="isVideoByUrl(previewMedia.mediaUrl) && previewMedia.mediaUrl && !mediaErr.has(previewMedia.id) && isValidHttpUrl(previewMedia.mediaUrl) && isMediaUrl(previewMedia.mediaUrl)" ref="previewVideoRef" v-lazy-video :data-src="previewMedia.mediaUrl" :data-raw-url="previewMedia.mediaUrl" controls autoplay playsinline @error="onMediaErr(previewMedia.id)"></video>
          <img v-else-if="!isVideoByUrl(previewMedia.mediaUrl) && previewMedia.mediaUrl && !mediaErr.has(previewMedia.id) && isValidHttpUrl(previewMedia.mediaUrl) && isMediaUrl(previewMedia.mediaUrl)" :src="rawHttpsUrlPlain(previewMedia.mediaUrl)" :data-raw-url="previewMedia.mediaUrl" referrerpolicy="no-referrer" alt="" @error="onMediaErr(previewMedia.id, $event)" />
          <div v-else class="pv-text-preview">
            <a v-if="previewMedia.mediaUrl && isValidHttpUrl(previewMedia.mediaUrl)" class="pv-fallback-link" :href="safeUrl(previewMedia.mediaUrl)" target="_blank"><Icon name="link" :size="18" /> 打开原链接</a>
            <div class="pv-text-body" v-if="previewMedia.mediaUrl && !isValidHttpUrl(previewMedia.mediaUrl)">{{ previewMedia.mediaUrl }}</div>
            <div class="pv-text-body" v-else-if="previewMedia.ocr || previewMedia.asr">{{ previewMedia.ocr || previewMedia.asr }}</div>
            <p v-else class="pv-text-empty">该素材暂无预览内容</p>
          </div>
        </div>
        <div class="pv-bar">
          <span class="pv-id">{{ previewMedia.id }}</span>
          <span class="pv-type">{{ isVideoByUrl(previewMedia.mediaUrl) ? 'video' : 'image' }}</span>
          <button v-if="isVideoByUrl(previewMedia.mediaUrl)" class="pv-speed" @click="cyclePreviewSpeed">{{ previewSpeed }}x</button>
        </div>
      </div>
    </div>
  </transition>
  </div>
</template>

<style scoped>
.ph { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; flex-wrap: wrap; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin-bottom: 18px; }
.main-grid { display: grid; grid-template-columns: 1fr 320px; gap: 18px; align-items: start; }
.lib-card { padding: 20px 24px; }
.lib-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: nowrap; }
.search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text-3); flex: 1 1 auto; min-width: 160px; }
.search:focus-within { border-color: var(--brand); }
.search input { flex: 1; min-width: 0; font-size: 14px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }
.field.sm { height: 38px; flex-shrink: 0; }
.date-seg, .view-seg { display: flex; background: #f0f2f6; border-radius: 9px; padding: 3px; flex-shrink: 0; }
.date-seg button { padding: 5px 11px; border-radius: 7px; font-size: 12px; color: var(--text-2); font-weight: 500; transition: all .15s; }
.date-seg button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); }
.view-seg button { width: 32px; height: 28px; border-radius: 7px; display: grid; place-items: center; color: var(--text-3); }
.view-seg button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); }

.sed-cards { display: grid; grid-template-columns: 1fr; gap: 12px; }
.sed-card { padding: 16px 20px; border: 1px solid var(--border); border-radius: 14px; cursor: pointer; transition: all .2s; }
.sed-card:hover { border-color: var(--brand); box-shadow: var(--shadow-md); transform: translateY(-1px); }
.sc-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.sc-date { margin-left: auto; font-size: 12px; color: var(--text-4); }
.sc-conc { font-size: 14px; color: var(--text-1); line-height: 1.75; margin-bottom: 14px; }
.sc-foot { display: flex; align-items: center; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-3); }
.sc-people { display: flex; align-items: center; gap: 5px; }
.sc-exp-txt { margin-left: auto; display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--brand); padding: 4px 8px; border-radius: 7px; transition: all .15s; }
.sc-exp-txt:hover { background: var(--brand-soft); }
.sc-exp { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--text-3); transition: all .15s; }
.sc-exp:hover { background: var(--brand-soft); color: var(--brand); }

.sed-list { display: flex; flex-direction: column; }
.sl-head, .sl-row { display: grid; grid-template-columns: 1.6fr 1.4fr .8fr 1fr .8fr .8fr 68px; align-items: center; gap: 12px; padding: 12px; }
.sl-head { font-size: 12px; color: var(--text-3); font-weight: 600; border-bottom: 1px solid var(--border); }
.sl-row { border-bottom: 1px solid var(--border); cursor: pointer; transition: all .15s; border-radius: 10px; font-size: 13px; color: var(--text-2); }
.sl-row:hover { background: var(--bg-soft); }
.sl-row .c-tag b { color: var(--text-1); margin-right: 4px; }
.mono { font-family: monospace; } .dim { color: var(--text-4); }
.c-op { text-align: right; display: flex; gap: 4px; justify-content: flex-end; }

/* 按标签聚合视图 */
.sed-groups { display: flex; flex-direction: column; gap: 12px; }
.sed-group { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; transition: all .18s; }
.sed-group:hover { border-color: var(--brand); }
.sg-hd { display: flex; align-items: center; gap: 14px; padding: 14px 18px; cursor: pointer; background: #fff; }
.sg-hd:hover { background: var(--bg-soft); }
.sg-stats { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text-2); }
.sg-stat { display: inline-flex; align-items: center; white-space: nowrap; }
.sg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; flex-shrink: 0; }
.sg-dot.total { background: var(--brand); }
.sg-dot.red { background: var(--red); }
.sg-dot.green { background: var(--green); }
.sg-dot.gray { background: var(--text-4); }
.sg-arrow { margin-left: auto; color: var(--text-3); flex-shrink: 0; }
.sg-body { display: flex; flex-direction: column; border-top: 1px solid var(--border); }
.sg-item { display: grid; grid-template-columns: 76px 1fr auto; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); cursor: pointer; transition: all .15s; }
.sg-item:last-child { border-bottom: none; }
.sg-item:hover { background: var(--bg-soft); }
.sg-conc { font-size: 13px; color: var(--text-1); line-height: 1.6; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-meta { font-size: 11px; color: var(--text-4); white-space: nowrap; }

.side-charts { display: flex; flex-direction: column; gap: 18px; }
.sch { padding: 18px 20px; }
.sch h3 { font-size: 14px; font-weight: 700; margin-bottom: 8px; }

.detail .d-tags { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 18px; }
.d-sec { margin-bottom: 18px; }
.d-sec h4 { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; margin-bottom: 9px; }
.d-sec .n { width: 22px; height: 22px; border-radius: 7px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; font-size: 12px; font-weight: 800; }
.d-sec p { font-size: 13px; color: var(--text-1); line-height: 1.8; padding-left: 31px; }
.d-info { padding-left: 31px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.d-info > div { display: flex; flex-direction: column; gap: 4px; }
.d-info span { font-size: 12px; color: var(--text-3); }
.d-info b { font-size: 13px; color: var(--text-1); font-weight: 600; }

/* KPI 可点击筛选 */
.kpi-click { position: relative; cursor: pointer; border-radius: 18px; transition: all .2s; }
.kpi-click :deep(.kpi) { transition: all .2s; }
.kpi-click:hover :deep(.kpi) { transform: translateY(-3px); box-shadow: var(--shadow-md); }
.kpi-click.active :deep(.kpi) { box-shadow: 0 0 0 2px var(--brand) inset, var(--shadow-md); }
.kpi-flag { position: absolute; right: 14px; top: 14px; font-size: 11px; color: var(--text-4); background: var(--bg-soft); padding: 2px 8px; border-radius: 20px; opacity: 0; transition: opacity .2s; }
.kpi-click:hover .kpi-flag { opacity: 1; }
.kpi-click.active .kpi-flag { opacity: 1; color: var(--brand); background: var(--brand-soft); }
.kpi-click.active .kpi-flag::before { content: '✓ '; }

/* 卡片：已更新左上角标 */
.sed-card { position: relative; }
.sed-card.updated { border-color: #ffd9a8; }
.upd-corner { position: absolute; left: -1px; top: -1px; display: inline-flex; align-items: center; gap: 3px; padding: 4px 10px 4px 8px; font-size: 11px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #f5a000, #f08a00); border-radius: 14px 0 14px 0; box-shadow: 0 2px 6px rgba(240,138,0,.3); z-index: 1; }

/* 列表：已更新 mini 角标 */
.upd-mini { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; padding: 1px 7px; font-size: 10px; font-weight: 700; color: #f08a00; background: #fff4e0; border-radius: 20px; vertical-align: middle; }

/* 详情：更新时间线 */
.upd-timeline { padding-left: 31px; display: flex; flex-direction: column; }
.upd-item { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--border); }
.upd-item:last-child { border-left-color: transparent; padding-bottom: 0; }
.upd-dot { position: absolute; left: -6px; top: 3px; width: 10px; height: 10px; border-radius: 50%; background: #f5a000; box-shadow: 0 0 0 3px #fff4e0; }
.upd-meta { display: flex; align-items: center; gap: 10px; }
.upd-meta b { font-size: 13px; color: var(--text-1); font-weight: 700; }
.upd-time { font-size: 12px; color: var(--text-4); font-family: monospace; }
.upd-reason { font-size: 13px; color: var(--text-2); line-height: 1.7; margin-top: 4px; }

/* 已关联素材 */
.rm-block { padding-left: 31px; margin-top: 12px; }
.rm-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 10px; }
.rm-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.rm-item { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.rm-thumb { position: relative; width: 84px; height: 60px; border-radius: 9px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-4); }
.rm-thumb img { width: 100%; height: 100%; object-fit: cover; }
.rm-thumb.vid { background: #eef1f8; }
.rm-type { position: absolute; left: 4px; bottom: 4px; padding: 0 5px; font-size: 10px; line-height: 15px; color: #fff; background: rgba(20,30,60,.6); border-radius: 5px; }
.rm-id { font-size: 11px; color: var(--text-4); }
.rm-empty { font-size: 13px; color: var(--text-4); }

/* 专家结论澄清提示 */
.d-tip { display: flex; align-items: center; gap: 6px; margin: 10px 0 0 31px; padding: 8px 12px; font-size: 12px; color: #b67400; background: #fff8ec; border: 1px solid #ffe6bf; border-radius: 9px; }

/* 误杀归因 无 */
.d-sec p.none { color: var(--text-4); }

@media (max-width: 1000px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } .main-grid { grid-template-columns: 1fr; } .d-info { grid-template-columns: 1fr; } }

/* 删除结论：操作按钮 + 确认弹窗 */
.sc-del-txt { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #dc2626; padding: 4px 8px; border-radius: 7px; transition: all .15s; }
.sc-del-txt:hover { background: #fef2f2; }
.sc-del { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--text-3); transition: all .15s; }
.sc-del:hover { background: #fef2f2; color: #dc2626; }
.btn-danger-outline { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; height: 32px; border: 1px solid #fecaca; background: #fff; color: #dc2626; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-danger-outline:hover { background: #fef2f2; border-color: #fca5a5; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(220,38,38,.12); }
.btn-danger { display: inline-flex; align-items: center; gap: 6px; padding: 0 18px; height: 34px; border: none; background: #dc2626; color: #fff; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-danger:hover { background: #b91c1c; transform: translateY(-1px); }
.btn-danger:disabled, .btn-danger-outline:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.del-body { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 6px 0 4px; }
.del-ic { width: 60px; height: 60px; border-radius: 18px; background: #fef2f2; color: #dc2626; display: grid; place-items: center; margin-bottom: 6px; }
.del-warn { font-size: 14px; color: var(--text-1); line-height: 1.7; }
.del-tip { font-size: 12.5px; color: var(--text-4); line-height: 1.6; }

/* 素材预览弹窗 */
.pv-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(8,12,20,.82); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 32px; }
.pv-modal { position: relative; width: 100%; max-width: 800px; max-height: 90vh; background: #fff; border-radius: 18px; box-shadow: 0 24px 80px rgba(15,22,36,.3); overflow: hidden; display: flex; flex-direction: column; }
.pv-close { position: absolute; top: 14px; right: 14px; z-index: 10; width: 36px; height: 36px; border-radius: 10px; background: rgba(20,24,34,.55); border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 14px rgba(0,0,0,.25); display: grid; place-items: center; color: #fff; cursor: pointer; transition: all .15s; backdrop-filter: blur(4px); }
.pv-close:hover { background: #ff4d4f; border-color: #ff4d4f; transform: scale(1.06); }
.pv-media { width: 100%; flex: 1; min-height: 0; background: #0e1118; display: flex; align-items: center; justify-content: center; }
.pv-media video { max-width: 100%; max-height: 70vh; object-fit: contain; }
.pv-media img { max-width: 100%; max-height: 70vh; object-fit: contain; }
.pv-text-preview { display: flex; flex-direction: column; align-items: center; gap: 16px; color: #fff; padding: 32px; width: 100%; max-height: 70vh; overflow-y: auto; }
.pv-fallback-link { display: inline-flex; align-items: center; gap: 6px; color: #8b5cf6; text-decoration: none; font-size: 14px; padding: 8px 16px; border: 1px solid #8b5cf6; border-radius: 6px; transition: background .15s; }
.pv-fallback-link:hover { background: rgba(139,92,246,0.1); }
.pv-text-body { width: 100%; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 20px 24px; font-size: 14px; line-height: 1.8; color: rgba(255,255,255,.85); white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow-y: auto; }
.pv-text-empty { font-size: 14px; color: rgba(255,255,255,.4); padding: 60px 0; }
.pv-bar { display: flex; align-items: center; gap: 12px; padding: 12px 18px; background: #fff; border-top: 1px solid var(--border); }
.pv-id { font-size: 13px; font-weight: 600; color: var(--text-2); font-family: monospace; }
.pv-type { font-size: 12px; color: var(--text-3); background: var(--bg-soft); padding: 3px 8px; border-radius: 6px; }
.pv-speed { margin-left: auto; padding: 5px 14px; border-radius: 8px; background: var(--brand-soft); color: var(--brand); font-size: 13px; font-weight: 700; border: 1px solid var(--brand-soft); cursor: pointer; transition: all .15s; }
.pv-speed:hover { background: var(--brand); color: #fff; }

/* 素材缩略图可点击 + 预览放大图标 */
.rm-thumb.clickable { cursor: pointer; }
.rm-thumb.clickable:hover { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.rm-thumb.clickable video { pointer-events: none; }
.rm-zoom { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 6px; background: rgba(20,24,34,.55); color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .15s; backdrop-filter: blur(4px); }
.rm-thumb.clickable:hover .rm-zoom { opacity: 1; }
.rm-thumb img, .rm-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.rm-text-preview { padding: 4px 6px; font-size: 10px; line-height: 1.4; color: var(--text-2); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.rm-link-preview { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--brand); text-decoration: none; font-size: 10px; width: 100%; height: 100%; }
.rm-thumb.text-type { width: 150px; display: block; place-items: unset; }

/* fade-scale 过渡 */
.fade-scale-enter-active, .fade-scale-leave-active { transition: all .2s ease; }
.fade-scale-enter-from, .fade-scale-leave-to { opacity: 0; transform: scale(.94); }

/* 页面头部操作按钮组 */
.ph-actions { display: flex; gap: 8px; align-items: center; }
.btn-primary-outline { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; height: 32px; border: 1px solid var(--brand-soft); background: #fff; color: var(--brand); border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-primary-outline:hover { background: var(--brand-soft); border-color: var(--brand); transform: translateY(-1px); }

/* 新增/编辑弹窗表单 */
.edit-form { display: flex; flex-direction: column; gap: 14px; }
.ef-row { display: flex; gap: 14px; flex-wrap: wrap; }
.ef-field { display: flex; flex-direction: column; gap: 5px; flex: 1 1 0; min-width: 140px; }
.ef-field-wide { flex: 1 1 100%; }
.ef-field label { font-size: 12px; font-weight: 600; color: var(--text-3); }
.ef-field label .req { color: #dc2626; }
.ef-field .field { height: 36px; }
.ef-field .textarea { height: auto; padding: 8px 12px; line-height: 1.6; resize: vertical; min-height: 60px; }
.mat-input-row { display: flex; gap: 8px; }
.mat-input-row .field { flex: 1; }
.mat-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 160px; overflow-y: auto; }
.mat-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-soft); border-radius: 8px; font-size: 12px; color: var(--text-2); }
.mat-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-type-tag { flex-shrink: 0; padding: 2px 7px; font-size: 10px; font-weight: 600; color: var(--brand); background: var(--brand-soft); border-radius: 5px; }
.mat-del { width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; color: var(--text-4); flex-shrink: 0; transition: all .15s; }
.mat-del:hover { background: #fef2f2; color: #dc2626; }
</style>