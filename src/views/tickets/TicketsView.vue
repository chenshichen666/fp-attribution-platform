<script setup>
import { ref, computed, onMounted, onUnmounted, onActivated, nextTick, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { useTicketFlowStore } from '../../stores/ticketFlow'
import { PROBLEM_CATEGORIES } from '../../data/mock'
import { ticketApi } from '../../api'
import { usePersistedRef, useRemotePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'
import EmptyState from '../../components/EmptyState.vue'
import SimilarLibraryModal from '../../components/SimilarLibraryModal.vue'
import { getShareIdFromUrl, openShare } from '../../utils/share'

const auth = useAuthStore()
const toast = useToastStore()
const router = useRouter()
const route = useRoute()
const ticketFlow = useTicketFlowStore()

// T0：采用「前端直链 + http→https 升级」模式，直链失败由 onMediaErr 触发「打开原链接」逃生通道。
// 直链失败由 onMediaErr 触发「打开原链接」新标签逃生通道（等价 onMediaError 兜底）。
import { previewSrc, isBadShardUrl, isMediaUrl, retryOriginalSrc, rawHttpsUrlPlain, mediaProxyFallback } from '../../utils/mediaPreview.js'
function safeUrl(url) {
  return previewSrc(url)
}

// 视角：提需人 / 处理人（依据角色默认）
const persp = useRemotePersistedRef('tickets:persp', auth.isHandler && !auth.isSubmitter ? 'handler' : 'submitter')
const canSubmitter = computed(() => auth.isSubmitter || auth.isAdmin)
const canHandler = computed(() => auth.isHandler || auth.isAdmin)

const tickets = ref([])
const loading = ref(false)
const submitting = ref(false)

async function loadTickets() {
  loading.value = true
  try {
    const list = await ticketApi.list()
    tickets.value = Array.isArray(list) ? list : []
  } catch (e) {
    toast.error(e.message || '加载工单列表失败')
  } finally {
    loading.value = false
  }
}

// 状态文案映射（截图4状态 tab，底层状态机按 PRD）
const URGENCY = { 1: { t: '低', c: 'gray' }, 2: { t: '中', c: 'orange' }, 3: { t: '高', c: 'red' } }
// 提需人侧 tab：全部/提需中(submitted+accepted+rejected,流转中)/待采纳(concluded)/已结束(done)
const SUB_TABS = [
  { v: 'all', t: '全部' },
  { v: 'doing', t: '提需中', st: ['submitted', 'accepted', 'rejected'] },
  { v: 'wait', t: '待采纳', st: ['concluded'] },
  { v: 'done', t: '已结束', st: ['done'] },
]
// 处理人侧 tab：全部/可抢单(submitted)/处理中(accepted+rejected,含退回重处理)/已结束(concluded+done)
const HDL_TABS = [
  { v: 'all', t: '全部' },
  { v: 'pool', t: '可抢单', st: ['submitted'] },
  { v: 'mine', t: '处理中', st: ['accepted', 'rejected'] },
  { v: 'closed', t: '已结束', st: ['concluded', 'done'] },
]
const tab = useRemotePersistedRef('tickets:tab', 'all')
const kw = useRemotePersistedRef('tickets:kw', '')

function statusText(s) {
  const map = persp.value === 'submitter'
    ? { submitted: '提需中', accepted: '受理中', concluded: '待采纳', done: '已采纳', rejected: '受理中' }
    : { submitted: '受理中', accepted: '处理中', concluded: '已给结论', done: '已结束', rejected: '待重新处理' }
  return map[s] || s
}
function statusCls(s) {
  if (persp.value === 'submitter') {
    return { submitted: 'badge-orange', accepted: 'badge-orange', concluded: 'badge-purple', done: 'badge-green', rejected: 'badge-orange' }[s]
  }
  return { submitted: 'badge-orange', accepted: 'badge-blue', concluded: 'badge-purple', done: 'badge-green', rejected: 'badge-red' }[s]
}

const curTabs = computed(() => persp.value === 'submitter' ? SUB_TABS : HDL_TABS)
function tabCount(v) {
  const def = curTabs.value.find(t => t.v === v)
  if (!def || v === 'all') return tickets.value.length
  return tickets.value.filter(t => def.st.includes(t.status)).length
}
const filtered = computed(() => {
  const def = curTabs.value.find(t => t.v === tab.value)
  return tickets.value.filter(t => {
    if (def && def.st && !def.st.includes(t.status)) return false
  if (kw.value && !t.title.includes(kw.value) && !String(t.id).includes(kw.value)) return false
    return true
  })
})
function switchPersp(p) { persp.value = p; tab.value = 'all'; activeGroup.value = ''; if (p === 'submitter') loadDrafts() }

// 红点：待采纳
const hasWait = computed(() => tickets.value.some(t => t.status === 'concluded'))

// ===== 处理人视角：按「一级行业-二级行业」聚类 =====
const activeGroup = useRemotePersistedRef('tickets:activeGroup', '')

// 打开的弹窗/抽屉自动还原（跨设备延续）：持久化「当前打开的工单 id / 素材 id」
const overlayState = useRemotePersistedRef('tickets:overlay', { handleTicketId: '', previewMediaId: '' })
function persistOverlay() {
  overlayState.value = {
    handleTicketId: handleTicket.value?.id || '',
    previewMediaId: previewMedia.value?.id || '',
  }
}
function clearOverlay() {
  if (overlayState.value.handleTicketId || overlayState.value.previewMediaId) {
    overlayState.value = { handleTicketId: '', previewMediaId: '' }
  }
}

// 分享：应用对方发来的 UI 状态
async function applyTicketsShare(res) {
  const s = res?.uiState || {}
  if (s.persp) persp.value = s.persp
  if (s.tab) tab.value = s.tab
  if (typeof s.kw === 'string') kw.value = s.kw
  if (typeof s.activeGroup === 'string') activeGroup.value = s.activeGroup
  if (s.overlay && (s.overlay.handleTicketId || s.overlay.previewMediaId)) {
    overlayState.value = { handleTicketId: s.overlay.handleTicketId || '', previewMediaId: s.overlay.previewMediaId || '' }
  }
  toast.info('已打开分享的工单页面，可在此基础上继续操作')
}

function groupKey(t) { return `${t.industryL1 || '未分类'}/${t.industryL2 || '其他'}` }
// 基于已过滤（tab+搜索）的工单聚合为行业分组
const industryGroups = computed(() => {
  const map = new Map()
  for (const t of filtered.value) {
    const key = groupKey(t)
    if (!map.has(key)) {
      map.set(key, { key, l1: t.industryL1 || '未分类', l2: t.industryL2 || '其他', items: [], pool: 0, doing: 0, closed: 0 })
    }
    const g = map.get(key)
    g.items.push(t)
    if (t.status === 'submitted') g.pool++
    else if (t.status === 'accepted' || t.status === 'rejected') g.doing++
    else g.closed++
  }
  // 可抢单多的分组优先靠前
  return [...map.values()].sort((a, b) => (b.pool - a.pool) || (b.items.length - a.items.length))
})
// 当前选中分组内的工单
const groupTickets = computed(() => {
  const g = industryGroups.value.find(x => x.key === activeGroup.value)
  return g ? g.items : []
})
function openGroup(key) { activeGroup.value = key; expanded.value = null }
function backToGroups() { activeGroup.value = '' }
const activeGroupInfo = computed(() => industryGroups.value.find(x => x.key === activeGroup.value) || null)

// 是否处于「处理人分组浏览态」（展示行业分组卡，而非工单列表）
const inGroupBrowse = computed(() => persp.value === 'handler' && (!activeGroup.value || !activeGroupInfo.value))
// 当前应渲染的工单列表：提需人=filtered；处理人进入分组后=该组工单
const visibleTickets = computed(() => persp.value === 'handler' ? groupTickets.value : filtered.value)

// 行展开
const expanded = ref(null)
function toggleRow(id) { expanded.value = expanded.value === id ? null : id }

// 新建提需（三步）
const newOpen = ref(false)
// 关闭弹窗时是否跳过「退出提需返回来源页」逻辑（流程内跳转/提交成功时置位）
let _bypassAbort = false
// 代理 newOpen：当用户主动关闭弹窗（取消/遮罩/X）放弃提需时，若存在来源页则返回
const newOpenProxy = computed({
  get: () => newOpen.value,
  set: (val) => {
    if (!val && newOpen.value && !_bypassAbort) {
      // 关闭弹窗时若仍有实质内容，先异步暂存草稿（防止中断丢失），再走原关闭逻辑
      const hasContent = form.value.samples.length || form.value.title || form.value.desc || form.value.tag
      if (hasContent) {
        saveDraftNow().finally(() => {
          const origin = ticketFlow.consumeOrigin()
          newOpen.value = false
          if (origin) {
            ticketFlow.cancel()
            resetForm()
            currentDraftId.value = ''
            router.push(origin)
            return
          }
          ticketFlow.cancel()
          resetForm()
          currentDraftId.value = ''
        })
        _bypassAbort = false
        return
      }
      const origin = ticketFlow.consumeOrigin()
      newOpen.value = false
      if (origin) {
        ticketFlow.cancel()
        resetForm()
        currentDraftId.value = ''
        router.push(origin)
        return
      }
    }
    _bypassAbort = false
    newOpen.value = val
  },
})
const step = ref(1)
const fieldsReady = ref(false)
const lastAutoTitle = ref('')
const form = ref(genForm())
function genForm() {
  return { tagId: '', tag: '', tagDetail: '', elementType: '', industryL1: '', industryL2: '',
    reviewerName: '', dcId: '', advertiserId: '', elementFingerprint: '',
    title: '', desc: '', urgency: 2, category: '', categoryOther: '', samples: [], clusters: [], notifyUsers: [], notifyInput: '',
    handler: '', handlerInput: '', ccUsers: [], ccInput: '', parentTicketId: '' }
}
function resetForm() { form.value = genForm(); step.value = 1; fieldsReady.value = false; lastAutoTitle.value = ''; currentDraftId.value = '' }
function openNew() { form.value = genForm(); step.value = 1; fieldsReady.value = false; lastAutoTitle.value = ''; currentDraftId.value = ''; newOpen.value = true }
// 消费从标签跟踪/自由分析带回的素材（发起提需），打开工单表单弹窗。
// 因 TicketsView 被 <keep-alive> 缓存，从选素材页跳回时 onMounted 不再触发，
// 故提取为独立函数，onMounted（首次）与 onActivated（缓存激活）均调用。
function consumeTicketFlow() {
  if (ticketFlow.active && (ticketFlow.samples.length || ticketFlow.clusters.length)) {
    const { samples, clusters, tagContext } = ticketFlow.consume()
    form.value.samples = samples
    form.value.clusters = clusters
    // 用标签上下文自动填充工单字段
    if (tagContext) {
      form.value.tagId = tagContext.tagId || ''
      form.value.tag = tagContext.tag || ''
      form.value.elementType = tagContext.elementType || ''
      form.value.industryL1 = tagContext.industryL1 || ''
      form.value.industryL2 = tagContext.industryL2 || ''
      fieldsReady.value = true
    } else {
      fieldsReady.value = false
    }
    step.value = 1
    currentDraftId.value = ''
    newOpen.value = true
    toast.success(`已带回 ${form.value.samples.length} 条素材，请继续提需`)
  } else if (ticketFlow.active) {
    ticketFlow.cancel()
  }
}
onMounted(() => {
  loadTickets()
  if (canShowDrafts.value) loadDrafts()
  // 处理通知跳转：?t=TKT-xxxx 自动展开对应工单并滚动到可视区域
  const targetId = route.query.t
  if (targetId) {
    // 等待工单加载完成后定位
    const unwatch = watch(tickets, (list) => {
      if (list.length) {
        // 先找到目标工单
        const target = list.find(t => t.id === targetId)
        if (target) {
          // 如果是处理人视角，先自动进入目标工单所在的行业分组
          if (persp.value === 'handler') {
            activeGroup.value = groupKey(target)
          }
        }
        nextTick(() => {
          const el = document.querySelector(`.tk-item[data-ticket-id="${targetId}"]`)
          if (el) {
            expanded.value = targetId
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        })
        unwatch()
      }
    }, { once: true })
  } else {
    // 分享链接进入：还原对方页面（模块 + 筛选 + 打开的弹窗），并以对方状态覆盖本地 overlay
    const shareId = getShareIdFromUrl()
    if (shareId) {
      openShare(shareId, applyTicketsShare).catch(() => toast.warn('分享链接打开失败或已失效'))
      return
    }
    // 打开的弹窗/抽屉自动还原（跨设备延续）：加载完成后按持久化的 overlay 重新推开
    const ov = overlayState.value || {}
    if (ov.handleTicketId || ov.previewMediaId) {
      const unwatch2 = watch(tickets, (list) => {
        if (!list.length) return
        if (ov.handleTicketId) {
          const t = list.find(x => x.id === ov.handleTicketId)
          if (t) openHandle(t)
        } else if (ov.previewMediaId) {
          // 找到含该素材的工单并预览
          const t = list.find(x => (materialList(x) || []).some(m => m.id === ov.previewMediaId))
          if (t) {
            const m = (materialList(t) || []).find(x => x.id === ov.previewMediaId)
            if (m) openPreview(m, materialList(t))
          }
        }
        unwatch2()
      }, { once: true })
    }
  }
  if (ticketFlow.active && ticketFlow.samples.length) {
    consumeTicketFlow()
  } else if (ticketFlow.active) {
    ticketFlow.cancel()
  }
})
// keep-alive 缓存激活时也消费带回的素材（从标签跟踪/自由分析返回提需）
onActivated(() => {
  consumeTicketFlow()
})
// 键盘快捷键：预览弹窗左右切换
onMounted(() => document.addEventListener('keydown', onPreviewKeydown))
onUnmounted(() => document.removeEventListener('keydown', onPreviewKeydown))
function gotoDetail() { _bypassAbort = true; ticketFlow.begin(); newOpen.value = false; router.push({ name: 'classify', query: { from: 'ticket', tab: 'track' } }) }
function gotoAnnotate() { _bypassAbort = true; ticketFlow.begin(); newOpen.value = false; router.push({ name: 'classify', query: { from: 'ticket', tab: 'classify' } }) }
function clearSamples() { form.value.samples = []; toast.info('已清空，请重新选择素材') }
function autoFields() {
  if (!form.value.samples.length) { toast.warn('请先选择素材'); return }
  const first = form.value.samples[0] || {}
  // 优先取素材自身携带的标签上下文；若无则尝试从 tagContext 兜底
  const tagId = first.tagId || first.tag_id || (form.value.tagId || '')
  const tag = first.tag || first.tagName || (form.value.tag || '')
  const elementType = first.elementType || first.element_type || (form.value.elementType || '')
  const industryL1 = first.industryL1 || first.industry_l1 || first.industryL1Name || (form.value.industryL1 || '')
  const industryL2 = first.industryL2 || first.industry_l2 || first.industryL2Name || (form.value.industryL2 || '')
  if (tagId) form.value.tagId = String(tagId)
  if (tag) form.value.tag = tag
  if (elementType) form.value.elementType = elementType
  if (industryL1) form.value.industryL1 = industryL1
  if (industryL2) form.value.industryL2 = industryL2
  // 自动提取审核人、创意ID、广告主ID、审核物理指纹
  form.value.reviewerName = first.reviewerName || first.aiEvaluateReviewerName || first.ai_evaluate_reviewer_name || ''
  form.value.dcId = first.dcId || first.dc_id || ''
  form.value.advertiserId = first.advertiserId || first.uid || ''
  form.value.elementFingerprint = first.elementFingerprint || first.element_fingerprint || ''
  fieldsReady.value = true
  // 自动生成工单标题
  syncAutoTitle()
  toast.success('已依据所选素材一键带出工单字段，可手动修改或补充')
}
// 进入 step2 时保留 tagContext 预填的字段，并同步一次标题
function enterStep2() {
  form.value.tagDetail = ''
  step.value = 2
  autoFields()
  nextTick(() => syncAutoTitle())
}
// 工单标题自动拼接：标签 | 元素类型 | 一级行业/二级行业
const autoTitlePlaceholder = computed(() => buildAutoTitle() || '请输入工单标题…')
function buildAutoTitle() {
  const parts = []
  const tagId = form.value.tagId
  const tagName = form.value.tag
  if (tagId && tagName) parts.push(`${tagId}-${tagName}`)
  else if (tagName) parts.push(tagName)
  else if (tagId) parts.push(String(tagId))
  if (form.value.elementType) parts.push(form.value.elementType)
  const ind = [form.value.industryL1, form.value.industryL2].filter(Boolean).join('/')
  if (ind) parts.push(ind)
  return parts.join(' | ')
}
// 当标题为空或等于上次自动值时，跟随字段变化自动更新；用户手动改过则不再覆盖
function syncAutoTitle() {
  const auto = buildAutoTitle()
  if (!auto) return
  // 若标题为空，或标题仍是上一次自动值（用户未手动编辑），则更新
  if (!form.value.title || form.value.title === lastAutoTitle.value) {
    form.value.title = auto
    lastAutoTitle.value = auto
  }
}
// 标签展示：读时拼成「标签ID-标签名」，写时拆回 tagId / tag
const tagDisplay = computed({
  get() {
    const id = form.value.tagId
    const name = form.value.tag
    if (id && name) return `${id}-${name}`
    return name || (id ? `${id}` : '')
  },
  set(v) {
    const str = (v || '').trim()
    const m = str.match(/^(\d+)\s*-\s*(.*)$/)
    if (m) {
      form.value.tagId = m[1]
      form.value.tag = m[2]
    } else {
      // 纯文字：保留原 tagId，仅更新标签名
      form.value.tag = str
    }
    nextTick(() => syncAutoTitle())
  },
})
function removeSample(s) { form.value.samples = form.value.samples.filter(x => (x.id || x) !== (s.id || s)) }
function removeCluster(cl) { form.value.clusters = form.value.clusters.filter(x => x.classId !== cl.classId) }
function sampleId(s) { return s.id || s }
function sampleType(s) { return s.type || '图片' }
function addNotifyUser() {
  const v = (form.value.notifyInput || '').trim()
  if (!v) return
  if (form.value.notifyUsers.includes(v)) { toast.warn('该通知对象已添加'); form.value.notifyInput = ''; return }
  form.value.notifyUsers.push(v)
  form.value.notifyInput = ''
}
async function submitTicket() {
  if (!form.value.title.trim()) { toast.warn('请填写工单标题'); return }
  if (!form.value.desc.trim()) { toast.warn('请撰写问题描述'); return }
  submitting.value = true
  try {
    // 使用前端本地时间作为工单创建时间
    const localNow = new Date()
    const localTimeStr = localNow.getFullYear() + '-' +
      String(localNow.getMonth() + 1).padStart(2, '0') + '-' +
      String(localNow.getDate()).padStart(2, '0') + ' ' +
      String(localNow.getHours()).padStart(2, '0') + ':' +
      String(localNow.getMinutes()).padStart(2, '0') + ':' +
      String(localNow.getSeconds()).padStart(2, '0')
    const created = await ticketApi.create({
      title: form.value.title, tag: form.value.tag, tagId: form.value.tagId,
      elementType: form.value.elementType, industryL1: form.value.industryL1, industryL2: form.value.industryL2,
      urgency: form.value.urgency, sampleCount: form.value.samples.length,
      desc: form.value.desc, samplesData: form.value.samples, clusters: form.value.clusters, notifyUsers: form.value.notifyUsers,
      reviewerName: form.value.reviewerName, dcId: form.value.dcId,
      advertiserId: form.value.advertiserId, elementFingerprint: form.value.elementFingerprint,
      handler: form.value.handler, ccUsers: form.value.ccUsers, parentTicketId: form.value.parentTicketId,
      createdAt: localTimeStr,
    })
    resetForm()
    _bypassAbort = true
    ticketFlow.consumeOrigin()
    // 提交成功后删除对应草稿（若有）
    if (currentDraftId.value) {
      ticketApi.deleteDraft(currentDraftId.value).catch(() => {})
      drafts.value = drafts.value.filter(x => x.id !== currentDraftId.value)
      currentDraftId.value = ''
    }
    newOpen.value = false
    await loadTickets()
    toast.success(`工单 ${created?.id || ''} 已提交，进入公共池并推送处理人群组`)
  } catch (e) {
    toast.error(e.message || '提交工单失败')
  } finally {
    submitting.value = false
  }
}

// ===== 工单草稿：提需中断保留现场，草稿箱恢复 =====
const drafts = ref([])
const draftsOpen = ref(false)
const savingDraft = ref(false)
const currentDraftId = ref('') // 正在编辑的草稿 id（打开草稿时为原 id，新建暂存为新 id）
const draftSummaryText = computed(() => {
  const parts = []
  if (form.value.title) parts.push(form.value.title)
  else if (form.value.tag) parts.push(`${form.value.tagId ? form.value.tagId + '-' : ''}${form.value.tag}`)
  const n = form.value.samples.length + form.value.clusters.reduce((a, c) => a + (c.elements || []).length, 0)
  if (n) parts.push(`已关联 ${n} 个素材`)
  return parts.join(' · ') || '未填写内容'
})
// 草稿自动保存（防抖）：仅在提需弹窗打开且非提交态时，序列化当前表单
let _draftTimer = null
function scheduleAutoSaveDraft() {
  if (!newOpen.value || submitting.value) return
  if (_draftTimer) clearTimeout(_draftTimer)
  _draftTimer = setTimeout(saveDraftNow, 1200)
}
async function saveDraftNow() {
  if (!newOpen.value || submitting.value) return
  if (!form.value.samples.length && !form.value.title && !form.value.desc && !form.value.tag) {
    // 无实质内容则不落草稿，避免脏草稿
    return
  }
  savingDraft.value = true
  try {
    const draftId = currentDraftId.value || `DR-${Date.now()}-${Math.floor(Math.random() * 1e4)}`
    const payload = {
      title: form.value.title,
      tagId: form.value.tagId,
      tag: form.value.tag,
      tagDetail: form.value.tagDetail,
      elementType: form.value.elementType,
      industryL1: form.value.industryL1,
      industryL2: form.value.industryL2,
      reviewerName: form.value.reviewerName,
      dcId: form.value.dcId,
      advertiserId: form.value.advertiserId,
      elementFingerprint: form.value.elementFingerprint,
      desc: form.value.desc,
      urgency: form.value.urgency,
      category: form.value.category,
      categoryOther: form.value.categoryOther,
      samples: form.value.samples,
      clusters: form.value.clusters,
      notifyUsers: form.value.notifyUsers,
      ccUsers: form.value.ccUsers,
      handler: form.value.handler,
      parentTicketId: form.value.parentTicketId,
      tagContext: tagContextSnapshot(),
    }
    const res = await ticketApi.saveDraft({ id: draftId, step: step.value, summary: draftSummaryText.value, payload })
    if (res?.id) currentDraftId.value = res.id
  } catch (e) {
    // 草稿保存失败静默处理，不阻断提需主流程
    console.warn('[draft] 自动保存失败:', e.message)
  } finally {
    savingDraft.value = false
  }
}
// 是否携带标签上下文（用于恢复时自动带出字段）
function tagContextSnapshot() {
  if (form.value.tagId || form.value.tag || form.value.elementType || form.value.industryL1 || form.value.industryL2) {
    return {
      tagId: form.value.tagId, tag: form.value.tag,
      elementType: form.value.elementType, industryL1: form.value.industryL1, industryL2: form.value.industryL2,
    }
  }
  return null
}
async function loadDrafts() {
  try {
    const list = await ticketApi.listDrafts()
    drafts.value = Array.isArray(list) ? list : []
  } catch (e) {
    drafts.value = []
  }
}
// 打开草稿箱（仅提需人视角且有提交权限时展示入口）
const canShowDrafts = computed(() => canSubmitter.value && persp.value === 'submitter')
async function openDrafts() {
  await loadDrafts()
  draftsOpen.value = true
}
// 点击草稿：恢复到中断离开时的步骤
async function resumeDraft(d) {
  try {
    const res = await ticketApi.getDraft(d.id)
    const p = res.payload || {}
    form.value = Object.assign(genForm(), {
      title: p.title || '',
      tagId: p.tagId || '',
      tag: p.tag || '',
      tagDetail: p.tagDetail || '',
      elementType: p.elementType || '',
      industryL1: p.industryL1 || '',
      industryL2: p.industryL2 || '',
      reviewerName: p.reviewerName || '',
      dcId: p.dcId || '',
      advertiserId: p.advertiserId || '',
      elementFingerprint: p.elementFingerprint || '',
      desc: p.desc || '',
      urgency: p.urgency || 2,
      category: p.category || '',
      categoryOther: p.categoryOther || '',
      samples: Array.isArray(p.samples) ? p.samples : [],
      clusters: Array.isArray(p.clusters) ? p.clusters : [],
      notifyUsers: Array.isArray(p.notifyUsers) ? p.notifyUsers : [],
      ccUsers: Array.isArray(p.ccUsers) ? p.ccUsers : [],
      handler: p.handler || '',
      parentTicketId: p.parentTicketId || '',
    })
    lastAutoTitle.value = form.value.title || ''
    fieldsReady.value = !!(p.tag || p.tagId || p.elementType || p.industryL1 || p.industryL2)
    step.value = res.step === 2 ? 2 : 1
    currentDraftId.value = d.id
    draftsOpen.value = false
    newOpen.value = true
    toast.info(`已恢复草稿「${d.summary}」${step.value === 2 ? '（撰写问题）' : '（选中素材）'}`)
  } catch (e) {
    toast.error(e.message || '恢复草稿失败')
  }
}
// 删除草稿
async function deleteDraft(d) {
  try {
    await ticketApi.deleteDraft(d.id)
    drafts.value = drafts.value.filter(x => x.id !== d.id)
    if (currentDraftId.value === d.id) currentDraftId.value = ''
    toast.success('草稿已删除')
  } catch (e) {
    toast.error(e.message || '删除草稿失败')
  }
}
// 主动暂存草稿（按钮）
async function manualSaveDraft() {
  await saveDraftNow()
  if (currentDraftId.value) {
    await loadDrafts()
    toast.success('已暂存草稿，可随时从草稿箱恢复')
  }
}
// 表单/步骤变化自动暂存草稿（防抖）
watch(
  () => [form.value, step.value],
  () => { if (newOpen.value) scheduleAutoSaveDraft() },
  { deep: true }
)
// 处理人抢单 + 给结论
const handleOpen = ref(false)
const handleTicket = ref(null)
const imageInput = ref(null)
const handleForm = ref({ conclusion: '', images: [], needTag: null, remark: '', category: '', notifyUsers: [], notifyInput: '' })
const MAX_CONCLUSION_IMAGES = 10
const MAX_IMAGE_SIZE = 512 * 1024

// 逐条素材审核状态
const handleSampleIdx = ref(0) // 当前查看的素材索引
const sampleConclusions = ref({}) // { [sampleId]: string } 每条素材的专家结论
const sampleNeedTags = ref({}) // { [sampleId]: true|false|null } 每条素材的是否需要打标
const sampleRemarks = ref({}) // { [sampleId]: string } 每条素材的备注（预览弹窗可编辑，归拢到列表备注列）
async function claim(t) {
  if (!canHandler.value) { toast.warn('无处理人权限，无法抢单'); return }
  if (t.status !== 'submitted' || t.handler) { toast.warn(`工单已被 ${t.handler || '他人'} 受理，请刷新列表`); return }
  try {
    await ticketApi.accept(t.id)
    await loadTickets()
    toast.success(`已抢单 ${t.id}，开始 SLA 计时（普通 24h / 高优 8h）`)
  } catch (e) {
    toast.error(e.message || '抢单失败')
  }
}
function openHandle(t) {
  handleTicket.value = t
  handleForm.value = {
    conclusion: t.conclusion || '',
    images: Array.isArray(t.conclusionImages) ? [...t.conclusionImages] : [],
    needTag: t.needTag ?? null,
    remark: t.handleRemark || '',
    category: t.category || '',
    notifyUsers: t.submitter ? [t.submitter] : [],
    notifyInput: '',
  }
  // 初始化逐条素材审核状态
  handleSampleIdx.value = 0
  const samples = materialList(t)
  const initConclusions = {}
  const initNeedTags = {}
  const initRemarks = {}
  // 如果工单已有结论，尝试从中恢复逐条素材结论
  if (t.samplesData && Array.isArray(t.samplesData)) {
    for (const s of t.samplesData) {
      const sid = s.id || s.sampleId || ''
      if (!initConclusions[sid] && s._conclusion) initConclusions[sid] = s._conclusion
      if (initNeedTags[sid] === undefined && s._needTag !== undefined && s._needTag !== null) initNeedTags[sid] = s._needTag
      if (!initRemarks[sid] && (s.remark || s._remark)) initRemarks[sid] = s.remark || s._remark
    }
  }
  sampleConclusions.value = initConclusions
  sampleNeedTags.value = initNeedTags
  sampleRemarks.value = initRemarks
  handleOpen.value = true
  persistOverlay()
}
function pickConclusionImage() { imageInput.value && imageInput.value.click() }
const modalDragOver = ref(false)
function onModalDragOver(e) { e.preventDefault(); modalDragOver.value = true }
function onModalDragLeave(e) { e.preventDefault(); modalDragOver.value = false }
async function onModalDrop(e) {
  e.preventDefault()
  modalDragOver.value = false
  const files = Array.from(e.dataTransfer.files || [])
  if (!files.length) return
  for (const file of files) {
    if (!file.type.startsWith('image/')) { toast.warn(`仅支持图片：${file.name}`); continue }
    if (file.size > MAX_IMAGE_SIZE) { toast.warn(`${file.name} 超过 512KB，请压缩后上传`); continue }
    if (handleForm.value.images.length >= MAX_CONCLUSION_IMAGES) { toast.warn(`最多添加 ${MAX_CONCLUSION_IMAGES} 张图片`); break }
    handleForm.value.images.push(await readImageFile(file))
  }
}
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, url: reader.result })
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
async function onConclusionImages(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  for (const file of files) {
    if (!file.type.startsWith('image/')) { toast.warn(`仅支持图片：${file.name}`); continue }
    if (file.size > MAX_IMAGE_SIZE) { toast.warn(`${file.name} 超过 512KB，请压缩后上传`); continue }
    if (handleForm.value.images.length >= MAX_CONCLUSION_IMAGES) { toast.warn(`最多添加 ${MAX_CONCLUSION_IMAGES} 张图片`); break }
    handleForm.value.images.push(await readImageFile(file))
  }
}
function removeConclusionImage(i) { handleForm.value.images.splice(i, 1) }
const MAX_MATERIAL_PREVIEW = 8

// 视频扩展名列表
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
// 图片扩展名列表（避免 ads_svp_video__xxx.jpeg 被误判为视频）
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']

// 通过 URL 后缀判断是否为视频（兜底逻辑，当 isVideo 字段缺失时使用）
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

// 已关联素材：优先使用工单提交时存储的真实素材数据；若无则按 sampleCount 展示占位
function materialList(t) {
  // 解析聚类簇数据（可能为 JSON 字符串或已解析数组），提取簇内全部 case 置前
  let clusterEls = []
  const rawClusters = t?.clustersData
  let clusters = []
  try { clusters = typeof rawClusters === 'string' ? JSON.parse(rawClusters || '[]') : (Array.isArray(rawClusters) ? rawClusters : []) } catch { clusters = [] }
  for (const cl of clusters) {
    for (const s of (cl.elements || [])) clusterEls.push(Object.assign({}, s, { _clusterId: cl.classId, _clusterFeature: cl.feature || '' }))
  }
  if ((clusterEls.length || (t?.samplesData && t.samplesData.length))) {
    const norm = (arr) => (arr || []).map(s => {
      const machineTags = (s.policyIds || s.machineTag || '').replace(/^\[|\]$/g, '')
      const humanTags = (s.aiEvaluatePolicyIds || s.humanTag || '').replace(/^\[|\]$/g, '')
      // 素材状态判定
      let matStatus = 'pending' // 待处理
      if (machineTags && humanTags) matStatus = 'consistent' // 机审人审一致
      else if (machineTags && !humanTags) matStatus = 'fp' // 仅机审（误杀）
      else if (!machineTags && humanTags) matStatus = 'revised' // 人审修正
      if (s.remark || s._remark) matStatus = 'remarked'
      return {
        id: s.id || '', type: s.type || '图片', vid: !!s.isVideo || isVideoByUrl(s.mediaUrl),
        mediaUrl: s.mediaUrl || '',
        ocr: s.ocr || s.ocr_text || '', asr: s.asr || s.asr_text || '',
        elementFingerprint: s.elementFingerprint || s.element_fingerprint || '',
        arriveTime: s.arriveTime || s.arrive_time || '',
        dcId: s.dcId || s.dc_id || '',
        policyIds: machineTags,
        aiEvaluatePolicyIds: humanTags,
        reviewerName: s.reviewerName || s.aiEvaluateReviewerName || s.ai_evaluate_reviewer_name || '',
        advertiserId: s.advertiserId || s.uid || '',
        // Phase 4 新增字段
        uidName: s.uidName || s.uid_name || '',
        elementType: s.elementType || s.element_type || '',
        elementTypeName: s.elementTypeName || s.element_type_name || '',
        opsAdvertiserName: s.opsAdvertiserName || s.ops_advertiser_name || '',
        agencyUid: s.agencyUid || s.agency_uid || '',
        agencyName: s.agencyName || s.agency_name || '',
        modelVersion: s.modelVersion || s.model_version || '',
        ds: s.ds || '',
        classNum: s.classNum || s.class_num || '',
        classId: s.classId || s.class_id || (s._clusterId || ''),
        industryL1: s.industryL1 || s.first_level_industry_name || '',
        industryL2: s.industryL2 || s.second_level_industry_name || '',
        needTag: s.needTag !== undefined && s.needTag !== null ? s.needTag : (s._needTag !== undefined && s._needTag !== null ? s._needTag : null),
        remark: s.remark || s._remark || '',
        clusterId: s._clusterId || '', clusterFeature: s._clusterFeature || '',
        // 状态
        matStatus,
      }
    })
    // 簇内 case 在前，零散素材（已关联但未成簇）置于末尾
    return norm(clusterEls).concat(norm(t?.samplesData))
  }
  const n = Math.max(0, Number(t?.sampleCount || 0))
  const base = t?.tagId || t?.id || 'MAT'
  return Array.from({ length: n }, (_, i) => {
    const vid = t?.elementType === '视频' ? i % 3 !== 0 : i % 3 === 1
    return { id: `${base}-${i}`, type: vid ? '视频' : '图片', vid, mediaUrl: '', ocr: '', asr: '', matStatus: 'pending' }
  })
}
// 素材表格展开控制
const mExpanded = ref({}) // { [ticketId]: true|false }
function toggleExpandMat(ticketId) {
  mExpanded.value[ticketId] = !mExpanded.value[ticketId]
  mExpanded.value = { ...mExpanded.value }
}
function visibleMaterials(t) {
  const all = materialList(t)
  if (mExpanded.value[t.id]) return all
  return all.slice(0, 3)
}
function hasMoreMat(t) {
  return materialList(t).length > 3
}
function addHandleNotifyUser() {
  const v = (handleForm.value.notifyInput || '').trim()
  if (!v) return
  if (handleForm.value.notifyUsers.includes(v)) { toast.warn('该通知对象已添加'); handleForm.value.notifyInput = ''; return }
  handleForm.value.notifyUsers.push(v)
  handleForm.value.notifyInput = ''
}

// ===== 通知对象搜索联想 =====
const notifySuggests = ref([]) // 搜索联想候选列表
const notifySuggestOpen = ref(false) // 新建工单联想下拉
const handleSuggestOpen = ref(false) // 处理工单联想下拉
let suggestTimer = null
async function fetchNotifySuggests(kw) {
  try {
    const list = await ticketApi.notifySuggests(kw)
    notifySuggests.value = Array.isArray(list) ? list : []
  } catch { notifySuggests.value = [] }
}
function onNotifyInputChange(val, which) {
  clearTimeout(suggestTimer)
  const kw = (val || '').trim()
  if (!kw) { notifySuggests.value = []; if (which === 'new') notifySuggestOpen.value = false; else handleSuggestOpen.value = false; return }
  suggestTimer = setTimeout(async () => {
    await fetchNotifySuggests(kw)
    if (which === 'new') notifySuggestOpen.value = notifySuggests.value.length > 0
    else handleSuggestOpen.value = notifySuggests.value.length > 0
  }, 250)
}
function selectNotifySuggest(name, which) {
  if (which === 'new') {
    if (!form.value.notifyUsers.includes(name)) form.value.notifyUsers.push(name)
    form.value.notifyInput = ''
    notifySuggestOpen.value = false
  } else {
    if (!handleForm.value.notifyUsers.includes(name)) handleForm.value.notifyUsers.push(name)
    handleForm.value.notifyInput = ''
    handleSuggestOpen.value = false
  }
  notifySuggests.value = []
}
// 延迟关闭建议下拉，避免点击建议项前就关闭
function blurNotifySuggest(which) {
  window.setTimeout(() => { if (which === 'new') notifySuggestOpen.value = false; else handleSuggestOpen.value = false }, 180)
}

// ===== 指派处理人 / 抄送知会 =====
const handlerSuggestOpen = ref(false)
const ccSuggestOpen = ref(false)
function addHandler() {
  const v = (form.value.handlerInput || '').trim()
  if (!v) return
  form.value.handler = v
  form.value.handlerInput = ''
  handlerSuggestOpen.value = false
  notifySuggests.value = []
}
function addCcUser() {
  const v = (form.value.ccInput || '').trim()
  if (!v) return
  if (form.value.ccUsers.includes(v)) { toast.warn('该抄送对象已添加'); form.value.ccInput = ''; return }
  form.value.ccUsers.push(v)
  form.value.ccInput = ''
}
function onAssignInputChange(val, which) {
  clearTimeout(suggestTimer)
  const kw = (val || '').trim()
  if (!kw) { notifySuggests.value = []; if (which === 'handler') handlerSuggestOpen.value = false; else ccSuggestOpen.value = false; return }
  suggestTimer = setTimeout(async () => {
    await fetchNotifySuggests(kw)
    if (which === 'handler') handlerSuggestOpen.value = notifySuggests.value.length > 0
    else ccSuggestOpen.value = notifySuggests.value.length > 0
  }, 250)
}
function selectAssignSuggest(name, which) {
  if (which === 'handler') {
    form.value.handler = name
    form.value.handlerInput = ''
    handlerSuggestOpen.value = false
  } else {
    if (!form.value.ccUsers.includes(name)) form.value.ccUsers.push(name)
    form.value.ccInput = ''
    ccSuggestOpen.value = false
  }
  notifySuggests.value = []
}
function blurAssignSuggest(which) {
  window.setTimeout(() => { if (which === 'handler') handlerSuggestOpen.value = false; else ccSuggestOpen.value = false }, 180)
}

// ===== 嵌套依据工单搜索选择器（支持搜索全部工单） =====
const parentTicketInput = ref('')
const parentTicketLabel = ref('')
const parentTicketResults = ref([])
const parentTicketOpen = ref(false)
let parentTicketTimer = null
function onParentTicketInput() {
  clearTimeout(parentTicketTimer)
  const kw = parentTicketInput.value.trim()
  if (!kw) { parentTicketResults.value = []; parentTicketOpen.value = false; return }
  parentTicketTimer = setTimeout(async () => {
    try {
      const list = await ticketApi.search(kw)
      parentTicketResults.value = Array.isArray(list) ? list : []
      parentTicketOpen.value = parentTicketResults.value.length > 0
    } catch { parentTicketResults.value = []; parentTicketOpen.value = false }
  }, 250)
}
function selectParentTicket(t) {
  form.value.parentTicketId = t.id
  parentTicketLabel.value = `${t.id} · ${t.title}`
  parentTicketInput.value = ''
  parentTicketResults.value = []
  parentTicketOpen.value = false
}
function clearParentTicket() {
  form.value.parentTicketId = ''
  parentTicketLabel.value = ''
  parentTicketInput.value = ''
  parentTicketResults.value = []
  parentTicketOpen.value = false
}
function blurParentTicket() {
  window.setTimeout(() => { parentTicketOpen.value = false }, 180)
}

// ===== 工单相似样本库 =====
const similarLibraryVisible = ref(false)
const similarLibraryTicket = ref(null)
function openSimilarLibrary(t) {
  similarLibraryTicket.value = t
  similarLibraryVisible.value = true
}
// 相似样本库「发起问题提需」：带入勾选样本 + 工单上下文 + 嵌套依据工单（当前工单）
function onCreateTicketFromSimilar(payload) {
  form.value = genForm()
  form.value.samples = Array.isArray(payload?.samples) ? payload.samples : []
  form.value.tagId = payload?.tagId || ''
  form.value.tag = payload?.tag || ''
  form.value.elementType = payload?.elementType || ''
  form.value.industryL1 = payload?.industryL1 || ''
  form.value.industryL2 = payload?.industryL2 || ''
  if (payload?.parentTicketId) {
    form.value.parentTicketId = payload.parentTicketId
    parentTicketLabel.value = `${payload.parentTicketId} · ${similarLibraryTicket.value?.title || ''}`
  }
  fieldsReady.value = true
  step.value = 1
  // 必须清空草稿 ID：否则会自动保存覆盖上一条草稿，多个草稿被合并成一条
  currentDraftId.value = ''
  newOpen.value = true
  toast.info(`已带入 ${form.value.samples.length} 条相似样本，请继续填写工单信息`)
}
// 自动汇总逐条素材结论到专家结论
function autoFillConclusion() {
  const t = handleTicket.value
  if (!t) return
  const samples = materialList(t)
  const parts = []
  for (let i = 0; i < samples.length; i++) {
    const m = samples[i]
    const sid = m.id || ''
    const cText = sampleConclusions.value[sid] || ''
    if (cText.trim()) {
      parts.push(`素材${i + 1}（${sid}）——${cText.trim()}`)
    }
  }
  if (!parts.length) { toast.warn('尚未填写任何素材的结论，无法汇总'); return }
  handleForm.value.conclusion = parts.join('\n')
  // 同时从逐条打标推导工单级打标
  if (handleForm.value.needTag === null) {
    const anyNeed = Object.values(sampleNeedTags.value).some(v => v === true)
    const anyNoNeed = Object.values(sampleNeedTags.value).some(v => v === false)
    if (anyNeed) handleForm.value.needTag = true
    else if (anyNoNeed && !anyNeed) handleForm.value.needTag = false
  }
  toast.success(`已汇总 ${parts.length} 条素材结论`)
}

async function submitConclusion() {
  // 自动汇总：逐条素材结论文本 → 专家结论
  const t = handleTicket.value
  const samples = materialList(t)
  const parts = []
  for (let i = 0; i < samples.length; i++) {
    const m = samples[i]
    const sid = m.id || ''
    const cText = sampleConclusions.value[sid] || ''
    if (cText.trim()) {
      parts.push(`${m.type || '素材'}${samples.length > 1 ? (i + 1) : ''}（${sid}）——${cText.trim()}`)
    }
  }
  // 如果逐条结论有内容且工单结论为空，自动填入
  if (parts.length && !handleForm.value.conclusion.trim()) {
    handleForm.value.conclusion = parts.join('\n')
  } else if (parts.length && handleForm.value.conclusion.trim()) {
    // 如果已有结论，追加逐条结论
    // 不覆盖，让用户自己决定
  }
  // 从逐条打标自动推导工单级打标
  if (handleForm.value.needTag === null && Object.values(sampleNeedTags.value).some(v => v !== null && v !== undefined)) {
    const anyNeed = Object.values(sampleNeedTags.value).some(v => v === true)
    handleForm.value.needTag = anyNeed
  }
  if (!handleForm.value.conclusion.trim()) { toast.warn('请填写解答结论'); return }
  if (handleForm.value.needTag === null) { toast.warn('请选择是否打标'); return }
  if (!auth.isAdmin && t.handler && t.handler !== auth.user.name) { toast.warn('该工单由其他处理人受理，你无权提交结论'); return }
  const newCat = handleForm.value.category || ''
  const oldCat = t.category || ''
  const categoryChanged = String(newCat) !== String(oldCat)
  const categoryChangeNote = categoryChanged
    ? `处理人修改问题分类：原「${catLabel(oldCat)}」→ 现「${catLabel(newCat)}」`
    : ''
  try {
    await ticketApi.conclude(t.id, {
      conclusion: handleForm.value.conclusion,
      conclusionImages: handleForm.value.images,
      handleRemark: handleForm.value.remark,
      handleReason: '',
      needTag: handleForm.value.needTag,
      category: newCat,
      categoryChangeNote,
      notifyUsers: handleForm.value.notifyUsers,
    })
    handleOpen.value = false
    await loadTickets()
    toast.success('结论已提交，已通知提需人确认')
  } catch (e) {
    toast.error(e.message || '提交结论失败')
  }
}

// ===== 专家结论区域内联编辑 =====
// 权限：处理人或管理员，工单状态为 accepted/rejected
const inlineEditing = ref(null) // 正在编辑的工单 id
const inlineForm = ref({ conclusion: '', images: [], needTag: null, remark: '', category: '' })
const inlineImageInput = ref(null)
const dragOver = ref(false)

function canInlineEdit(t) {
  if (!canHandler.value) return false
  if (t.status !== 'accepted' && t.status !== 'rejected') return false
  if (!auth.isAdmin && t.handler && t.handler !== auth.user.name) return false
  return true
}

function startInlineEdit(t) {
  inlineEditing.value = t.id
  inlineForm.value = {
    conclusion: t.conclusion || '',
    images: Array.isArray(t.conclusionImages) ? [...t.conclusionImages] : [],
    needTag: t.needTag ?? null,
    remark: t.handleRemark || '',
    category: t.category || '',
  }
}

function cancelInlineEdit() {
  inlineEditing.value = null
  inlineForm.value = { conclusion: '', images: [], needTag: null, remark: '', category: '' }
}

async function submitInlineConclusion(t) {
  if (!inlineForm.value.conclusion.trim()) { toast.warn('请填写解答结论'); return }
  if (inlineForm.value.needTag === null) { toast.warn('请选择是否打标'); return }
  const newCat = inlineForm.value.category || ''
  const oldCat = t.category || ''
  const categoryChanged = String(newCat) !== String(oldCat)
  const categoryChangeNote = categoryChanged
    ? `处理人修改问题分类：原「${catLabel(oldCat)}」→ 现「${catLabel(newCat)}」`
    : ''
  try {
    await ticketApi.conclude(t.id, {
      conclusion: inlineForm.value.conclusion,
      conclusionImages: inlineForm.value.images,
      handleRemark: inlineForm.value.remark,
      handleReason: '',
      needTag: inlineForm.value.needTag,
      category: newCat,
      categoryChangeNote,
    })
    inlineEditing.value = null
    await loadTickets()
    toast.success('结论已提交，已通知提需人确认')
  } catch (e) {
    toast.error(e.message || '提交结论失败')
  }
}

function pickInlineImage() { inlineImageInput.value && inlineImageInput.value.click() }

async function addInlineImageFiles(files) {
  if (!files || !files.length) return
  for (const file of files) {
    if (!file.type.startsWith('image/')) { toast.warn(`仅支持图片：${file.name}`); continue }
    if (file.size > MAX_IMAGE_SIZE) { toast.warn(`${file.name} 超过 512KB，请压缩后上传`); continue }
    if (inlineForm.value.images.length >= MAX_CONCLUSION_IMAGES) { toast.warn(`最多添加 ${MAX_CONCLUSION_IMAGES} 张图片`); break }
    inlineForm.value.images.push(await readImageFile(file))
  }
}

async function onInlineImages(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  await addInlineImageFiles(files)
}

function onInlineDragOver(e) { e.preventDefault(); dragOver.value = true }
function onInlineDragLeave(e) { e.preventDefault(); dragOver.value = false }
async function onInlineDrop(e) {
  e.preventDefault()
  dragOver.value = false
  const files = Array.from(e.dataTransfer.files || [])
  await addInlineImageFiles(files)
}

function removeInlineImage(i) { inlineForm.value.images.splice(i, 1) }

// 提需人采纳 / 退回（仅本工单提需人或管理员）
function canAdopt(t) { return auth.isAdmin || t.submitter === auth.user.name }
const adoptOpen = ref(false)
const adoptTicket = ref(null)
const adoptCat = ref('')
const adoptResultType = ref('')
function openAdopt(t) {
  if (!canAdopt(t)) { toast.warn('仅工单提需人本人或管理员可采纳'); return }
  adoptTicket.value = t; adoptCat.value = t.category || ''; adoptResultType.value = t.resultType || ''; adoptOpen.value = true
}
async function confirmAdopt() {
  if (!adoptCat.value) { toast.warn('采纳时必须确定问题分类'); return }
  if (!adoptResultType.value) { toast.warn('请选择结果类型（真实误杀 / 机审正确）'); return }
  const t = adoptTicket.value
  try {
    await ticketApi.adopt(t.id, {
      category: adoptCat.value,
      categoryNote: t.categoryNote || '',
      resultType: adoptResultType.value,
    })
    adoptOpen.value = false
    await loadTickets()
    toast.success('已采纳，归因结论连同问题分类已自动入库结论沉淀')
  } catch (e) {
    toast.error(e.message || '采纳失败')
  }
}
// 退回工单（调真实 API，退回原因弹窗）
const rejectOpen = ref(false)
const rejectTicket = ref(null)
const rejectReason = ref('')
function openReject(t) {
  if (!canAdopt(t)) { toast.warn('仅工单提需人本人或管理员可退回'); return }
  rejectTicket.value = t; rejectReason.value = ''; rejectOpen.value = true
}
async function confirmReject() {
  if (!rejectReason.value.trim()) { toast.warn('退回原因必填'); return }
  const t = rejectTicket.value
  try {
    await ticketApi.reject(t.id, { reason: rejectReason.value.trim() })
    rejectOpen.value = false
    await loadTickets()
    toast.info('已退回，工单回到原处理人继续处理')
  } catch (e) {
    toast.error(e.message || '退回失败')
  }
}
// 重开工单（done → concluded，提需人可重新修改结论后采纳入库）
async function reopen(t) {
  if (!canAdopt(t)) { toast.warn('仅工单提需人本人或管理员可重开'); return }
  try {
    await ticketApi.reopen(t.id)
    await loadTickets()
    toast.success('工单已重开，可修改结论后重新采纳入库')
  } catch (e) {
    toast.error(e.message || '重开失败')
  }
}
function exportWord(t) { toast.success(`工单 ${t.id} 归因结论已导出 Word（含问题分类）`) }
async function exportTicketExcel(t) {
  try {
    await ticketApi.exportExcel(t.id)
    toast.success(`工单 ${t.id} 数据已导出 Excel`)
  } catch (e) {
    toast.error(e.message || '导出失败')
  }
}
function catLabel(c) { return PROBLEM_CATEGORIES.find(x => x.code === c)?.label || '—' }

// 删除工单（仅管理员）
const deleteOpen = ref(false)
const deleteTicket = ref(null)
const deleting = ref(false)
function openDelete(t) { deleteTicket.value = t; deleteOpen.value = true }
async function confirmDelete() {
  const t = deleteTicket.value
  if (!t) return
  deleting.value = true
  try {
    await ticketApi.remove(t.id)
    deleteOpen.value = false
    if (expanded.value === t.id) expanded.value = null
    await loadTickets()
    toast.success(`工单 ${t.id} 已删除`)
  } catch (e) {
    toast.error(e.message || '删除失败')
  } finally {
    deleting.value = false
  }
}

// ===== 媒体预览弹窗（工单内视频/图片全屏预览，含倍速切换） =====
const SPEED_OPTIONS = [1, 1.5, 2, 3, 0.5]
const previewOpen = ref(false)
const previewMedia = ref(null) // { id, vid, mediaUrl, type }
const previewMaterials = ref([]) // 当前预览的素材列表，用于左右切换
const previewIndex = ref(-1) // 当前预览素材在列表中的索引
const previewVideoRef = ref(null)
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
// 判断 URL 是否为合法的 HTTP(S) URL（非纯文本、非相对路径）
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  return /^https?:\/\//i.test(url)
}
// 草稿更新时间格式化（相对时间）
function formatDraftTime(t) {
  if (!t) return ''
  const d = new Date(t.replace(' ', 'T'))
  if (isNaN(d.getTime())) return String(t)
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 判断 URL 是否为真正的媒体文件（图片/视频），非媒体 URL（如 HTML 落地页）不应作为 src 加载
// 统一复用公共层 isMediaUrl（覆盖无扩展名的社交广告 CDN 如 gtiimg.com/snscosdow）
const videoSpeedMap = ref({}) // 每个视频独立的倍速记录 { [mediaUrl]: speed }
// 当前预览视频的倍速（从 map 读取，默认 1）
const previewSpeed = computed(() => {
  if (!previewMedia.value || !previewMedia.value.vid || !previewMedia.value.mediaUrl) return 1
  return videoSpeedMap.value[previewMedia.value.mediaUrl] ?? 1
})
function openPreview(m, list) {
  if (!m) return
  // 凡是素材都应该可以预览：有 mediaUrl 展示媒体，有 ocr/asr 展示文本，纯文本素材展示文本
  previewMedia.value = m
  persistOverlay()
  // 记录素材列表和当前索引，用于左右切换
  if (Array.isArray(list) && list.length) {
    previewMaterials.value = list
    previewIndex.value = list.findIndex(item => (item.id || '') === (m.id || '') && (item.mediaUrl || '') === (m.mediaUrl || ''))
    if (previewIndex.value < 0) previewIndex.value = 0
  } else {
    previewMaterials.value = [m]
    previewIndex.value = 0
  }
  // 使用该视频上次记录的倍速（默认 1），不重置
  const savedSpeed = isVideoByUrl(m.mediaUrl) ? (videoSpeedMap.value[m.mediaUrl] ?? 1) : 1
  previewOpen.value = true
  nextTick(() => {
    if (previewVideoRef.value) {
      previewVideoRef.value.playbackRate = savedSpeed
    }
  })
}
// ===== 预览弹窗：逐条素材标注（是否打标 + 备注）=====
// 优先级：本地编辑值(sampleNeedTags/sampleRemarks) > 素材自带值(needTag/remark)
const previewNeedTag = computed(() => {
  const m = previewMedia.value
  if (!m || !m.id) return null
  const local = sampleNeedTags.value[m.id]
  if (local === true || local === false) return local
  return (m.needTag === true || m.needTag === false) ? m.needTag : null
})
const previewRemark = computed(() => {
  const m = previewMedia.value
  if (!m || !m.id) return ''
  const local = sampleRemarks.value[m.id]
  if (local !== undefined && local !== null && local !== '') return local
  return m.remark || ''
})
// ===== 详情列表：逐条素材标注（是否打标 + 备注）行内编辑 =====
// 统一取值优先级：本地编辑值 > 素材自带值，保证预览弹窗标注后能归拢显示到列表
function rowNeedTag(m) {
  if (!m || !m.id) return null
  const local = sampleNeedTags.value[m.id]
  if (local === true || local === false) return local
  return (m.needTag === true || m.needTag === false) ? m.needTag : null
}
function rowRemark(m) {
  if (!m || !m.id) return ''
  const local = sampleRemarks.value[m.id]
  if (local !== undefined && local !== null && local !== '') return local
  return m.remark || ''
}
function setRowNeedTag(m, v) {
  if (!m || !m.id) return
  sampleNeedTags.value = { ...sampleNeedTags.value, [m.id]: v }
}
function setRowRemark(m, v) {
  if (!m || !m.id) return
  sampleRemarks.value = { ...sampleRemarks.value, [m.id]: v }
}
function setPreviewNeedTag(v) {
  const m = previewMedia.value
  if (!m || !m.id) return
  sampleNeedTags.value = { ...sampleNeedTags.value, [m.id]: v }
}
function setPreviewRemark(v) {
  const m = previewMedia.value
  if (!m || !m.id) return
  sampleRemarks.value = { ...sampleRemarks.value, [m.id]: v }
}
function closePreview() {
  if (previewVideoRef.value) previewVideoRef.value.pause()
  previewOpen.value = false
  previewMedia.value = null
  previewMaterials.value = []
  previewIndex.value = -1
  clearOverlay()
}
function prevPreview() {
  if (previewMaterials.value.length <= 1) return
  const newIdx = (previewIndex.value - 1 + previewMaterials.value.length) % previewMaterials.value.length
  const m = previewMaterials.value[newIdx]
  // 保存当前视频倍速
  if (previewVideoRef.value && previewMedia.value?.mediaUrl) {
    videoSpeedMap.value[previewMedia.value.mediaUrl] = previewVideoRef.value.playbackRate
  }
  previewIndex.value = newIdx
  previewMedia.value = m
  nextTick(() => {
    if (previewVideoRef.value) {
      previewVideoRef.value.playbackRate = m.vid ? (videoSpeedMap.value[m.mediaUrl] ?? 1) : 1
    }
  })
}
function nextPreview() {
  if (previewMaterials.value.length <= 1) return
  const newIdx = (previewIndex.value + 1) % previewMaterials.value.length
  const m = previewMaterials.value[newIdx]
  // 保存当前视频倍速
  if (previewVideoRef.value && previewMedia.value?.mediaUrl) {
    videoSpeedMap.value[previewMedia.value.mediaUrl] = previewVideoRef.value.playbackRate
  }
  previewIndex.value = newIdx
  previewMedia.value = m
  nextTick(() => {
    if (previewVideoRef.value) {
      previewVideoRef.value.playbackRate = m.vid ? (videoSpeedMap.value[m.mediaUrl] ?? 1) : 1
    }
  })
}
function onPreviewKeydown(e) {
  if (!previewOpen.value) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); prevPreview() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nextPreview() }
  else if (e.key === 'Escape') { e.preventDefault(); closePreview() }
}
function cyclePreviewSpeed() {
  const cur = previewSpeed.value
  const idx = SPEED_OPTIONS.indexOf(cur)
  const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
  // 保存到当前视频的倍速记录
  if (previewMedia.value && previewMedia.value.mediaUrl) {
    videoSpeedMap.value[previewMedia.value.mediaUrl] = next
  }
  if (previewVideoRef.value) previewVideoRef.value.playbackRate = next
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <div>
        <h1 class="page-title"><Icon name="ticket" :size="22" />问题提需</h1>
        <p class="page-sub">工单流转 · 指派处理 · 结论采纳与问题分类</p>
      </div>
      <div class="ph-act">
        <div class="persp" v-if="canSubmitter && canHandler">
          <button :class="{ on: persp==='submitter' }" @click="switchPersp('submitter')">
            提需人视角<i v-if="hasWait && persp!=='submitter'" class="rdot"></i>
          </button>
          <button :class="{ on: persp==='handler' }" @click="switchPersp('handler')">处理人视角</button>
        </div>
        <button v-if="canSubmitter && persp==='submitter'" class="btn btn-primary btn-sm" @click="openNew"><Icon name="plus" :size="15" />新建提需</button>
      </div>
    </div>

    <!-- 状态 tab + 搜索 -->
    <div class="card list-card rise">
      <div class="lc-bar">
        <div class="seg-tabs">
          <template v-for="(t, i) in curTabs" :key="t.v">
            <button :class="{ on: tab===t.v }" @click="tab=t.v; persp==='handler' && backToGroups()">
              {{ t.t }}<b>{{ tabCount(t.v) }}</b>
              <i v-if="t.v==='wait' && persp==='submitter' && tabCount('wait')" class="rdot"></i>
            </button>
            <button v-if="i===0 && canShowDrafts" class="dft-tab-btn" @click="openDrafts"><Icon name="doc" :size="15" />草稿箱<b class="dft-cnt">{{ drafts.length }}</b></button>
          </template>
        </div>
        <div class="search">
          <Icon name="search" :size="16" /><input v-model="kw" placeholder="搜索工单标题…" />
        </div>
      </div>

      <!-- 工单列表（处理人分组浏览 / 工单列表） -->
      <template v-if="persp==='handler' && !activeGroupInfo">
        <div v-if="industryGroups.length" class="ind-grid">
          <button v-for="g in industryGroups" :key="g.key" class="ind-card" @click="openGroup(g.key)">
            <div class="ind-top">
              <span class="ind-ic"><Icon name="ticket" :size="20" /></span>
              <div class="ind-name">
                <strong>{{ g.l1 }}</strong>
                <em>{{ g.l2 }}</em>
              </div>
              <span class="ind-total">{{ g.items.length }}</span>
            </div>
            <div class="ind-stats">
              <span class="ist pool" :class="{ dim: !g.pool }"><i></i>可抢单 {{ g.pool }}</span>
              <span class="ist doing" :class="{ dim: !g.doing }"><i></i>处理中 {{ g.doing }}</span>
              <span class="ist closed" :class="{ dim: !g.closed }"><i></i>已结束 {{ g.closed }}</span>
            </div>
            <span class="ind-arrow"><Icon name="chevronRight" :size="16" /></span>
          </button>
        </div>
        <EmptyState v-else icon="ticket" title="暂无工单" desc="当前筛选条件下没有可处理的行业分组" />
      </template>
      <template v-else>
        <div v-if="persp==='handler' && activeGroupInfo" class="group-bar">
          <button class="gb-back" @click="backToGroups"><Icon name="chevronLeft" :size="16" />返回行业分组</button>
          <span class="gb-cur"><b>{{ activeGroupInfo.l1 }}</b><i>/</i>{{ activeGroupInfo.l2 }}</span>
          <span class="gb-count">{{ activeGroupInfo.items.length }} 个工单</span>
        </div>
        <div v-if="visibleTickets.length" class="tk-list">
          <div v-for="t in visibleTickets" :key="t.id" class="tk-item" :data-ticket-id="t.id">
            <div class="tk-head" @click="toggleRow(t.id)">
              <span class="tk-id">{{ t.id }}</span>
              <div class="tk-main">
                <div class="tk-title">{{ t.title }}</div>
                <div class="tk-meta">
                  <span class="badge badge-blue">{{ t.tag }}</span>
                  <span>{{ t.elementType }}</span><i>·</i>
                  <span>{{ t.industryL1 }}/{{ t.industryL2 }}</span><i>·</i>
                  <span>{{ t.sampleCount }} 条素材</span>
                </div>
              </div>
              <span class="badge" :class="`badge-${URGENCY[t.urgency]?.c || 'gray'}`">{{ URGENCY[t.urgency]?.t || '中' }}优</span>
              <span class="badge" :class="statusCls(t.status)">{{ statusText(t.status) }}</span>
              <span class="tk-time">{{ t.createdAt }}</span>
              <!-- 操作 -->
              <div class="tk-ops" @click.stop>
                <button class="btn btn-soft btn-sm" @click="exportTicketExcel(t)"><Icon name="download" :size="14" />下载</button>
                <template v-if="persp==='handler'">
                  <button v-if="t.status==='submitted'" class="btn btn-primary btn-sm" @click="claim(t)"><Icon name="check" :size="14" />抢单</button>
                  <button v-else-if="t.status==='accepted'||t.status==='rejected'" class="btn btn-soft btn-sm" @click="openHandle(t)"><Icon name="doc" :size="14" />填写结论</button>
                </template>
                <template v-else>
                  <template v-if="t.status==='submitted'">
                  </template>
                  <template v-else-if="t.status==='concluded'">
                    <button class="btn btn-primary btn-sm" @click="openAdopt(t)"><Icon name="check" :size="14" />采纳</button>
                    <button class="btn btn-ghost btn-sm" @click="openReject(t)">退回</button>
                  </template>
                  <template v-else-if="t.status==='done'">
                    <button class="btn btn-soft btn-sm" @click="reopen(t)"><Icon name="refresh" :size="14" />重开</button>
                  </template>
                </template>
                <button v-if="auth.isAdmin" class="btn btn-danger-outline btn-sm" @click="openDelete(t)"><Icon name="trash" :size="14" />删除</button>
              </div>
              <Icon name="chevronDown" :size="16" class="tk-arrow" :class="{ open: expanded===t.id }" />
            </div>

            <!-- 展开：时间线 + 内容 + 结论 -->
            <transition name="fade">
              <div v-if="expanded===t.id" class="tk-detail">
                <!-- 标签头部 -->
                <div class="td-tags">
                  <span class="badge badge-blue">{{ t.tagId || '—' }}-{{ t.tag || '未命名标签' }}</span>
                  <span v-if="t.status==='done' && t.resultType" class="badge" :class="t.resultType==='real_fp' ? 'badge-red' : 'badge-green'">
                    {{ t.resultType==='real_fp' ? '真实误杀' : '机审正确' }}
                  </span>
                  <span v-if="t.category" class="badge badge-purple">{{ catLabel(t.category) }}</span>
                  <span class="badge badge-gray">{{ t.industryL1 || '未分类' }}</span>
                </div>

                <!-- 1 基础信息（原处理信息） -->
                <div class="td-sec">
                  <h4><i class="n">1</i>基础信息</h4>
                  <div class="td-info">
                    <div><span>标签 ID - 标签名</span><b>{{ t.tagId || '—' }} - {{ t.tag || '未命名' }}</b></div>
                    <div><span>问题分类</span><b>{{ t.category ? catLabel(t.category) : '待确定' }}</b></div>
                    <div><span>结果类型</span><b>{{ t.status==='done' && t.resultType ? (t.resultType==='real_fp' ? '真实误杀' : '机审正确') : '待采纳确认' }}</b></div>
                    <div><span>行业</span><b>{{ t.industryL1 || '未分类' }}/{{ t.industryL2 || '其他' }}</b></div>
                    <div><span>提需人</span><b>{{ t.submitter || '—' }}</b></div>
                    <div><span>处理人</span><b>{{ t.handler || '未分配' }}</b></div>
                    <div v-if="t.ccUsers && t.ccUsers.length"><span>抄送知会</span><b>{{ t.ccUsers.join('、') }}</b></div>
                    <div v-if="t.parentTicketId"><span>嵌套依据工单</span><b class="mono">{{ t.parentTicketId }}</b></div>
                    <div v-if="t.notifyUsers && t.notifyUsers.length"><span>通知对象</span><b>{{ t.notifyUsers.join('、') }}</b></div>
                    <div><span>紧急程度</span><b :class="`urg-txt-${URGENCY[t.urgency]?.c || 'gray'}`">{{ URGENCY[t.urgency]?.t || '中' }}优先级</b></div>
                    <div><span>创建时间</span><b class="mono">{{ t.createdAt }}</b></div>
                    <div v-if="t.dcId"><span>创意ID(DCID)</span><b class="mono">{{ t.dcId }}</b></div>
                    <div v-if="t.elementFingerprint"><span>审核物理指纹(md5)</span><b class="mono" style="font-size:12px">{{ t.elementFingerprint }}</b></div>
                    <div v-if="t.aiEvaluateReviewerName"><span>审核人</span><b>{{ t.aiEvaluateReviewerName }}</b></div>
                  </div>
                </div>

                <!-- 2 问题描述 + 已关联素材 -->
                <div class="td-sec">
                  <h4><i class="n">2</i>问题描述</h4>
                  <p class="td-desc">{{ t.desc || '暂无描述' }}</p>
                  <div class="td-materials" v-if="t.sampleCount && materialList(t).length">
                    <div class="td-mat-head"><Icon name="image" :size="13" />已关联素材（{{ materialList(t).length }}）</div>
                    <div class="td-mat-table-wrap">
                      <table class="td-mat-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th class="sticky-col">元素</th>
                            <th>创意ID</th>
                            <th>广告主</th>
                            <th>客户主体</th>
                            <th>机审标签</th>
                            <th>人审标签</th>
                            <th>OCR</th>
                            <th>ASR</th>
                            <th>审核员</th>
                            <th>DCID</th>
                            <th>广告主ID</th>
                            <th>审核物理指纹</th>
                            <th>是否打标</th>
                            <th>备注</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(m, idx) in visibleMaterials(t)" :key="m.id" :class="'mat-row-' + m.matStatus">
                            <td class="col-idx">{{ idx + 1 }}</td>
                            <td class="sticky-col col-element" @click="openPreview(m, materialList(t))">
                              <div class="ce-thumb">
                                <video v-if="isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" v-lazy-video :data-src="m.mediaUrl" controls playsinline muted @error="onMediaErr(m.id)" @click.stop></video>
<img v-else-if="!isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" :src="rawHttpsUrlPlain(m.mediaUrl)" :data-raw-url="m.mediaUrl" referrerpolicy="no-referrer" alt="" @error="onMediaErr(m.id, $event)" @click.stop />
                                <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && (mediaErr.has(m.id) || !isMediaUrl(m.mediaUrl))" class="ce-fallback" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="14" />打开原链接</a>
                                <div v-else-if="(m.ocr || m.asr)" class="ce-text-preview" @click.stop>{{ (m.ocr || m.asr).slice(0, 40) }}{{ (m.ocr || m.asr).length > 40 ? '…' : '' }}</div>
                                <template v-else>
                                  <Icon :name="isVideoByUrl(m.mediaUrl) ? 'film' : 'image'" :size="18" />
                                  <span class="ce-type">{{ m.type }}</span>
                                </template>
                                <span v-if="m.mediaUrl || m.ocr || m.asr" class="ce-zoom"><Icon name="search" :size="11" /></span>
                              </div>
                            </td>
                            <td class="col-mono">{{ m.dcId || '—' }}</td>
                            <td>{{ m.advertiserId || '—' }}</td>
                            <td>{{ m.opsAdvertiserName || m.uidName || '—' }}</td>
                            <td><span v-if="m.policyIds" class="badge badge-orange-tag">{{ m.policyIds }}</span><span v-else>—</span></td>
                            <td><span v-if="m.aiEvaluatePolicyIds" class="badge badge-blue">{{ m.aiEvaluatePolicyIds }}</span><span v-else>—</span></td>
                            <td class="col-text" :title="m.ocr">{{ (m.ocr || '—').slice(0, 30) }}{{ (m.ocr || '').length > 30 ? '…' : '' }}</td>
                            <td class="col-text" :title="m.asr">{{ (m.asr || '—').slice(0, 30) }}{{ (m.asr || '').length > 30 ? '…' : '' }}</td>
                            <td>{{ m.reviewerName || '—' }}</td>
                            <td class="col-mono">{{ m.dcId || '—' }}</td>
                            <td class="col-mono">{{ m.advertiserId || '—' }}</td>
                            <td class="col-mono col-fp">{{ (m.elementFingerprint || '—').slice(0, 16) }}{{ (m.elementFingerprint || '').length > 16 ? '…' : '' }}</td>
                            <td class="col-needtag">
                              <div class="nt-edit">
                                <button class="tp-sm tp-mini" :class="{ on: rowNeedTag(m) === true }" @click.stop="setRowNeedTag(m, rowNeedTag(m) === true ? null : true)" title="需要打标（再次点击取消）"><Icon name="check" :size="11" />需要</button>
                                <button class="tp-sm tp-mini" :class="{ on: rowNeedTag(m) === false }" @click.stop="setRowNeedTag(m, rowNeedTag(m) === false ? null : false)" title="无需打标（再次点击取消）"><Icon name="close" :size="11" />无需</button>
                              </div>
                            </td>
                            <td class="col-text col-remark">
                              <input
                                class="rm-input"
                                type="text"
                                :value="rowRemark(m)"
                                @input="setRowRemark(m, $event.target.value)"
                                @click.stop
                                placeholder="—"
                              />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <div v-if="hasMoreMat(t)" class="td-mat-expand">
                        <button class="btn btn-ghost btn-sm" @click.stop="toggleExpandMat(t.id)">
                          {{ mExpanded[t.id] ? '收起' : '展开全部 ' + materialList(t).length + ' 条素材' }}
                          <Icon :name="mExpanded[t.id] ? 'chevronUp' : 'chevronDown'" :size="14" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 3 专家结论 -->
                <div class="td-sec">
                  <h4><i class="n">3</i>专家结论
                    <button v-if="canInlineEdit(t) && inlineEditing!==t.id" class="btn btn-soft btn-xs inline-edit-btn" @click.stop="startInlineEdit(t)"><Icon name="edit" :size="13" />编辑结论</button>
                  </h4>

                  <!-- 展示模式 -->
                  <template v-if="inlineEditing!==t.id">
                    <p v-if="t.conclusion" class="td-desc">{{ t.conclusion }}</p>
                    <p v-else class="td-empty">处理人尚未给出结论</p>
                    <div class="td-tip" v-if="t.conclusion"><Icon name="info" :size="13" />此处为处理人给出的专家结论，提需人采纳后将连同问题分类入库结论沉淀。</div>
                    <div v-if="t.conclusion && t.needTag !== null && t.needTag !== undefined" class="td-extra"><span class="badge" :class="t.needTag ? 'badge-blue' : 'badge-gray'">{{ t.needTag ? '需要打标' : '无需打标' }}</span></div>
                    <div class="td-extra" v-if="t.handleRemark">
                      <span class="td-ext-label">备注</span>
                      <span class="td-ext-val">{{ t.handleRemark }}</span>
                    </div>
                    <div class="td-imgs" v-if="t.conclusionImages?.length">
                      <img v-for="(img, ii) in t.conclusionImages" :key="ii" :src="img.url" :alt="img.name || '结论图片'" />
                    </div>
                  </template>

                  <!-- 内联编辑模式 -->
                  <div v-else class="inline-edit-area">
                    <input ref="inlineImageInput" type="file" accept="image/*" multiple hidden @change="onInlineImages" />
                    <label class="iel-label">解答结论 <i class="req">*</i></label>
                    <textarea class="field ta iel-conclusion" v-model="inlineForm.conclusion" placeholder="请输入处理判断、归因说明、建议动作等结论文本…"></textarea>

                    <div class="iel-cat-row">
                      <label class="iel-label">问题分类</label>
                      <select class="cat-select iel-cat" v-model="inlineForm.category">
                        <option value="">待确定</option>
                        <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
                      </select>
                    </div>

                    <label class="iel-label">是否打标 <i class="req">*</i></label>
                    <div class="tag-pick-sm">
                      <button class="tp-sm" :class="{ on: inlineForm.needTag === true }" @click="inlineForm.needTag = true"><Icon name="check" :size="13" />需要打标</button>
                      <button class="tp-sm" :class="{ on: inlineForm.needTag === false }" @click="inlineForm.needTag = false"><Icon name="close" :size="13" />无需打标</button>
                    </div>

                    <label class="iel-label">备注</label>
                    <textarea class="field ta iel-remark" v-model="inlineForm.remark" placeholder="可补充复核依据、风险提示等…"></textarea>

                    <!-- 图片上传：点击 + 拖拽 -->
                    <label class="iel-label">结论图片<span class="iel-img-count">（{{ inlineForm.images.length }}/{{ MAX_CONCLUSION_IMAGES }}）</span></label>
                    <div class="iel-dropzone" :class="{ drag: dragOver }" @click="pickInlineImage" @dragover="onInlineDragOver" @dragleave="onInlineDragLeave" @drop="onInlineDrop">
                      <Icon name="plus" :size="20" />
                      <span>点击上传或拖拽图片到此处（最多 {{ MAX_CONCLUSION_IMAGES }} 张，每张 ≤ 512KB）</span>
                    </div>
                    <div v-if="inlineForm.images.length" class="img-grid iel-img-grid">
                      <div v-for="(img, i) in inlineForm.images" :key="i" class="img-card">
                        <img :src="img.url" :alt="img.name || '结论图片'" />
                        <button @click="removeInlineImage(i)"><Icon name="close" :size="12" /></button>
                      </div>
                    </div>

                    <div class="iel-actions">
                      <button class="btn btn-ghost btn-sm" @click="cancelInlineEdit">取消</button>
                      <button class="btn btn-primary btn-sm" @click="submitInlineConclusion(t)"><Icon name="check" :size="15" />提交结论</button>
                    </div>
                  </div>
                </div>

                <!-- 4 全流程时间线 -->
                <div class="td-sec td-timeline">
                  <h4><i class="n">4</i>全流程时间线</h4>
                  <div class="tl">
                    <div v-for="(e, i) in t.timeline" :key="i" class="tl-node">
                      <span class="tl-dot" :class="{ last: i===t.timeline.length-1 }"></span>
                      <div class="tl-body"><b>{{ e.action }}</b><em>{{ e.op }} · {{ e.t }}</em></div>
                    </div>
                  </div>
                </div>
              </div>
            </transition>
          </div>
        </div>
        <EmptyState v-else icon="ticket" title="暂无工单" :desc="`当前筛选条件下没有${persp==='handler'?'可处理':'提需'}工单`" />
      </template>
    </div>

    <!-- 新建提需弹窗（三步） -->
    <Modal v-model="newOpenProxy" title="发起问题提需" width="920px">
      <!-- 恢复草稿提示条：优先新样本，弹出3秒恢复提示 -->
      <div class="steps">
        <span v-for="(s, i) in ['选中素材', '撰写问题']" :key="i" class="step" :class="{ on: step===i+1, done: step>i+1 }">
          <i>{{ step>i+1 ? '✓' : i+1 }}</i>{{ s }}
        </span>
      </div>
      <!-- step1 选中素材 -->
      <div v-if="step===1" class="ts-body">
        <template v-if="!form.samples.length">
          <div class="s1-wrap">
            <div class="s1-empty">
              <span class="s1-ic"><Icon name="box" :size="44" /></span>
              <strong>请先选择素材</strong>
              <em>素材需在以下页面中勾选后，再回到此发起提需</em>
            </div>
            <div class="goto-grid">
              <button class="goto-card" @click="gotoDetail">
                <span class="gc-ic"><Icon name="doc" :size="26" /></span>
                <strong>前往误杀Case分析-标签跟踪</strong>
                <em>勾选样本后发起提需给处理人</em>
              </button>
              <button class="goto-card" @click="gotoAnnotate">
                <span class="gc-ic"><Icon name="classify" :size="26" /></span>
<strong>前往误杀Case分析-自由分析</strong>
                <em>标注选择素材后发起提需给处理人</em>
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="s1-wrap">
            <div class="sel-head">
              <span>已选关联素材（{{ form.samples.length }}）{{ form.clusters.length ? ` · 含 ${form.clusters.length} 个聚类簇` : '' }}</span>
              <button class="btn btn-ghost btn-xs" @click="clearSamples"><Icon name="close" :size="13" />清空重选</button>
            </div>
            <!-- 选中的聚类簇：卡片内为簇特征 + 簇内全部 case（可预览） -->
            <div v-if="form.clusters.length" class="cluster-ticket-list">
              <div v-for="cl in form.clusters" :key="'c'+cl.classId" class="cluster-ticket-card">
                <div class="ctc-hd">
                  <span class="ctc-cluster">{{ cl.classId }}</span>
                  <span class="ctc-tag">簇</span>
                  <span class="ctc-feature" :title="cl.feature">{{ cl.feature }}</span>
                  <button class="ctc-rm" @click="removeCluster(cl)"><Icon name="close" :size="13" /></button>
                </div>
                <div class="sel-grid ctc-grid">
                  <div v-for="s in cl.elements" :key="sampleId(s)" class="sel-card">
                    <div class="sc-thumb" :class="{ vid: isVideoByUrl(s.mediaUrl) && isValidHttpUrl(s.mediaUrl), clickable: s.mediaUrl || s.ocr || s.asr, 'text-type': !isVideoByUrl(s.mediaUrl) && (!s.mediaUrl || !isValidHttpUrl(s.mediaUrl)) }" @click="openPreview({ id: sampleId(s), vid: isVideoByUrl(s.mediaUrl), mediaUrl: s.mediaUrl, type: sampleType(s), ocr: s.ocr || '', asr: s.asr || '' }, cl.elements.map(x => ({ id: sampleId(x), vid: isVideoByUrl(x.mediaUrl), mediaUrl: x.mediaUrl, type: sampleType(x), ocr: x.ocr || '', asr: x.asr || '' })))">
                      <img v-if="!isVideoByUrl(s.mediaUrl) && s.mediaUrl && !mediaErr.has(sampleId(s)) && isValidHttpUrl(s.mediaUrl) && isMediaUrl(s.mediaUrl)" :src="safeUrl(s.mediaUrl)" alt="" @error="onMediaErr(sampleId(s))" />
                      <a v-else-if="s.mediaUrl && isValidHttpUrl(s.mediaUrl) && isMediaUrl(s.mediaUrl) && mediaErr.has(sampleId(s))" class="sc-link-preview" :href="safeUrl(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /><span>打开原链接</span></a>
                      <div v-else-if="s.mediaUrl && !isValidHttpUrl(s.mediaUrl)" class="sc-text-preview">{{ s.mediaUrl.slice(0, 100) }}{{ s.mediaUrl.length > 100 ? '…' : '' }}</div>
                      <div v-else-if="(s.ocr || s.asr)" class="sc-text-preview">{{ (s.ocr || s.asr).slice(0, 100) }}{{ (s.ocr || s.asr).length > 100 ? '…' : '' }}</div>
                      <template v-else><Icon :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="36" /></template>
                      <span class="sc-watermark">{{ sampleId(s) }}</span><span class="sc-type-badge">{{ isVideoByUrl(s.mediaUrl) && isValidHttpUrl(s.mediaUrl) ? 'video' : (s.mediaUrl && isValidHttpUrl(s.mediaUrl) ? 'image' : 'text') }}</span><span v-if="s.mediaUrl || s.ocr || s.asr" class="sc-zoom"><Icon name="search" :size="12" /></span></div>
                    <div class="sc-id"><span class="sc-tag">素材ID</span>{{ sampleId(s) }}</div>
                    <div class="sc-fp" v-if="s.elementFingerprint || s.element_fingerprint" :title="s.elementFingerprint || s.element_fingerprint">审核物理指纹:{{ (s.elementFingerprint || s.element_fingerprint).slice(0,16) }}{{ (s.elementFingerprint || s.element_fingerprint).length > 16 ? '…' : '' }}</div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 单个 case（未构成整簇勾选的零散素材） -->
            <template v-if="form.samples.length">
              <div v-if="form.clusters.length" class="s1-subhd"><Icon name="doc" :size="13" />单个 case（{{ form.samples.length }}）</div>
              <div class="sel-grid">
                <div v-for="s in form.samples" :key="sampleId(s)" class="sel-card">
                  <div class="sc-thumb" :class="{ vid: isVideoByUrl(s.mediaUrl) && isValidHttpUrl(s.mediaUrl), clickable: s.mediaUrl || s.ocr || s.asr, 'text-type': !isVideoByUrl(s.mediaUrl) && (!s.mediaUrl || !isValidHttpUrl(s.mediaUrl)) }" @click="openPreview({ id: sampleId(s), vid: isVideoByUrl(s.mediaUrl), mediaUrl: s.mediaUrl, type: sampleType(s), ocr: s.ocr || '', asr: s.asr || '' }, form.samples.map(x => ({ id: sampleId(x), vid: isVideoByUrl(x.mediaUrl), mediaUrl: x.mediaUrl, type: sampleType(x), ocr: x.ocr || '', asr: x.asr || '' })))">
                    <img v-if="!isVideoByUrl(s.mediaUrl) && s.mediaUrl && !mediaErr.has(sampleId(s)) && isValidHttpUrl(s.mediaUrl) && isMediaUrl(s.mediaUrl)" :src="safeUrl(s.mediaUrl)" alt="" @error="onMediaErr(sampleId(s))" />
                    <a v-else-if="s.mediaUrl && isValidHttpUrl(s.mediaUrl) && isMediaUrl(s.mediaUrl) && mediaErr.has(sampleId(s))" class="sc-link-preview" :href="safeUrl(s.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /><span>打开原链接</span></a>
                    <div v-else-if="s.mediaUrl && !isValidHttpUrl(s.mediaUrl)" class="sc-text-preview">{{ s.mediaUrl.slice(0, 100) }}{{ s.mediaUrl.length > 100 ? '…' : '' }}</div>
                    <div v-else-if="(s.ocr || s.asr)" class="sc-text-preview">{{ (s.ocr || s.asr).slice(0, 100) }}{{ (s.ocr || s.asr).length > 100 ? '…' : '' }}</div>
                    <template v-else><Icon :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="36" /></template>
                    <span class="sc-watermark">{{ sampleId(s) }}</span><span class="sc-type-badge">{{ isVideoByUrl(s.mediaUrl) && isValidHttpUrl(s.mediaUrl) ? 'video' : (s.mediaUrl && isValidHttpUrl(s.mediaUrl) ? 'image' : 'text') }}</span><span v-if="s.mediaUrl || s.ocr || s.asr" class="sc-zoom"><Icon name="search" :size="12" /></span></div>
                  <div class="sc-id"><span class="sc-tag">素材ID</span>{{ sampleId(s) }}</div>
                  <div class="sc-fp" v-if="s.elementFingerprint || s.element_fingerprint" :title="s.elementFingerprint || s.element_fingerprint">审核物理指纹:{{ (s.elementFingerprint || s.element_fingerprint).slice(0,16) }}{{ (s.elementFingerprint || s.element_fingerprint).length > 16 ? '…' : '' }}</div>
                  <i class="sc-rm" @click="removeSample(s)"><Icon name="close" :size="13" /></i>
                </div>
              </div>
            </template>
            <div class="more-src">
              如需补充更多素材，可继续前往：
<a @click="gotoDetail">误杀Case分析-标签跟踪</a><i>·</i><a @click="gotoAnnotate">误杀Case分析-自由分析</a>
            </div>
          </div>
        </template>
      </div>
      <!-- step2 工单字段 + 撰写问题（原step2与step3合并） -->
      <div v-else-if="step===2" class="ts-body">
        <!-- 已关联素材预览 -->
        <div class="f2-mat-preview" v-if="form.samples.length">
          <div class="f2-mat-head">
            <Icon name="image" :size="14" />
            <span>已关联素材（{{ form.samples.length }}）</span>
          </div>
          <div class="f2-mat-list">
            <div v-for="s in form.samples.slice(0, 12)" :key="s.id" class="f2-mat-item">
              <div class="f2-mat-thumb">
                <video v-if="isVideoByUrl(s.mediaUrl) && s.mediaUrl && isValidHttpUrl(s.mediaUrl)" :src="safeUrl(s.mediaUrl)" muted preload="metadata" @error="onMediaErr(s.id)"></video>
                <img v-else-if="!isVideoByUrl(s.mediaUrl) && s.mediaUrl && isValidHttpUrl(s.mediaUrl)" :src="safeUrl(s.mediaUrl)" alt="" @error="onMediaErr(s.id)" />
                <div v-else-if="s.ocr || s.asr" class="f2-mat-text">{{ (s.ocr || s.asr).slice(0, 40) }}{{ (s.ocr || s.asr).length > 40 ? '…' : '' }}</div>
                <Icon v-else :name="isVideoByUrl(s.mediaUrl) ? 'film' : 'image'" :size="20" />
              </div>
              <span class="f2-mat-id" :title="s.id">{{ s.id }}</span>
              <span class="f2-mat-fp" v-if="s.elementFingerprint || s.element_fingerprint" :title="s.elementFingerprint || s.element_fingerprint">指纹:{{ (s.elementFingerprint || s.element_fingerprint).slice(0,10) }}…</span>
            </div>
            <div v-if="form.samples.length > 12" class="f2-mat-item f2-mat-more">
              <div class="f2-mat-thumb"><strong>+{{ form.samples.length - 12 }}</strong></div>
            </div>
          </div>
        </div>
        <div class="s3-divider" style="margin:12px 0"></div>
        <div class="f2-hd">
          <span class="f2-title">工单字段（依据所选素材自动带出，可修改）</span>
        </div>
          <div class="fgrid">
            <div><label>标签</label><input class="field" v-model="tagDisplay" placeholder="标签ID-标签名，如 14776-虚假人设或事件" /></div>
            <div><label>元素类型</label>
              <select class="field" v-model="form.elementType"><option v-if="!fieldsReady" value="">　</option><option>图片</option><option>视频</option><option>文本</option><option>落地页</option></select></div>
            <div><label>一级行业</label><input class="field" v-model="form.industryL1" /></div>
            <div><label>二级行业</label><input class="field" v-model="form.industryL2" /></div>
          </div>
          <div class="fgrid" style="margin-top:10px">
            <div><label>审核人</label><input class="field" v-model="form.reviewerName" placeholder="审核人姓名" /></div>
            <div><label>创意ID(DCID)</label><input class="field" v-model="form.dcId" placeholder="创意ID(DCID)" /></div>
            <div><label>广告主ID</label><input class="field" v-model="form.advertiserId" placeholder="广告主ID" /></div>
            <div><label>审核物理指纹(md5)</label><input class="field" v-model="form.elementFingerprint" placeholder="审核物理指纹(md5)" /></div>
          </div>
          <label>标签详情（手动补充）</label>
          <input class="field full" v-model="form.tagDetail" placeholder="补充标签相关说明" />
        <div class="s3-divider"></div>
        <label>工单标题 <i class="req">*</i></label>
        <input class="field full" v-model="form.title" :placeholder="autoTitlePlaceholder" />
        <label>问题描述 <i class="req">*</i></label>
        <textarea class="field ta" v-model="form.desc" placeholder="请描述该批素材为何属于误杀，误杀的判断依据…"></textarea>
        <div class="s3-row">
          <div class="fblock">
            <label>紧急程度</label>
            <div class="urg">
              <button v-for="u in [1,2,3]" :key="u" :class="{ on: form.urgency===u, [URGENCY[u].c]: form.urgency===u }" @click="form.urgency=u">{{ URGENCY[u].t }}</button>
            </div>
          </div>
          <div class="fblock">
            <label>问题分类<em class="lb-opt">（选填）</em></label>
            <select class="field full" v-model="form.category">
              <option value="">可不填，采纳时确定</option>
              <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
            </select>
          </div>
        </div>
        <div v-if="form.category==='OTHER'" class="fblock">
          <label>补充说明<em class="lb-opt">（选填，可写可不写）</em></label>
          <input class="field full" v-model="form.categoryOther" placeholder="可补充「其他」分类的具体说明…" />
        </div>
        <div class="s3-row">
          <div class="fblock">
            <label>指派处理人<em class="lb-opt">（选填，指定后工单不进入公共池，直接指派该处理人）</em></label>
            <div class="notify-chips notify-chips--suggest">
              <span v-if="form.handler" class="notify-chip">
                {{ form.handler }}
                <button class="chip-x" @click="form.handler = ''"><Icon name="close" :size="12" /></button>
              </span>
              <input v-else
                class="field notify-input"
                v-model="form.handlerInput"
                placeholder="输入处理人用户名，回车或点击选中"
                @input="onAssignInputChange(form.handlerInput, 'handler')"
                @keydown.enter.prevent="handlerSuggestOpen ? (notifySuggests.length === 1 ? selectAssignSuggest(notifySuggests[0], 'handler') : addHandler()) : addHandler()"
                @blur="blurAssignSuggest('handler')"
              />
              <transition name="fade-scale">
                <div v-if="handlerSuggestOpen && notifySuggests.length" class="notify-dropdown">
                  <div v-for="s in notifySuggests" :key="s" class="notify-dropdown-item" @mousedown.prevent="selectAssignSuggest(s, 'handler')">
                    <img class="nd-avatar" :src="`https://auth.example.com/photo/150/${s}.png?default_when_absent=true`" alt="" />
                    <span class="nd-name">{{ s }}</span>
                  </div>
                </div>
              </transition>
            </div>
          </div>
          <div class="fblock">
            <label>嵌套依据工单<em class="lb-opt">（选填，可引用一张已有人审专家工单作为依据）</em></label>
            <div class="notify-chips notify-chips--suggest">
              <span v-if="form.parentTicketId" class="notify-chip" :title="parentTicketLabel">
                {{ parentTicketLabel }}
                <button class="chip-x" @click="clearParentTicket"><Icon name="close" :size="12" /></button>
              </span>
              <input v-else
                class="field notify-input"
                v-model="parentTicketInput"
                placeholder="输入工单ID或标题搜索，如 TKT-2100"
                @input="onParentTicketInput"
                @blur="blurParentTicket"
              />
              <transition name="fade-scale">
                <div v-if="parentTicketOpen && parentTicketResults.length" class="notify-dropdown">
                  <div v-for="t in parentTicketResults" :key="t.id" class="notify-dropdown-item" @mousedown.prevent="selectParentTicket(t)">
                    <span class="nd-name">{{ t.id }} · {{ t.title }}</span>
                  </div>
                </div>
              </transition>
            </div>
          </div>
        </div>
        <div class="fblock">
          <label>抄送知会<em class="lb-opt">（选填，输入用户名搜索或回车添加，仅知会查看、不负责结论）</em></label>
          <div class="notify-chips notify-chips--suggest">
            <span v-for="(u, i) in form.ccUsers" :key="i" class="notify-chip">
              {{ u }}
              <button class="chip-x" @click="form.ccUsers.splice(i, 1)"><Icon name="close" :size="12" /></button>
            </span>
            <input
              class="field notify-input"
              v-model="form.ccInput"
              placeholder="输入用户名，回车添加"
              @input="onAssignInputChange(form.ccInput, 'cc')"
              @keydown.enter.prevent="ccSuggestOpen ? (notifySuggests.length === 1 ? selectAssignSuggest(notifySuggests[0], 'cc') : addCcUser()) : addCcUser()"
              @keydown.delete="!form.ccInput && form.ccUsers.length && form.ccUsers.pop()"
              @blur="blurAssignSuggest('cc')"
            />
            <transition name="fade-scale">
              <div v-if="ccSuggestOpen && notifySuggests.length" class="notify-dropdown">
                <div v-for="s in notifySuggests" :key="s" class="notify-dropdown-item" @mousedown.prevent="selectAssignSuggest(s, 'cc')">
                  <img class="nd-avatar" :src="`https://auth.example.com/photo/150/${s}.png?default_when_absent=true`" alt="" />
                  <span class="nd-name">{{ s }}</span>
                </div>
              </div>
            </transition>
          </div>
        </div>
        <div class="fblock">
          <label>通知对象<em class="lb-opt">（选填，输入用户名搜索或回车添加，提交时通过企微群机器人 @ 通知）</em></label>
          <div class="notify-chips notify-chips--suggest">
            <span v-for="(u, i) in form.notifyUsers" :key="i" class="notify-chip">
              {{ u }}
              <button class="chip-x" @click="form.notifyUsers.splice(i, 1)"><Icon name="close" :size="12" /></button>
            </span>
            <input
              class="field notify-input"
              v-model="form.notifyInput"
              placeholder="输入用户名，回车添加"
              @input="onNotifyInputChange(form.notifyInput, 'new')"
              @keydown.enter.prevent="notifySuggestOpen ? (notifySuggests.length === 1 ? selectNotifySuggest(notifySuggests[0], 'new') : addNotifyUser()) : addNotifyUser()"
              @keydown.delete="!form.notifyInput && form.notifyUsers.length && form.notifyUsers.pop()"
              @focus="form.notifyInput && onNotifyInputChange(form.notifyInput, 'new')"
              @blur="blurNotifySuggest('new')"
            />
            <transition name="fade-scale">
              <div v-if="notifySuggestOpen && notifySuggests.length" class="notify-dropdown">
                <div v-for="s in notifySuggests" :key="s" class="notify-dropdown-item" @mousedown.prevent="selectNotifySuggest(s, 'new')">
                  <img class="nd-avatar" :src="`https://auth.example.com/photo/150/${s}.png?default_when_absent=true`" alt="" />
                  <span class="nd-name">{{ s }}</span>
                </div>
              </div>
            </transition>
          </div>
        </div>
      </div>
      <template #footer>
        <button v-if="step===2" class="btn btn-ghost btn-sm foot-left" @click="step=1"><Icon name="chevronLeft" :size="15" />上一步</button>
        <button v-if="savingDraft" class="btn btn-ghost btn-sm" disabled><Icon name="loading" :size="14" />保存中…</button>
        <button v-else class="btn btn-ghost btn-sm" @click="manualSaveDraft"><Icon name="save" :size="14" />暂存草稿</button>
        <button class="btn btn-ghost btn-sm" @click="newOpenProxy = false">{{ ticketFlow.origin ? '返回上一页' : '取消' }}</button>
        <button v-if="step===1" class="btn btn-primary btn-sm" :disabled="!form.samples.length" @click="enterStep2">下一步<Icon name="chevronRight" :size="15" /></button>
        <button v-if="step===2" class="btn btn-primary btn-sm" @click="submitTicket"><Icon name="check" :size="15" />提交提需</button>
      </template>
    </Modal>

    <!-- 草稿箱：提需中断保留现场，点击恢复离开时的步骤 -->
    <Modal v-model="draftsOpen" title="草稿箱" width="640px">
      <div class="draft-box">
        <p class="draft-tip">提需填到一半关闭后不会丢失，会自动暂存到此处。点击任意草稿可恢复到中断离开时的步骤继续填写。</p>
        <template v-if="drafts.length">
          <ul class="draft-list">
            <li v-for="d in drafts" :key="d.id" class="draft-item">
              <button class="draft-main" @click="resumeDraft(d)">
                <span class="draft-sum">{{ d.summary || '未命名草稿' }}</span>
                <span class="draft-meta">
                  <span class="draft-step">停留：{{ d.step === 2 ? '撰写问题' : '选中素材' }}</span>
                  <span class="draft-time">{{ formatDraftTime(d.updatedAt) }}</span>
                </span>
              </button>
              <button class="draft-del" title="删除草稿" @click="deleteDraft(d)"><Icon name="trash" :size="15" /></button>
            </li>
          </ul>
        </template>
        <div v-else class="draft-empty">
          <Icon name="doc" :size="36" />
          <p>暂无草稿。提需中关闭弹窗会自动暂存，或点击「暂存草稿」手动保存。</p>
        </div>
      </div>
    </Modal>

    <!-- 处理人结论弹窗 -->
    <Modal v-model="handleOpen" :title="handleTicket ? `处理工单·${handleTicket.tagId}-${handleTicket.tag || '未命名标签'}` : '处理工单'" width="760px">
      <div v-if="handleTicket" class="hd-body hd-rich">
        <div class="hd-title-card">
          <div class="htc-main">
            <span class="hd-kicker">标签ID-标签名</span>
            <strong>{{ handleTicket.tagId }}-{{ handleTicket.tag || '未命名标签' }}</strong>
          </div>
          <span class="badge" :class="statusCls(handleTicket.status)">{{ statusText(handleTicket.status) }}</span>
        </div>

        <div class="hd-meta-tags">
          <span class="badge badge-gray">{{ handleTicket.elementType || '素材' }}</span>
          <span class="badge badge-gray">{{ handleTicket.industryL1 || '未分类' }}-{{ handleTicket.industryL2 || '其他' }}</span>
          <span class="badge" :class="`badge-${URGENCY[handleTicket.urgency]?.c || 'gray'}`">{{ URGENCY[handleTicket.urgency]?.t || '中' }}优先级</span>
        </div>

        <div class="hd-cat-inline">
          <label>问题分类</label>
          <select class="cat-select" v-model="handleForm.category" title="处理人可修改，修改后提需人可在工单时间线查看记录">
            <option value="">待确定</option>
            <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
          </select>
          <span v-if="(handleForm.category||'') !== (handleTicket.category||'')" class="hcs-changed"><Icon name="edit" :size="12" />已修改</span>
        </div>
        <p v-if="(handleForm.category||'') !== (handleTicket.category||'')" class="hcs-note">
          原分类「{{ catLabel(handleTicket.category) }}」→ 现「{{ catLabel(handleForm.category) }}」，提交结论后生效并通知提需人
        </p>

        <div class="hd-section">
          <h4 class="sec-title"><i class="n">1</i>问题描述</h4>
          <p class="hd-desc">{{ handleTicket.desc || '暂无问题描述' }}</p>
          <div class="hm-head">
            <Icon name="image" :size="15" />
            <span>已关联素材</span>
            <em>（{{ materialList(handleTicket).length }}）</em>
          </div>
          <!-- 已关联素材表格（处理人视角） -->
          <div v-if="materialList(handleTicket).length" class="td-mat-table-wrap">
            <table class="td-mat-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th class="sticky-col">元素</th>
                  <th>创意ID</th>
                  <th>广告主</th>
                  <th>客户主体</th>
                  <th>机审标签</th>
                  <th>人审标签</th>
                  <th>OCR</th>
                  <th>ASR</th>
                  <th>审核员</th>
                  <th>DCID</th>
                  <th>广告主ID</th>
                  <th>审核物理指纹</th>
                  <th>是否打标</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, idx) in visibleMaterials(handleTicket)" :key="m.id" :class="'mat-row-' + m.matStatus">
                  <td class="col-idx">{{ idx + 1 }}</td>
                  <td class="sticky-col col-element" @click="openPreview(m, materialList(handleTicket))">
                    <div class="ce-thumb">
<video v-if="isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" v-lazy-video :data-src="m.mediaUrl" :data-raw-url="m.mediaUrl" controls playsinline muted style="max-width:100%;max-height:60px;border-radius:6px" @error="onMediaErr(m.id)" @click.stop></video>
<img v-else-if="!isVideoByUrl(m.mediaUrl) && m.mediaUrl && !mediaErr.has(m.id) && isValidHttpUrl(m.mediaUrl) && isMediaUrl(m.mediaUrl)" :src="rawHttpsUrlPlain(m.mediaUrl)" :data-raw-url="m.mediaUrl" referrerpolicy="no-referrer" alt="" style="max-width:100%;max-height:60px;border-radius:6px" @error="onMediaErr(m.id, $event)" @click.stop />
                      <a v-else-if="m.mediaUrl && isValidHttpUrl(m.mediaUrl) && (mediaErr.has(m.id) || !isMediaUrl(m.mediaUrl))" class="ce-fallback" :href="safeUrl(m.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="14" />打开原链接</a>
                      <div v-else-if="(m.ocr || m.asr)" class="ce-text-preview" @click.stop>{{ (m.ocr || m.asr).slice(0, 40) }}{{ (m.ocr || m.asr).length > 40 ? '…' : '' }}</div>
                      <template v-else>
                        <Icon :name="isVideoByUrl(m.mediaUrl) ? 'film' : 'image'" :size="18" />
                        <span class="ce-type">{{ m.type }}</span>
                      </template>
                      <span v-if="m.mediaUrl || m.ocr || m.asr" class="ce-zoom"><Icon name="search" :size="11" /></span>
                    </div>
                  </td>
                  <td class="col-mono">{{ m.dcId || '—' }}</td>
                  <td>{{ m.advertiserId || '—' }}</td>
                  <td>{{ m.opsAdvertiserName || m.uidName || '—' }}</td>
                  <td><span v-if="m.policyIds" class="badge badge-orange-tag">{{ m.policyIds }}</span><span v-else>—</span></td>
                  <td><span v-if="m.aiEvaluatePolicyIds" class="badge badge-blue">{{ m.aiEvaluatePolicyIds }}</span><span v-else>—</span></td>
                  <td class="col-text" :title="m.ocr">{{ (m.ocr || '—').slice(0, 30) }}{{ (m.ocr || '').length > 30 ? '…' : '' }}</td>
                  <td class="col-text" :title="m.asr">{{ (m.asr || '—').slice(0, 30) }}{{ (m.asr || '').length > 30 ? '…' : '' }}</td>
                  <td>{{ m.reviewerName || '—' }}</td>
                  <td class="col-mono">{{ m.dcId || '—' }}</td>
                  <td class="col-mono">{{ m.advertiserId || '—' }}</td>
                  <td class="col-mono col-fp" :title="m.elementFingerprint">{{ (m.elementFingerprint || '—').slice(0, 16) }}{{ (m.elementFingerprint || '').length > 16 ? '…' : '' }}</td>
                  <td @click.stop>
                    <div class="tag-pick-sm tag-pick-td">
                      <!-- 三态切换：点击已选中的按钮再次点击 = 取消（回到未选状态） -->
                      <button class="tp-sm tp-mini" :class="{ on: sampleNeedTags[m.id] === true }" @click="sampleNeedTags[m.id] = sampleNeedTags[m.id] === true ? null : true" title="需要打标（再次点击取消）"><Icon name="check" :size="11" />需要</button>
                      <button class="tp-sm tp-mini" :class="{ on: sampleNeedTags[m.id] === false }" @click="sampleNeedTags[m.id] = sampleNeedTags[m.id] === false ? null : false" title="无需打标（再次点击取消）"><Icon name="close" :size="11" />无需</button>
                    </div>
                  </td>
                  <td @click.stop>
                    <input class="remark-td" v-model="sampleConclusions[m.id]" placeholder="结论…" />
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="hasMoreMat(handleTicket)" class="td-mat-expand">
              <button class="btn btn-ghost btn-sm" @click.stop="toggleExpandMat(handleTicket.id)">
                {{ mExpanded[handleTicket.id] ? '收起' : '展开全部 ' + materialList(handleTicket).length + ' 条素材' }}
                <Icon :name="mExpanded[handleTicket.id] ? 'chevronUp' : 'chevronDown'" :size="14" />
              </button>
            </div>
          </div>
          <p v-else class="hm-empty">该工单暂未关联素材</p>
        </div>

        <div class="hd-section">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <label style="margin:0">解答结论 <i class="req">*</i></label>
            <button class="btn btn-soft btn-xs" @click="autoFillConclusion" v-tip="'将逐条素材结论自动汇总填入'"><Icon name="sparkle" :size="13" />自动汇总</button>
          </div>
          <textarea class="field ta hd-conclusion" v-model="handleForm.conclusion" placeholder="请输入处理判断、归因说明、建议动作等结论文本…也可逐条素材填写后点击「自动汇总」"></textarea>
          <input ref="imageInput" type="file" accept="image/*" multiple hidden @change="onConclusionImages" />
          <div class="iel-dropzone" :class="{ drag: modalDragOver }" @click="pickConclusionImage" @dragover="onModalDragOver" @dragleave="onModalDragLeave" @drop="onModalDrop">
            <Icon name="plus" :size="14" />
            <span>点击上传或拖拽图片到此处（最多 {{ MAX_CONCLUSION_IMAGES }} 张，每张 ≤ 512KB）{{ handleForm.images.length ? `· 已选 ${handleForm.images.length}/${MAX_CONCLUSION_IMAGES}` : '' }}</span>
          </div>
          <div v-if="handleForm.images.length" class="img-grid">
            <div v-for="(img, i) in handleForm.images" :key="i" class="img-card">
              <img :src="img.url" :alt="img.name || '结论图片'" />
              <button @click="removeConclusionImage(i)"><Icon name="close" :size="12" /></button>
            </div>
          </div>

          <div class="hd-inline-row">
            <label class="hd-il-label">是否打标 <i class="req">*</i></label>
            <div class="tag-pick-sm">
              <button class="tp-sm" :class="{ on: handleForm.needTag === true }" @click="handleForm.needTag = true"><Icon name="check" :size="13" />需要打标</button>
              <button class="tp-sm" :class="{ on: handleForm.needTag === false }" @click="handleForm.needTag = false"><Icon name="close" :size="13" />无需打标</button>
            </div>
          </div>

          <div class="hd-inline-row">
            <label class="hd-il-label">备注</label>
            <textarea class="field ta hd-remark" v-model="handleForm.remark" placeholder="可补充复核依据、风险提示等…"></textarea>
          </div>

          <div class="hd-inline-row" style="flex-direction:column;align-items:stretch;">
            <label class="hd-il-label">通知对象<em class="lb-opt">（选填，默认通知提需人，可增删改，提交后通知对应成员）</em></label>
            <div class="notify-chips notify-chips--suggest">
              <span v-for="(u, i) in handleForm.notifyUsers" :key="i" class="notify-chip">
                {{ u }}
                <button class="chip-x" @click="handleForm.notifyUsers.splice(i, 1)"><Icon name="close" :size="12" /></button>
              </span>
              <input
                class="field notify-input"
                v-model="handleForm.notifyInput"
                placeholder="输入用户名，回车添加"
                @input="onNotifyInputChange(handleForm.notifyInput, 'handle')"
                @keydown.enter.prevent="handleSuggestOpen ? (notifySuggests.length === 1 ? selectNotifySuggest(notifySuggests[0], 'handle') : addHandleNotifyUser()) : addHandleNotifyUser()"
                @keydown.delete="!handleForm.notifyInput && handleForm.notifyUsers.length && handleForm.notifyUsers.pop()"
                @focus="handleForm.notifyInput && onNotifyInputChange(handleForm.notifyInput, 'handle')"
                @blur="blurNotifySuggest('handle')"
              />
              <transition name="fade-scale">
                <div v-if="handleSuggestOpen && notifySuggests.length" class="notify-dropdown">
                  <div v-for="s in notifySuggests" :key="s" class="notify-dropdown-item" @mousedown.prevent="selectNotifySuggest(s, 'handle')">
                    <img class="nd-avatar" :src="`https://auth.example.com/photo/150/${s}.png?default_when_absent=true`" alt="" />
                    <span class="nd-name">{{ s }}</span>
                  </div>
                </div>
              </transition>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
<button class="btn btn-ghost btn-sm" @click="handleOpen=false; clearOverlay()">取消</button>
        <button class="btn btn-soft btn-sm" @click="exportTicketExcel(handleTicket)"><Icon name="download" :size="14" />下载数据</button>
        <button class="btn btn-soft btn-sm" @click="openSimilarLibrary(handleTicket)"><Icon name="database" :size="14" />相似样本检索</button>
        <button class="btn btn-primary btn-sm" @click="submitConclusion"><Icon name="check" :size="15" />提交结论</button>
      </template>
    </Modal>

    <!-- 采纳确定问题分类弹窗 -->
    <Modal v-model="adoptOpen" title="采纳结论 · 确定问题分类" width="640px">
      <div v-if="adoptTicket" class="adopt-body">
        <!-- 工单信息卡 -->
        <div class="adopt-info-card">
          <div class="aic-top">
            <span class="badge badge-blue">{{ adoptTicket.tagId }}-{{ adoptTicket.tag }}</span>
            <span class="badge badge-gray">{{ adoptTicket.elementType }}</span>
            <span class="badge badge-gray">{{ adoptTicket.industryL1 }}/{{ adoptTicket.industryL2 }}</span>
            <span class="badge" :class="`badge-${URGENCY[adoptTicket.urgency]?.c || 'gray'}`">{{ URGENCY[adoptTicket.urgency]?.t || '中' }}优</span>
          </div>
          <h3 class="aic-title">{{ adoptTicket.title }}</h3>
        </div>

        <!-- 编号分区：专家结论 -->
        <div class="adopt-sec">
          <h4><i class="n">1</i>专家结论</h4>
          <p class="adopt-conc">{{ adoptTicket.conclusion || '处理人尚未给出结论' }}</p>
          <div v-if="adoptTicket.needTag !== null && adoptTicket.needTag !== undefined" class="adopt-qual">
<span class="badge" :class="adoptTicket.needTag ? 'badge-blue' : 'badge-gray'">{{ adoptTicket.needTag ? '需要打标' : '无需打标' }}</span>
          </div>
          <div v-if="adoptTicket.handleRemark" class="adopt-remark">
            <Icon name="doc" :size="13" />
            <span>{{ adoptTicket.handleRemark }}</span>
          </div>
        </div>

        <!-- 编号分区：确定问题分类 -->
        <div class="adopt-sec">
          <h4><i class="n">2</i>确定问题分类 <i class="req">*</i></h4>
          <p class="ad-tip"><Icon name="info" :size="13" />采纳时必须确定/更换问题分类，采纳后归因结论将连同问题分类自动入库「结论沉淀」</p>
          <select class="cat-select" v-model="adoptCat">
            <option :value="null" disabled>请选择问题分类</option>
            <option v-for="c in PROBLEM_CATEGORIES" :key="c.code" :value="c.code">{{ c.label }}</option>
          </select>
        </div>

        <!-- 编号分区：确认结果类型 -->
        <div class="adopt-sec">
          <h4><i class="n">3</i>确认结果类型 <i class="req">*</i></h4>
          <p class="ad-tip"><Icon name="info" :size="13" />提需人采纳时需确认该工单的最终结果类型，该标签将随工单和沉淀记录一同展示</p>
          <div class="rt-pick">
            <button class="rt-card" :class="{ on: adoptResultType==='real_fp' }" @click="adoptResultType='real_fp'">
              <span class="rt-ic rt-ic-red"><Icon name="alert" :size="18" /></span>
              <div class="rt-text"><strong>真实误杀</strong><em>该样本确属误杀，机审判定有误</em></div>
              <span class="rt-ck"><Icon v-if="adoptResultType==='real_fp'" name="check" :size="14" /></span>
            </button>
            <button class="rt-card" :class="{ on: adoptResultType==='machine_right' }" @click="adoptResultType='machine_right'">
              <span class="rt-ic rt-ic-green"><Icon name="check" :size="18" /></span>
              <div class="rt-text"><strong>机审正确</strong><em>机审判定正确，该样本不属于误杀</em></div>
              <span class="rt-ck"><Icon v-if="adoptResultType==='machine_right'" name="check" :size="14" /></span>
            </button>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="adoptOpen=false">取消</button>
        <button class="btn btn-primary btn-sm" @click="confirmAdopt"><Icon name="check" :size="15" />确认采纳并入库</button>
      </template>
    </Modal>

    <!-- 退回工单弹窗 -->
    <Modal v-model="rejectOpen" title="退回工单" width="480px">
      <div v-if="rejectTicket" class="rj-body">
        <div class="rj-ticket">
          <span class="rj-id">{{ rejectTicket.id }}</span>
          <span class="rj-title">{{ rejectTicket.title }}</span>
        </div>
        <p class="rj-tip"><Icon name="info" :size="14" />退回后工单将回到原处理人继续处理，请填写退回原因以便处理人了解问题</p>
        <label>退回原因 <i class="req">*</i></label>
        <textarea class="field ta rj-reason" v-model="rejectReason" placeholder="请填写退回原因，如：结论描述不清晰、需要补充更多素材证据…" rows="4"></textarea>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="rejectOpen=false">取消</button>
        <button class="btn btn-primary btn-sm" @click="confirmReject"><Icon name="check" :size="15" />确认退回</button>
      </template>
    </Modal>

    <!-- 删除工单确认弹窗（仅管理员） -->
    <Modal v-model="deleteOpen" title="删除工单" width="440px">
      <div v-if="deleteTicket" class="del-body">
        <div class="del-ic"><Icon name="alert" :size="30" /></div>
        <p class="del-warn">确认删除工单 <b>{{ deleteTicket.id }}</b>「{{ deleteTicket.title }}」？</p>
        <p class="del-tip">删除后该工单及其全部流转记录将无法恢复，请谨慎操作。</p>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="deleteOpen=false" :disabled="deleting">取消</button>
        <button class="btn btn-danger btn-sm" :disabled="deleting" @click="confirmDelete">
          <Icon name="trash" :size="15" />{{ deleting ? '删除中…' : '确认删除' }}
        </button>
      </template>
    </Modal>

    <!-- 媒体预览弹窗（视频/图片全屏预览，含倍速切换+左右切换） -->
    <transition name="fade-scale">
      <div v-if="previewOpen && previewMedia" class="pv-overlay" @click.self="closePreview">
        <div class="pv-modal">
          <button class="pv-close" @click="closePreview"><Icon name="close" :size="18" /></button>
          <!-- 左切换箭头 -->
          <button v-if="previewMaterials.length > 1" class="pv-nav pv-prev" @click="prevPreview" title="上一个（←键）"><Icon name="chevronLeft" :size="22" /></button>
          <!-- 右切换箭头 -->
          <button v-if="previewMaterials.length > 1" class="pv-nav pv-next" @click="nextPreview" title="下一个（→键）"><Icon name="chevronRight" :size="22" /></button>
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
            <span class="pv-type">{{ isVideoByUrl(previewMedia.mediaUrl) ? 'video' : (previewMedia.mediaUrl && !isMediaUrl(previewMedia.mediaUrl) ? 'link' : 'image') }}</span>
            <span v-if="previewMaterials.length > 1" class="pv-counter">{{ previewIndex + 1 }} / {{ previewMaterials.length }}</span>
            <button v-if="isVideoByUrl(previewMedia.mediaUrl)" class="pv-speed" @click="cyclePreviewSpeed">{{ previewSpeed }}x</button>
            <!-- 预览弹窗：是否需要打标 + 备注（可编辑，自动归拢到下方列表的是否打标/备注字段） -->
            <div v-if="previewMedia.id" class="pv-tag-inline">
              <button class="tp-sm pv-tp" :class="{ on: previewNeedTag === true }" @click="setPreviewNeedTag(previewNeedTag === true ? null : true)" title="需要打标（再次点击取消）"><Icon name="check" :size="12" />需要打标</button>
              <button class="tp-sm pv-tp" :class="{ on: previewNeedTag === false }" @click="setPreviewNeedTag(previewNeedTag === false ? null : false)" title="无需打标（再次点击取消）"><Icon name="close" :size="12" />无需打标</button>
            </div>
          </div>
          <!-- 预览弹窗下方：备注录入区（支撑在预览时标注，归拢到列表备注列） -->
          <div v-if="previewMedia.id" class="pv-remark">
            <label class="pv-rm-label">备注</label>
            <input
              class="pv-rm-input"
              type="text"
              :value="previewRemark"
              @input="setPreviewRemark($event.target.value)"
              @click.stop
              placeholder="请输入该素材备注…"
            />
          </div>
        </div>
      </div>
    </transition>
    <SimilarLibraryModal v-model="similarLibraryVisible" :ticket="similarLibraryTicket" @create-ticket="onCreateTicketFromSimilar" />
  </div>
</template>

<style scoped>
.s3-divider { height: 1px; background: var(--border); margin: 18px 0 14px; }
.f2-mat-preview { background: #f8faff; border: 1px solid #e0e8ff; border-radius: 10px; padding: 12px 14px; }
.f2-mat-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 10px; }
.f2-mat-head .icon { color: var(--brand); }
.f2-mat-list { display: flex; flex-wrap: wrap; gap: 8px; }
.f2-mat-item { width: 64px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.f2-mat-thumb { width: 64px; height: 64px; border-radius: 8px; overflow: hidden; background: #f0f2f6; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); }
.f2-mat-thumb video, .f2-mat-thumb img { width: 100%; height: 100%; object-fit: cover; }
.f2-mat-thumb video { object-fit: contain; background: #000; }
.f2-mat-text { font-size: 9px; line-height: 1.3; padding: 4px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.f2-mat-id { font-size: 10px; color: var(--text-4); max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.f2-mat-more .f2-mat-thumb { background: var(--brand-soft); color: var(--brand); }
.f2-mat-more strong { font-size: 16px; color: var(--brand); }
.f2-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.f2-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
.f2-gen { white-space: nowrap; }
.fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.ph { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
.ph-act { display: flex; align-items: center; gap: 14px; }
.persp { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; }
.persp button { position: relative; padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--text-2); transition: all .18s; }
.persp button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); }
.rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); position: absolute; top: 4px; right: 4px; }

.list-card { padding: 20px 24px; }
.lc-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 14px; flex-wrap: wrap; }
.seg-tabs { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; }
.seg-tabs button { position: relative; display: flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; transition: all .18s; }
.seg-tabs button.on { background: #fff; color: var(--text-1); box-shadow: var(--shadow-sm); }
.seg-tabs b { color: var(--text-4); } .seg-tabs button.on b { color: var(--brand); }
.dft-tab-btn { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; transition: all .18s; }
.dft-tab-btn:hover { background: #fff; color: var(--brand); }
.dft-tab-btn .icon { color: var(--brand); }
.search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text-3); min-width: 220px; }
.search:focus-within { border-color: var(--brand); }
.search input { flex: 1; font-size: 14px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }

/* 处理人：行业分组卡片网格 */
.ind-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.ind-card { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 18px 18px 16px; border: 1px solid var(--border); border-radius: 16px; background: #fff; text-align: left; transition: all .2s; overflow: hidden; }
.ind-card:hover { border-color: var(--brand); box-shadow: var(--shadow-md); transform: translateY(-3px); }
.ind-card:hover .ind-arrow { color: var(--brand); transform: translateX(3px); }
.ind-top { display: flex; align-items: center; gap: 12px; }
.ind-ic { width: 42px; height: 42px; border-radius: 12px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; flex-shrink: 0; }
.ind-name { flex: 1; min-width: 0; }
.ind-name strong { display: block; font-size: 15px; font-weight: 700; color: var(--text-1); }
.ind-name em { font-style: normal; font-size: 12px; color: var(--text-3); }
.ind-total { font-size: 22px; font-weight: 800; color: var(--text-1); letter-spacing: -.5px; }
.ind-stats { display: flex; gap: 8px; flex-wrap: wrap; }
.ist { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; }
.ist i { width: 7px; height: 7px; border-radius: 50%; }
.ist.pool { background: var(--orange-soft, #fff4e0); color: #c87f00; }
.ist.pool i { background: var(--orange); }
.ist.doing { background: var(--brand-soft); color: var(--brand); }
.ist.doing i { background: var(--brand); }
.ist.closed { background: var(--bg-soft); color: var(--text-3); }
.ist.closed i { background: var(--text-4); }
.ist.dim { opacity: .45; }
.ind-arrow { position: absolute; right: 16px; bottom: 16px; color: var(--text-4); transition: all .2s; }

/* 处理人：进入分组后的返回条 */
.group-bar { position: sticky; top: 112px; z-index: 90; display: flex; align-items: center; gap: 14px; margin-bottom: 14px; padding: 10px 14px; background: rgba(255,255,255,.88); backdrop-filter: blur(12px); border-radius: 12px; border: 1px solid var(--border); }
.gb-back { display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 18px; border: 1px solid var(--brand); border-radius: 10px; background: var(--brand-soft); font-size: 14px; font-weight: 600; color: var(--brand); transition: all .18s; box-shadow: 0 1px 6px rgba(79,124,255,.1); }
.gb-back:hover { background: var(--brand); color: #fff; border-color: var(--brand); transform: translateX(-2px); box-shadow: 0 3px 12px rgba(79,124,255,.25); }
.gb-cur { font-size: 14px; color: var(--text-2); display: inline-flex; align-items: center; gap: 7px; }
.gb-cur b { font-weight: 700; color: var(--text-1); }
.gb-cur i { color: var(--text-4); font-style: normal; }
.gb-count { margin-left: auto; font-size: 12px; color: var(--text-3); }

.tk-list { display: flex; flex-direction: column; gap: 10px; }
.tk-item { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; transition: all .18s; }
.tk-item:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
.tk-head { display: flex; align-items: center; gap: 14px; padding: 15px 18px; cursor: pointer; }
.tk-id { font-size: 12px; font-weight: 700; color: var(--text-3); font-family: monospace; flex-shrink: 0; }
.tk-main { flex: 1; min-width: 0; }
.tk-title { font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.tk-meta { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-3); flex-wrap: wrap; }
.tk-meta i { color: var(--text-4); }
.tk-time { font-size: 12px; color: var(--text-4); flex-shrink: 0; }
.tk-ops { display: flex; gap: 8px; flex-shrink: 0; }
.tk-arrow { color: var(--text-4); transition: transform .25s; }
.tk-arrow.open { transform: rotate(180deg); }

.tk-detail { padding: 4px 18px 18px; border-top: 1px solid var(--border); background: var(--bg-soft); }
.td-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 16px 0; }
.td-col h4 { font-size: 13px; font-weight: 700; color: var(--text-2); margin-bottom: 8px; }
.td-desc { font-size: 13px; color: var(--text-1); line-height: 1.7; }
.td-empty { font-size: 13px; color: var(--text-4); }
.td-cat { margin-top: 10px; font-size: 13px; display: flex; align-items: center; gap: 8px; color: var(--text-3); }
.td-extra { margin-top: 8px; font-size: 12px; color: var(--text-3); }
.td-imgs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.td-imgs img { width: 76px; height: 58px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
.td-timeline { padding-top: 14px; border-top: 1px dashed var(--border-strong); }
.td-timeline h4 { font-size: 13px; font-weight: 700; color: var(--text-2); margin-bottom: 12px; }
.tl { display: flex; flex-direction: column; gap: 14px; padding-left: 6px; }
.tl-node { display: flex; gap: 12px; position: relative; }
.tl-node:not(:last-child)::before { content: ''; position: absolute; left: 4px; top: 14px; bottom: -16px; width: 2px; background: var(--border-strong); }
.tl-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border-strong); margin-top: 3px; flex-shrink: 0; z-index: 1; }
.tl-dot.last { background: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.tl-body b { font-size: 13px; font-weight: 600; }
.tl-body em { display: block; font-style: normal; font-size: 12px; color: var(--text-4); margin-top: 2px; }

/* 弹窗 */
.steps { display: flex; align-items: center; gap: 0; margin-bottom: 16px; }
.step { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 500; color: var(--text-4); flex-shrink: 0; }
.step:not(:last-child)::after { content: ''; width: 90px; height: 1px; background: var(--border-strong); margin: 0 16px; flex-shrink: 0; }
.step i { width: 28px; height: 28px; border-radius: 50%; background: #f0f2f6; display: grid; place-items: center; font-size: 14px; font-weight: 700; flex-shrink: 0; }
.step.on { color: var(--brand); font-weight: 600; } .step.on i { background: var(--brand); color: #fff; }
.step.done i { background: var(--green); color: #fff; }
.ts-body label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin: 14px 0 8px; }
.req { color: var(--red); }
.fgrid, .fgrid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.fgrid .field, .fgrid2 .field, .field.full { width: 100%; }
.f2-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.f2-title { font-size: 13px; font-weight: 600; color: var(--text-2); }
.f2-done { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; font-size: 13px; font-weight: 600; color: var(--green); }
.f2-tip { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.f2-tip-txt { font-size: 12px; color: var(--text-3); font-weight: 500; display: inline-flex; align-items: center; gap: 5px; }
.f2-confirm { padding: 0 16px; }
.f2-confirmed { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 600; color: var(--green); }
.f2-gen { padding: 0 14px; }

/* step2 字段：字体与方块形状对齐设计稿 */
.f2-step .f2-title { font-size: 14px; font-weight: 500; color: var(--text-1); }
.f2-step label { font-size: 13px; font-weight: 500; color: var(--text-3); margin: 16px 0 8px; }
.f2-step .fgrid { gap: 16px 22px; }
.f2-step .field {
  height: 46px; padding: 0 16px;
  border: 1px solid var(--border); border-radius: 12px;
  background: #fbfbfd; font-size: 14px; font-weight: 500; color: var(--text-1);
}
.f2-step .field:hover { border-color: var(--border-strong); }
.f2-step .field:focus { background: #fff; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.f2-step .field::placeholder { color: var(--text-4); font-weight: 400; }
.f2-step select.field { background-position: right 14px center; }
.foot-left { margin-right: auto; }
.more-src { margin-top: 16px; font-size: 12px; color: var(--text-3); }
.more-src a { color: var(--brand); font-weight: 600; cursor: pointer; }
.more-src a:hover { text-decoration: underline; }
.more-src i { color: var(--text-4); margin: 0 8px; font-style: normal; }
.field.ta { width: 100%; height: 100px; padding: 12px 14px; resize: none; line-height: 1.6; border: 1px solid var(--border-strong); background: #fff; border-radius: 10px; }
.field.ta:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); outline: none; }
.urg { display: flex; gap: 10px; }
.urg button { flex: 1; height: 44px; border: 1.5px solid var(--border-strong); border-radius: 11px; font-size: 14px; color: var(--text-2); transition: all .15s; font-weight: 500; }
.urg button:hover { border-color: var(--brand); }
.urg button.on.red { border-color: var(--red); background: var(--red-soft); color: var(--red); font-weight: 700; }
.urg button.on.orange { border-color: var(--orange); background: var(--orange-soft); color: #c87f00; font-weight: 700; }
.urg button.on.gray { border-color: var(--text-3); background: #f0f2f6; color: var(--text-2); font-weight: 700; }

/* step2 引导空态 */
.f2-guide { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 38px 24px 30px; }
.f2-guide-ic { width: 76px; height: 76px; border-radius: 22px; background: var(--brand-grad, linear-gradient(135deg,#4f7cff,#7c6df0)); color: #fff; display: grid; place-items: center; box-shadow: 0 10px 28px rgba(79,124,255,.28); margin-bottom: 18px; }
.f2-guide strong { font-size: 18px; font-weight: 700; color: var(--text-1); }
.f2-guide em { font-style: normal; font-size: 13px; color: var(--text-3); line-height: 1.7; max-width: 440px; margin: 10px 0 22px; }
.f2-guide-btn { padding: 0 22px; height: 42px; font-size: 14px; }

/* 标签 ID 字段（ID 为主，标签名小字在下方） */
.fld-tag { display: flex; flex-direction: column; }
.tag-id-input { font-size: 16px; font-weight: 700; color: var(--text-1); }
.tag-name-input { margin-top: 8px; font-size: 12px; color: var(--text-3); height: 32px; }

/* 问题分类按钮组 */
.cat-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.cat-chip { padding: 9px 16px; border: 1.5px solid var(--border-strong); border-radius: 999px; font-size: 13px; color: var(--text-2); background: #fff; transition: all .15s; }
.cat-chip:hover { border-color: var(--brand); color: var(--brand); }
.cat-chip.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.fblock { margin-top: 4px; }
.s3-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px; align-items: start; }
.lb-opt { font-style: normal; font-weight: 400; color: var(--text-4); }
.sample-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.sc { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px 5px 11px; background: var(--brand-soft); color: var(--brand); border-radius: 8px; font-size: 12px; font-weight: 600; }
.sc i { cursor: pointer; display: grid; place-items: center; width: 15px; height: 15px; border-radius: 4px; }
.sc i:hover { background: var(--brand); color: #fff; }
.confirm .cf-row { display: flex; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.confirm .cf-row span { width: 110px; color: var(--text-3); flex-shrink: 0; }
.confirm .cf-row b { font-weight: 600; }
.confirm .cf-row.col { flex-direction: column; gap: 6px; } .confirm .cf-row.col p { color: var(--text-1); line-height: 1.6; }

.s1-wrap { display: flex; flex-direction: column; justify-content: center; min-height: calc(78vh - 170px); padding: 4px 0; gap: 16px; }
.dft-cnt { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-left: 6px; padding: 0 5px; font-size: 11px; font-weight: 700; color: #fff; background: var(--brand); border-radius: 999px; }
.draft-box { display: flex; flex-direction: column; gap: 14px; }
.draft-tip { font-size: 13px; color: var(--text-3); line-height: 1.6; background: var(--brand-soft); border-radius: 10px; padding: 10px 12px; margin: 0; }
.draft-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.draft-item { display: flex; align-items: stretch; gap: 10px; border: 1.5px solid var(--border); border-radius: 12px; background: #fff; overflow: hidden; transition: border-color .18s, box-shadow .18s; }
.draft-item:hover { border-color: var(--brand); box-shadow: var(--shadow-md); }
.draft-main { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 13px 14px; background: none; border: none; text-align: left; cursor: pointer; }
.draft-sum { font-size: 14px; font-weight: 600; color: var(--text-1); line-height: 1.4; }
.draft-meta { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-3); }
.draft-step { color: var(--brand); font-weight: 600; }
.draft-del { flex-shrink: 0; width: 44px; border: none; background: #fff; color: var(--text-3); cursor: pointer; transition: background .18s, color .18s; border-left: 1px solid var(--border); }
.draft-del:hover { background: #fef2f2; color: #dc2626; }
.draft-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 12px; padding: 30px 20px; color: var(--text-3); }
.draft-empty p { font-size: 13px; margin: 0; line-height: 1.6; max-width: 360px; }
.s1-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 12px 0; }
.s1-ic { width: 96px; height: 96px; border-radius: 24px; background: linear-gradient(135deg, var(--brand-soft), #eef2ff); color: var(--brand); display: grid; place-items: center; margin-bottom: 20px; }
.s1-empty strong { font-size: 20px; font-weight: 700; color: var(--text-1); }
.s1-empty em { font-style: normal; font-size: 14px; color: var(--text-3); margin-top: 10px; }
.goto-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 16px; }
.goto-card { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 22px 18px; border: 1.5px dashed var(--border-strong); border-radius: 14px; background: #fff; transition: all .2s; }
.goto-card:hover { border-color: var(--brand); border-style: solid; box-shadow: var(--shadow-md); transform: translateY(-2px); }
.gc-ic { width: 56px; height: 56px; border-radius: 14px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; flex-shrink: 0; }
.goto-card strong { display: block; font-size: 16px; font-weight: 700; color: var(--text-1); }
.goto-card em { font-style: normal; font-size: 13px; color: var(--text-3); }
.sel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.sel-head span { font-size: 14px; font-weight: 600; color: var(--text-2); }
.btn-xs { padding: 4px 10px; font-size: 12px; }
.sel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
.cluster-ticket-list { display: flex; flex-direction: column; gap: 16px; }
.cluster-ticket-card { border: 1.5px solid var(--brand); border-radius: 16px; background: var(--brand-soft); overflow: hidden; }
.ctc-hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px; background: rgba(138,43,226,.08); border-bottom: 1px solid rgba(138,43,226,.18); }
.ctc-cluster { font-size: 14px; font-weight: 800; color: var(--brand); font-variant-numeric: tabular-nums; }
.ctc-tag { font-size: 10px; font-weight: 700; color: #fff; background: var(--brand); padding: 2px 7px; border-radius: 6px; flex-shrink: 0; }
.ctc-feature { flex: 1; font-size: 12px; line-height: 1.5; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctc-rm { flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: var(--text-3); cursor: pointer; transition: all .15s; }
.ctc-rm:hover { background: rgba(220,38,38,.12); color: var(--red); }
.ctc-grid { padding: 14px; background: #fff; }
.s1-subhd { display: flex; align-items: center; gap: 7px; margin: 18px 0 4px; font-size: 13px; font-weight: 700; color: var(--text-2); }
.sel-card { position: relative; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; transition: all .18s; background: #fff; }
.sel-card:hover { border-color: var(--brand); box-shadow: var(--shadow-md); transform: translateY(-2px); }
.sc-thumb { height: 110px; background: linear-gradient(135deg, var(--bg-soft), #eef1f6); display: grid; place-items: center; color: var(--text-4); position: relative; }
.sc-thumb.vid { background: linear-gradient(135deg, #2a2d3a, #1a1d2e); color: rgba(255,255,255,.5); }
.sc-thumb.text-type { display: block; place-items: unset; }
.sc-text-preview { padding: 28px 10px 10px; font-size: 12px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.sc-link-preview { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--brand); text-decoration: none; font-size: 11px; width: 100%; height: 100%; }
.sc-watermark { position: absolute; left: 8px; top: 8px; font-size: 11px; font-weight: 700; color: var(--text-3); background: rgba(255,255,255,.85); padding: 2px 7px; border-radius: 6px; }
.sc-type-badge { position: absolute; right: 8px; top: 8px; font-size: 11px; font-weight: 700; color: #fff; background: var(--brand); padding: 2px 8px; border-radius: 6px; }
.sc-thumb.vid .sc-type-badge { background: #e84393; }
.sc-id { display: flex; align-items: center; gap: 6px; padding: 10px 12px; font-size: 13px; font-weight: 700; color: var(--text-1); }
.sc-tag { font-size: 10px; font-weight: 600; color: var(--brand); background: var(--brand-soft); padding: 2px 6px; border-radius: 5px; flex-shrink: 0; }
.sc-rm { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,.45); color: #fff; display: grid; place-items: center; cursor: pointer; transition: all .18s; }
.sc-rm:hover { background: var(--red); transform: scale(1.1); }

.hd-readonly { background: var(--bg-soft); border-radius: 12px; padding: 14px 16px; }
.hd-readonly h4 { font-size: 13px; font-weight: 700; color: var(--text-2); margin-bottom: 8px; }
.hd-readonly p { font-size: 13px; color: var(--text-1); line-height: 1.6; }
.hd-tags { display: flex; gap: 6px; margin-top: 10px; }
.hd-body label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin: 14px 0 8px; }
.need-tag { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; }
.need-tag.on { color: var(--brand); font-weight: 600; }
.need-tag .ck { width: 18px; height: 18px; border-radius: 6px; border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: #fff; }
.need-tag.on .ck { background: var(--brand); border-color: var(--brand); }

.cat-pick { display: flex; flex-direction: column; gap: 10px; }
.cp { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1.5px solid var(--border); border-radius: 12px; font-size: 14px; color: var(--text-1); text-align: left; transition: all .18s; }
.cp:hover { border-color: var(--brand); }
.cp.on { border-color: var(--brand); background: var(--brand-soft); font-weight: 600; }
@media (max-width: 800px) { .td-grid, .fgrid, .fgrid2, .s3-row { grid-template-columns: 1fr; } }

.hd-rich { display: flex; flex-direction: column; gap: 16px; }
.hd-title-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px; border-radius: 16px; background: linear-gradient(135deg, var(--brand-soft), #f8faff); border: 1px solid #dfe7ff; }
.htc-main { min-width: 0; }
.hd-kicker { display: block; font-size: 12px; font-weight: 600; color: var(--brand); margin-bottom: 6px; }
.hd-title-card strong { font-size: 18px; font-weight: 800; color: var(--text-1); }
.hd-info-grid { display: none; }
.hd-info { display: none; }
.hd-meta-tags { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 2px; }
.urg-txt-red { color: var(--red); }
.urg-txt-orange { color: #d97706; }
.urg-txt-gray { color: var(--text-2); }
/* 紧凑问题分类（单行） */
.hd-cat-inline { display: flex; align-items: center; gap: 10px; }
.hd-cat-inline label { font-size: 13px; font-weight: 700; color: var(--text-2); white-space: nowrap; margin: 0; }
.hd-cat-inline .cat-select { width: auto; flex: 0 1 auto; min-width: 160px; height: 34px; font-size: 13px; }
.hcs-changed { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700; color: var(--brand); background: var(--brand-soft); padding: 3px 9px; border-radius: 8px; white-space: nowrap; flex-shrink: 0; }
.hcs-note { margin-top: 8px; font-size: 12px; color: var(--text-4); line-height: 1.6; }
.cat-select {
  width: 100%;
  height: 40px;
  padding: 0 36px 0 14px;
  border: 1.5px solid var(--border-strong);
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  background: #fff url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E") no-repeat right 12px center;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  cursor: pointer;
  transition: all .18s;
}
.cat-select:hover { border-color: var(--brand); }
.cat-select:focus { border-color: var(--brand); outline: none; box-shadow: 0 0 0 3px var(--brand-soft); }
.hd-section { padding: 16px; border: 1px solid var(--border); border-radius: 14px; background: #fff; }
.hd-section label { display: block; font-size: 13px; font-weight: 700; color: var(--text-2); margin: 0 0 10px; }
.hd-desc { font-size: 13px; line-height: 1.7; color: var(--text-1); margin-bottom: 12px; }
.hd-materials { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hm-count { font-size: 12px; font-weight: 700; color: var(--brand); background: var(--brand-soft); padding: 5px 9px; border-radius: 8px; }
.hm-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; }
.hm-more { font-size: 12px; color: var(--text-3); }
/* 处理弹窗：已关联素材缩略图网格（与提需工单内容联动） */
.hm-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: var(--text-2); margin: 14px 0 12px; }
.hm-head .icon { color: var(--brand); }
.hm-head em { font-style: normal; color: var(--text-3); font-weight: 600; }
.hm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.hm-card { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: #fff; transition: all .18s; }
.hm-card:hover { border-color: var(--brand); box-shadow: var(--shadow-sm); transform: translateY(-2px); }
.hm-thumb { position: relative; height: 90px; display: grid; place-items: center; color: var(--text-4); background: linear-gradient(135deg, var(--bg-soft), #eef1f6); }
.hm-thumb img, .hm-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.hm-thumb.vid { background: linear-gradient(135deg, #2a2d3a, #1a1d2e); color: rgba(255,255,255,.5); }
.hm-thumb.text-type { display: block; place-items: unset; }
.hm-text-preview { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--text-2); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.hm-link-preview { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--brand); text-decoration: none; font-size: 11px; width: 100%; height: 100%; }
.hm-mat-fallback { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); text-decoration: none; }
.hm-mat-fallback:hover { color: var(--brand); }
.hm-thumb.vid .hm-type { background: #e84393; }
.hm-id { padding: 8px 10px; font-size: 12px; font-weight: 700; color: var(--text-1); }
.hm-rest .hm-restthumb { flex-direction: column; gap: 2px; color: var(--text-3); background: var(--bg-soft); }
.hm-restthumb strong { font-size: 18px; font-weight: 800; color: var(--text-2); }
.hm-restthumb span { font-size: 11px; }
.hm-empty { font-size: 13px; color: var(--text-4); padding: 8px 0; }
/* 逐条素材顺序查看器 */
.hm-sequential { border: 1px solid var(--border); border-radius: 14px; background: var(--bg-soft); padding: 16px; }
.hm-seq-nav { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 14px; }
.hm-seq-prev, .hm-seq-next { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border-strong); background: #fff; color: var(--text-2); display: grid; place-items: center; cursor: pointer; transition: all .15s; }
.hm-seq-prev:hover:not(:disabled), .hm-seq-next:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.hm-seq-prev:disabled, .hm-seq-next:disabled { opacity: .3; cursor: not-allowed; }
.hm-seq-counter { font-size: 14px; font-weight: 700; color: var(--text-1); min-width: 60px; text-align: center; }
.hm-seq-viewer { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.hm-seq-media { display: flex; align-items: center; justify-content: center; min-height: 180px; margin-bottom: 12px; background: #0e1118; border-radius: 10px; overflow: hidden; }
.hm-seq-media video, .hm-seq-media img { max-width: 100%; max-height: 320px; object-fit: contain; }
.hm-seq-media .hm-text-preview { padding: 16px; font-size: 13px; line-height: 1.7; color: var(--text-2); max-height: 200px; overflow: auto; width: 100%; }
.hm-seq-media .hm-link-preview { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 24px; color: var(--brand); text-decoration: none; font-size: 14px; }
.hm-seq-info { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.hm-seq-id { font-size: 13px; font-weight: 700; color: var(--text-1); }
.hm-seq-tag-row { margin-bottom: 12px; }
.hm-seq-label { display: block; font-size: 12px; font-weight: 700; color: var(--text-3); margin-bottom: 6px; }
.hm-seq-conc-row { margin-bottom: 4px; }
.hm-seq-conc { min-height: 70px; resize: vertical; }
.hm-seq-hint { text-align: center; margin-top: 10px; font-size: 11px; color: var(--text-4); display: flex; align-items: center; justify-content: center; gap: 4px; }
.hd-conclusion { min-height: 126px; }
.hd-remark { height: 80px; }
.img-tools { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.img-tools span { font-size: 12px; color: var(--text-4); }
.img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-top: 12px; }
.img-card { position: relative; height: 76px; border-radius: 11px; overflow: hidden; border: 1px solid var(--border); background: var(--bg-soft); }
.img-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
.img-card button { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,.48); color: #fff; display: grid; place-items: center; }
.img-card button:hover { background: var(--red); }
/* 是否打标选择（紧凑内联） */
.hd-inline-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 14px; }
.hd-il-label { font-size: 13px; font-weight: 700; color: var(--text-2); white-space: nowrap; line-height: 32px; flex-shrink: 0; }
.tag-pick-sm { display: flex; gap: 8px; flex: 1; }
.tp-sm { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 14px; border: 1.5px solid var(--border-strong); border-radius: 9px; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: all .15s; background: #fff; white-space: nowrap; }
.tp-sm:hover { border-color: var(--brand); color: var(--brand); }
.tp-sm.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.hd-inline-row .hd-remark { flex: 1; min-height: 60px; }

/* 处理弹窗：编号分区标题（对齐沉淀库风格） */
.sec-title { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; margin: 0 0 12px; color: var(--text-1); }
.sec-title .n { width: 22px; height: 22px; border-radius: 7px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; font-size: 12px; font-weight: 800; flex-shrink: 0; }
.hd-sub-sec { margin-bottom: 14px; }
.hd-sub-sec:last-child { margin-bottom: 0; }
.hd-sub-sec label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0 0 8px; }

/* 处理弹窗：素材标题改用沉淀库风格 */
.hd-section .rm-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-3); margin: 14px 0 10px; }
.hd-section .rm-head .icon { color: var(--brand); }
.hd-section .rm-head em { font-style: normal; color: var(--text-3); font-weight: 600; }

/* 工单展开详情：沉淀风格编号分区 */
.tk-detail { padding: 4px 18px 18px; border-top: 1px solid var(--border); background: var(--bg-soft); }
.td-tags { display: flex; flex-wrap: wrap; gap: 7px; margin: 16px 0 18px; }
.td-sec { margin-bottom: 18px; }
.td-sec:last-child { margin-bottom: 0; }
.td-sec > h4 { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; margin-bottom: 9px; color: var(--text-1); }
.td-sec > h4 .n { width: 22px; height: 22px; border-radius: 7px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; font-size: 12px; font-weight: 800; flex-shrink: 0; }
.td-sec > p { font-size: 13px; color: var(--text-1); line-height: 1.8; padding-left: 31px; }
.td-sec > p.none { color: var(--text-4); }
.td-tip { display: flex; align-items: center; gap: 6px; margin: 10px 0 0 31px; padding: 8px 12px; font-size: 12px; color: #b67400; background: #fff8ec; border: 1px solid #ffe6bf; border-radius: 9px; }
.td-info { padding-left: 31px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.td-info > div { display: flex; flex-direction: column; gap: 4px; }
.td-info span { font-size: 12px; color: var(--text-3); }
.td-info b { font-size: 13px; color: var(--text-1); font-weight: 600; }
.td-extra { margin-top: 8px; font-size: 12px; color: var(--text-3); padding-left: 31px; display: flex; gap: 6px; }
.td-ext-label { color: var(--text-4); flex-shrink: 0; }
.td-ext-val { color: var(--text-2); }
.td-imgs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; padding-left: 31px; }
.td-imgs img { width: 76px; height: 58px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }

/* 工单详情：已关联素材（沉淀风格缩略图） */
.td-materials { padding-left: 31px; margin-top: 12px; }
.td-mat-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 10px; }
.td-mat-head .icon { color: var(--brand); }
.td-mat-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.td-mat-item { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.td-mat-thumb { position: relative; width: 84px; height: 60px; border-radius: 9px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-4); }
.td-mat-thumb img, .td-mat-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.td-mat-thumb.vid { background: linear-gradient(135deg, #2a2d3a, #1a1d2e); color: rgba(255,255,255,.5); }
.td-mat-thumb.text-type { width: 150px; height: 60px; display: block; place-items: unset; }
.td-mat-text-preview { padding: 6px 8px; font-size: 11px; line-height: 1.5; color: var(--text-2); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.td-mat-fallback { display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 10px; color: var(--text-3); text-decoration: none; }
.td-mat-fallback:hover { color: var(--brand); }
.td-mat-id { font-size: 11px; color: var(--text-4); font-family: monospace; }
.td-mat-meta { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; max-width: 150px; }
.td-mat-meta span { font-size: 10px; color: var(--text-4); font-family: monospace; background: var(--bg-soft); padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
.td-mat-rest .td-mat-restthumb { flex-direction: column; gap: 2px; color: var(--text-3); background: var(--bg-soft); }
.td-mat-restthumb strong { font-size: 16px; font-weight: 800; color: var(--text-2); }
.td-mat-restthumb span { font-size: 10px; }

/* 工单详情：时间线（沉淀风格） */
.td-timeline { padding-top: 0; border-top: none; }
.td-timeline .tl { padding-left: 31px; }

/* 退回工单弹窗 */
.rj-body { display: flex; flex-direction: column; gap: 10px; }
.rj-ticket { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: linear-gradient(135deg, var(--brand-soft), #f8faff); border: 1px solid #dfe7ff; }
.rj-id { font-size: 14px; font-weight: 800; color: var(--brand); }
.rj-title { font-size: 14px; color: var(--text-1); font-weight: 600; }
.rj-tip { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; color: var(--text-3); line-height: 1.6; background: var(--bg-soft); padding: 10px 14px; border-radius: 10px; }
.rj-tip .icon { color: var(--brand); flex-shrink: 0; margin-top: 1px; }
.rj-body label { display: block; font-size: 13px; font-weight: 700; color: var(--text-2); margin-top: 4px; }
.rj-reason { min-height: 100px; }

/* 采纳弹窗增强 */
.adopt-body { display: flex; flex-direction: column; gap: 18px; }
.adopt-info-card { padding: 16px 18px; border-radius: 14px; background: linear-gradient(135deg, var(--brand-soft), #f8faff); border: 1px solid #dfe7ff; }
.aic-top { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
.aic-title { font-size: 16px; font-weight: 800; color: var(--text-1); line-height: 1.5; }
.adopt-sec { display: flex; flex-direction: column; gap: 10px; }
.adopt-sec h4 { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 700; color: var(--text-2); }
.adopt-sec .n { width: 22px; height: 22px; border-radius: 7px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; font-size: 12px; font-weight: 800; }
.adopt-conc { font-size: 13px; color: var(--text-1); line-height: 1.8; padding-left: 31px; }
.adopt-qual { padding-left: 31px; }
.adopt-remark { display: flex; align-items: flex-start; gap: 6px; padding: 10px 14px; margin-left: 31px; font-size: 12px; color: var(--text-3); line-height: 1.6; background: var(--bg-soft); border-radius: 10px; }
.adopt-remark .icon { color: var(--brand); flex-shrink: 0; margin-top: 1px; }
.ad-tip { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: #b67400; background: #fff8ec; border: 1px solid #ffe6bf; border-radius: 9px; padding: 8px 12px; line-height: 1.6; }
.ad-tip .icon { color: #f5a000; flex-shrink: 0; margin-top: 1px; }
.adopt-body .cat-pick { padding-left: 0; }

/* 采纳弹窗：结果类型选择器 */
.rt-pick { display: flex; flex-direction: column; gap: 10px; }
.rt-card { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border: 1.5px solid var(--border); border-radius: 14px; background: #fff; text-align: left; cursor: pointer; transition: all .18s; }
.rt-card:hover { border-color: var(--brand); box-shadow: var(--shadow-sm); }
.rt-card.on { border-color: var(--brand); background: var(--brand-soft); }
.rt-ic { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0; }
.rt-ic-red { background: var(--red-soft, #fdeced); color: var(--red); }
.rt-ic-green { background: var(--green-soft, #e6f7ef); color: var(--green); }
.rt-text { flex: 1; min-width: 0; }
.rt-text strong { display: block; font-size: 15px; font-weight: 700; color: var(--text-1); }
.rt-text em { font-style: normal; font-size: 12px; color: var(--text-3); margin-top: 3px; }
.rt-ck { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: #fff; flex-shrink: 0; }
.rt-card.on .rt-ck { background: var(--brand); border-color: var(--brand); }

/* 删除工单：操作按钮 + 确认弹窗 */
.btn-danger-outline { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; height: 32px; border: 1px solid #fecaca; background: #fff; color: #dc2626; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-danger-outline:hover { background: #fef2f2; border-color: #fca5a5; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(220,38,38,.12); }
.btn-danger { display: inline-flex; align-items: center; gap: 6px; padding: 0 18px; height: 34px; border: none; background: #dc2626; color: #fff; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-danger:hover { background: #b91c1c; transform: translateY(-1px); }
.btn-danger:disabled, .btn-danger-outline:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.del-body { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 6px 0 4px; }
.del-ic { width: 60px; height: 60px; border-radius: 18px; background: #fef2f2; color: #dc2626; display: grid; place-items: center; margin-bottom: 6px; }
.del-warn { font-size: 14px; color: var(--text-1); line-height: 1.7; }
.del-warn b { color: #dc2626; font-weight: 700; }
.del-tip { font-size: 12.5px; color: var(--text-4); line-height: 1.6; }

/* 可点击缩略图通用样式 */
.td-mat-thumb.clickable, .hm-thumb.clickable, .sc-thumb.clickable { cursor: pointer; position: relative; }
.td-mat-thumb.clickable:hover, .hm-thumb.clickable:hover, .sc-thumb.clickable:hover { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.td-mat-thumb.clickable video, .hm-thumb.clickable video, .sc-thumb.clickable video { pointer-events: none; }

/* 缩略图上的预览提示图标 */
.td-mat-zoom, .hm-zoom, .sc-zoom { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 6px; background: rgba(20,24,34,.55); color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .15s; backdrop-filter: blur(4px); }
.td-mat-thumb.clickable:hover .td-mat-zoom, .hm-thumb.clickable:hover .hm-zoom, .sc-thumb.clickable:hover .sc-zoom { opacity: 1; }

/* 媒体预览弹窗 */
.pv-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(8,12,20,.82); backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 32px; }
.pv-modal { position: relative; width: 100%; max-width: 800px; max-height: 90vh; background: #fff; border-radius: 18px; box-shadow: 0 24px 80px rgba(15,22,36,.3); overflow: hidden; display: flex; flex-direction: column; }
.pv-close { position: absolute; top: 14px; right: 14px; z-index: 10; width: 36px; height: 36px; border-radius: 10px; background: rgba(20,24,34,.55); border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 14px rgba(0,0,0,.25); display: grid; place-items: center; color: #fff; cursor: pointer; transition: all .15s; backdrop-filter: blur(4px); }
.pv-close:hover { background: #ff4d4f; border-color: #ff4d4f; transform: scale(1.06); }
.pv-media { width: 100%; flex: 1; min-height: 0; background: #0e1118; display: flex; align-items: center; justify-content: center; }
.pv-media video { max-width: 100%; max-height: 70vh; object-fit: contain; }
.pv-media img { max-width: 100%; max-height: 70vh; object-fit: contain; }
.pv-fallback { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #fff; font-size: 14px; padding: 40px; }

/* 预览弹窗：文本素材（非媒体URL） */
.pv-text-preview { display: flex; flex-direction: column; align-items: center; gap: 16px; color: #fff; padding: 32px; width: 100%; max-height: 70vh; overflow-y: auto; }
.pv-fallback-link { display: inline-flex; align-items: center; gap: 6px; color: #8b5cf6; text-decoration: none; font-size: 14px; padding: 8px 16px; border: 1px solid #8b5cf6; border-radius: 6px; transition: background .15s; }
.pv-fallback-link:hover { background: rgba(139,92,246,0.1); }
.pv-text-link { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; background: var(--brand); color: #fff; border-radius: 10px; font-size: 14px; font-weight: 600; text-decoration: none; transition: all .15s; }
.pv-text-link:hover { background: var(--brand-dark, #4f46e5); }
.pv-text-body { width: 100%; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 20px 24px; font-size: 14px; line-height: 1.8; color: rgba(255,255,255,.85); white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow-y: auto; }
.pv-text-empty { font-size: 14px; color: rgba(255,255,255,.4); padding: 60px 0; }
.pv-bar { display: flex; align-items: center; gap: 12px; padding: 12px 18px; background: #fff; border-top: 1px solid var(--border); }
.pv-id { font-size: 13px; font-weight: 600; color: var(--text-2); font-family: monospace; }
.pv-type { font-size: 12px; color: var(--text-3); background: var(--bg-soft); padding: 3px 8px; border-radius: 6px; }
.pv-counter { font-size: 12px; color: var(--text-3); background: var(--bg-soft); padding: 3px 8px; border-radius: 6px; font-weight: 500; }
.pv-speed { margin-left: auto; padding: 5px 14px; border-radius: 8px; background: var(--brand-soft); color: var(--brand); font-size: 13px; font-weight: 700; border: 1px solid var(--brand-soft); cursor: pointer; transition: all .15s; }
.pv-speed:hover { background: var(--brand); color: #fff; }
/* 预览弹窗：打标按钮 */
.pv-tag-inline { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.pv-tp { height: 28px; padding: 0 10px; font-size: 11px; border-radius: 7px; }
/* 预览弹窗：下方备注录入区（支撑预览时标注，归拢到列表备注列） */
.pv-remark { display: flex; align-items: center; gap: 10px; padding: 10px 18px 14px; background: #fff; border-top: 1px solid var(--border); }
.pv-rm-label { flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--text-3); }
.pv-rm-input { flex: 1; height: 34px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 13px; color: var(--text-1); background: var(--bg-soft); transition: all .15s; }
.pv-rm-input:focus { outline: none; border-color: var(--brand); background: #fff; box-shadow: 0 0 0 3px var(--brand-soft); }
.pv-rm-input::placeholder { color: var(--text-4); }

/* 预览弹窗：左右切换导航箭头 */
.pv-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 10; width: 44px; height: 44px; border-radius: 50%; background: rgba(20,24,34,.55); border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 14px rgba(0,0,0,.25); display: grid; place-items: center; color: #fff; cursor: pointer; transition: all .15s; backdrop-filter: blur(4px); }
.pv-nav:hover { background: var(--brand); border-color: var(--brand); transform: translateY(-50%) scale(1.08); }
.pv-prev { left: 16px; }
.pv-next { right: 16px; }

/* fade-scale 过渡 */
.fade-scale-enter-active, .fade-scale-leave-active { transition: all .2s ease; }
.fade-scale-enter-from, .fade-scale-leave-to { opacity: 0; transform: scale(.94); }

/* 专家结论：内联编辑 */
.inline-edit-btn { margin-left: auto; padding: 3px 10px; font-size: 12px; }
.inline-edit-area { padding-left: 31px; display: flex; flex-direction: column; gap: 6px; }
.iel-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin: 10px 0 6px; }
.iel-img-count { font-weight: 400; color: var(--text-4); margin-left: 4px; }
.iel-conclusion { min-height: 100px; }
.iel-remark { min-height: 60px; }
.iel-cat-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.iel-cat-row .iel-label { margin: 0; white-space: nowrap; }
.iel-cat { width: auto; flex: 0 1 auto; min-width: 160px; height: 34px; font-size: 13px; }
.iel-dropzone { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; border: 1.5px dashed var(--border-strong); border-radius: 10px; background: #fbfbfd; font-size: 12px; color: var(--text-3); cursor: pointer; transition: all .18s; }
.iel-dropzone:hover { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.iel-dropzone.drag { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); border-style: solid; }
.iel-img-grid { margin-top: 10px; }
.iel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }

/* 通知对象 chip 输入 */
.notify-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: #fff; min-height: 38px; }
.notify-chips--suggest { position: relative; }
.notify-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 10px; background: var(--brand-soft); color: var(--brand); border-radius: 6px; font-size: 13px; font-weight: 500; }
.chip-x { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; color: var(--text-3); cursor: pointer; border: none; background: transparent; transition: all .12s; }
.chip-x:hover { color: #fff; background: var(--brand); }
.notify-input { flex: 1; min-width: 160px; border: none !important; background: transparent !important; box-shadow: none !important; padding: 4px 0 !important; height: 28px; }
.notify-input:focus { border: none !important; box-shadow: none !important; }
/* 通知对象搜索联想下拉 */
.notify-dropdown { position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px; background: #fff; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(15,22,36,.14); z-index: 100; max-height: 240px; overflow-y: auto; }
.notify-dropdown-item { display: flex; align-items: center; gap: 10px; padding: 8px 14px; cursor: pointer; transition: background .12s; font-size: 13px; }
.notify-dropdown-item:hover { background: var(--brand-soft); }
.nd-avatar { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; background: var(--bg-soft); }
.nd-name { color: var(--text-1); font-weight: 500; }

/* ===== Phase 4: 工单关联素材表格 ===== */
.td-mat-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: #fff; }
.td-mat-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 1400px; }
.td-mat-table thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--brand); color: #fff; font-weight: 600; font-size: 11px;
  padding: 9px 10px; text-align: left; white-space: nowrap;
  border-right: 1px solid rgba(255,255,255,.15);
}
.td-mat-table thead th:last-child { border-right: none; }
.td-mat-table tbody td {
  padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle;
  white-space: nowrap; text-align: left;
}
.td-mat-table tbody tr { cursor: pointer; transition: background .1s; }
.td-mat-table tbody tr:hover { background: var(--brand-soft); }
.td-mat-table tbody tr:last-child td { border-bottom: none; }

/* 颜色标注：行级状态 */
.mat-row-consistent { border-left: 3px solid #f97316; }
.mat-row-fp { border-left: 3px solid #ef4444; }
.mat-row-revised { border-left: 3px solid #3b82f6; }
.mat-row-pending { border-left: 3px solid #94a3b8; }
.mat-row-remarked { border-left: 3px solid #a855f7; }

/* 素材列表：是否打标 / 备注 行内编辑（与预览弹窗标注联动） */
.nt-edit { display: flex; align-items: center; gap: 3px; justify-content: center; }
.col-remark { min-width: 150px; }
.rm-input { width: 100%; height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; font-size: 12px; color: var(--text-1); background: transparent; transition: all .15s; }
.rm-input:hover { border-color: var(--border-strong); background: #fff; }
.rm-input:focus { outline: none; border-color: var(--brand); background: #fff; box-shadow: 0 0 0 3px var(--brand-soft); }
.rm-input::placeholder { color: var(--text-4); }

/* 元素列：固定列 */
.sticky-col { position: sticky; left: 0; z-index: 1; background: #fff; }
.td-mat-table thead .sticky-col { z-index: 3; }
.td-mat-table tbody tr:hover .sticky-col { background: var(--brand-soft); }

/* 元素缩略图 */
.ce-thumb { position: relative; width: 90px; height: 60px; border-radius: 8px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-4); cursor: pointer; }
.ce-thumb img, .ce-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.ce-thumb .ce-text-preview { padding: 4px 6px; font-size: 10px; line-height: 1.4; color: var(--text-2); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.ce-thumb .ce-type { font-size: 10px; color: var(--text-4); }
.ce-zoom { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border-radius: 4px; background: rgba(0,0,0,.45); color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .15s; }
.ce-thumb:hover .ce-zoom { opacity: 1; }
.ce-fallback { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; color: var(--brand); text-decoration: none; padding: 4px; }
.ce-fallback:hover { background: var(--brand-soft); border-radius: 4px; }

/* 列样式 */
.col-idx { width: 36px; text-align: center !important; color: var(--text-4); font-weight: 600; }
.col-element { width: 100px; }
.col-mono { font-family: monospace; font-size: 11px; }
.col-text { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
.col-fp { color: var(--text-3); cursor: pointer; }

/* 机审标签颜色 */
.badge-orange-tag { color: #f97316; background: #fff7ed; border: 1px solid #fed7aa; font-family: monospace; font-size: 11px; padding: 2px 6px; border-radius: 4px; }

/* 展开按钮区域 */
.td-mat-expand { text-align: center; padding: 10px 0; border-top: 1px solid var(--border); background: var(--bg-soft); border-radius: 0 0 12px 12px; }

/* 表格内打标按钮 和 备注输入 */
.tag-pick-td { display: flex; gap: 2px; }
.tag-pick-td .tp-sm { height: 24px; padding: 0 6px; font-size: 10px; border-radius: 5px; }
/* 打标按钮：缩小一档（用户反馈按钮太大）；通用，表格与预览弹窗均生效 */
.tp-sm.tp-mini { height: 20px; padding: 0 5px; font-size: 9px; border-radius: 4px; gap: 2px; border-width: 1px; }
.remark-td {
  width: 100px; padding: 4px 6px; font-size: 11px;
  border: 1px solid var(--border); border-radius: 6px;
  background: #fff; color: var(--text-1);
  transition: border-color .15s;
}
.remark-td:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.remark-td::placeholder { color: var(--text-4); }
</style>