<script setup>
import { ref, computed, watch, reactive, nextTick, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useTicketFlowStore } from '../../stores/ticketFlow'
import { materialApi, tagApi, tragApi, classifyUploadApi } from '../../api'
import Icon from '../../components/Icon.vue'
import EmptyState from '../../components/EmptyState.vue'
import TragSearchModal from '../../components/TragSearchModal.vue'
import MaterialAnnotations from '../../components/MaterialAnnotations.vue'
import { scriptClassify } from './scriptClassify'
import { usePersistedRef } from '../../utils/usePersistedRef'

const props = defineProps({ samples: Array, loadedTag: Object, dataSource: { type: String, default: 'platform' }, shareMode: { type: Boolean, default: false } })
const emit = defineEmits(['update:shareMode'])
const toast = useToastStore()
const router = useRouter()
const route = useRoute()
const ticketFlow = useTicketFlowStore()
const isTicketFlow = computed(() => ticketFlow.active)

const tagId = computed(() => props.loadedTag?.id)

// 组件级定时器引用，用于卸载时清理
const _timers = { interval: null, timeout: null }
onBeforeUnmount(() => {
  if (_timers.interval) clearInterval(_timers.interval)
  if (_timers.timeout) clearTimeout(_timers.timeout)
})

/* ============ 素材本地行（归一化字段名） ============ */
const rows = ref([])
let _rawRows = []     // 全量素材
let _dedupedRows = [] // 去重素材（当前未启用去重，保留为空数组避免引用报错）

/* ============ 归因分类（用户自定义） + 分类概况（实时，脚本/AI生成） ============ */
const cats = ref([])       // [{id,name,feature,source}]  — 所有分类
const catInput = ref('')
const catExpanded = ref(new Set()) // 展开可编辑的分类 id
const catEditing = ref(new Set()) // 正在编辑分类名的 id

function normType(x) {
  if (x.elementTypeName) return x.elementTypeName
  if (x.isVideo) return '视频'
  return x.type || '图片'
}

function startEditCatName(id) {
  catEditing.value.add(id)
  catEditing.value = new Set(catEditing.value)
}
async function saveCatName(c) {
  catEditing.value.delete(c.id)
  catEditing.value = new Set(catEditing.value)
  if (!c.name?.trim()) { toast.warn('分类名不能为空'); return }
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再编辑分类'); return }
  const newName = c.name.trim()
  try {
    await materialApi.updateCategory(tagId.value, c.id, {
      name: newName,
      feature: c.featureBrief || c.feature || '',
      featureBrief: c.featureBrief || '',
      featureDetail: c.featureDetail || '',
      sampleSnapshot: c.sampleSnapshot || '',
    })
    // 同步回 cats.value 原始对象，确保 overviewStat/attrStat/cats 等 computed 实时刷新
    const orig = cats.value.find(x => x.id === c.id)
    if (orig) {
      orig.name = newName
      // 强制触发 cats.value 引用更新，确保素材卡片 v-for="c in cats" 下拉框同步刷新
      cats.value = cats.value.slice()
    }
  } catch (e) { toast.warn(e.message || '保存分类名失败') }
}

// 视频扩展名列表
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
// 图片扩展名列表（用于排除误判：ads_svp_video__xxx.jpeg 路径含 video 但实际是图片）
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']

// 通过 URL 后缀判断是否为明确的图片资源（与 isVideoByUrl 共用 IMAGE_EXT 口径）
// 用途：当上游数据把视频渠道的静态图（如 ads_svp_video__xxx.jpeg）误标为「视频」时，
// 以 URL 实际扩展名为准，避免前端用 <video> 标签渲染一张 jpeg 导致黑屏/Resource loading error
function isImageByUrl(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  return IMAGE_EXT.includes(ext)
}

// 前端归一化媒体 URL：去掉签名等查询参数与片段，统一 host 小写、去尾部斜杠
// http→https 协议归一，并剥离路径段内嵌的签名/令牌后缀（如 /abc_sigXXX/def.mp4）
// 用于素材去重判定，避免同一素材因 CDN 签名(sign/expire/t/路径令牌)不同而被渲染成多张卡片
function normUrl(url) {
  if (!url || typeof url !== 'string') return ''
  try {
    const x = new URL(url)
    const path = x.pathname.replace(/\/+$/, '').split('/').map(seg => {
      const clean = seg.replace(/[._-](sign|sig|token|expire|signature|auth)[a-z0-9_]*$/i, '')
      return clean || seg
    }).join('/')
    return `https://${x.hostname.toLowerCase()}/${path}`
  } catch {
    return url.split('?')[0].split('#')[0]
  }
}

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

// 视频判定：优先以 URL 实际扩展名为准。
// 若 mediaUrl 明确是图片扩展名（.jpg/.jpeg/.png…），即使 elementTypeName==='视频' 也强制按图片渲染，
// 否则 <video> 标签拿到一张 jpeg 会黑屏并报 Resource loading error。
function resolveIsVideo(x) {
  const urlIsImage = isImageByUrl(x.mediaUrl)
  if (urlIsImage) return false
  return !!x.isVideo || x.elementTypeName === '视频' || isVideoByUrl(x.mediaUrl)
}

watch(() => props.samples, (s) => {
  // 先归一化所有素材（同步操作，数据量大时耗时）
  const rawRows = (s || []).map(x => ({
    id: x.id,
    type: normType(x),
    isVideo: resolveIsVideo(x),
    mediaUrl: x.mediaUrl || '',
    ocr: x.ocrContent ?? x.ocr ?? x.ocr_text ?? x.ocr_content ?? x.osr ?? '',
    asr: x.asrContent ?? x.asr ?? x.asr_text ?? x.asr_content ?? '',
    industryL1: x.firstLevelIndustryName || x.industryL1 || '',
    industryL2: x.secondLevelIndustryName || x.industryL2 || '',
    classNum: x.classNum ?? 0,
    classId: x.classId || '',
    elementFingerprint: x.elementFingerprint || '',
    // 机审&人审标签（标签ID+名），清洗方括号/空数组字符串
    machineTag: cleanIds(x.machineTag || x.policyIds || ''),
    humanTag: cleanIds(x.humanTag || x.aiEvaluatePolicyIds || ''),
    // AI评测明细原始标签ID（用于卡片和弹窗显示），上传数据无评测明细时兜底取 machineTag/humanTag
    policyIds: cleanIds(x.policyIds || x.machineTag || ''),
    aiEvaluatePolicyIds: cleanIds(x.aiEvaluatePolicyIds || x.humanTag || ''),
    // 人审标签为空数组（[]）表示人审通过，需单独标记以便UI显示"通过"
    humanTagEmpty: isHumanTagEmpty(x.aiEvaluatePolicyIds) || isHumanTagEmpty(x.humanTag),
    dcId: x.dcId || '',
    // 审核人、客户主体名称(OPS)、广告主ID（从 ai_evaluate_detail JOIN 补充）
    reviewerName: x.reviewerName || x.ai_evaluate_reviewer_name || '',
    opsAdvertiserName: x.opsAdvertiserName || x.ops_advertiser_name || '',
    advertiserId: x.advertiserId || x.uid || '',
    // 标签信息
    tagId: x.tagId || '',
    tagName: x.tagName || '',
    // 元素ID（审核元素值或样本ID）
    elementId: x.elementId || x.sampleId || x.id || '',
    // 单选归属分类 id（null 表示未归类），统一转为 Number 避免类型不一致导致匹配失败
    categoryId: x.categoryId != null ? Number(x.categoryId) : null,
    // 画面特征（可编辑，AI 可回填）
    featureDesc: x.featureDesc || '',
    // 补充说明（可编辑）
    supplement: x.supplement || '',
    // 折叠项展开态（plain object，由 ref 深层响应式驱动）
    open: { ocr: false, asr: false, feat: false, sup: false },
  }))
    // _rawRows 保留全量原始行（不去重）：供 getSiblingIds / assign 回写同素材所有副本
    _rawRows = rawRows.map(r => ({ ...r, dupCount: 1 }))
    // _dedupedRows：按 matchKey 合并同素材的不同条目为一条，累计 dupCount（真实重复次数）
    const _groups = new Map()
    for (const r of _rawRows) {
      const key = matchKey(r)
      if (!key) { // 无匹配键（极端情况）直接作为独立行，避免被丢弃
        _groups.set(`__raw:${r.id}`, { ...r, dupCount: 1 })
        continue
      }
      const prev = _groups.get(key)
      if (!prev) {
        _groups.set(key, { ...r, dupCount: 1 })
      } else {
        prev.dupCount += 1
        // 补充优先字段：若首条缺指纹/URL 而副本有，则补全，提升展示与归类准确率
        if (!prev.elementFingerprint && r.elementFingerprint) prev.elementFingerprint = r.elementFingerprint
        if (!prev.mediaUrl && r.mediaUrl) prev.mediaUrl = r.mediaUrl
        if ((!prev.ocr && r.ocr) || (!prev.asr && r.asr)) { prev.ocr = prev.ocr || r.ocr; prev.asr = prev.asr || r.asr }
      }
    }
    _dedupedRows = Array.from(_groups.values())

    // 大数据量时先显示数据，再异步处理标注归一化
    const tid = props.loadedTag?.id
    rows.value = _dedupedRows

  // 异步分片处理标注归一化（避免阻塞主线程导致 UI 卡顿）
  if (_rawRows.length > 200) {
    _scheduleAnnotationSync(_rawRows, () => {
      if (tid && !props.shareMode && s && s.length) loadCategories()
    })
  } else {
    // 小数据量同步处理
    _syncAnnotations(_rawRows)
    if (tid && !props.shareMode && s && s.length) loadCategories()
    else if (!props.shareMode) cats.value = []
  }
}, { immediate: true })

// 标注归一化：同匹配键的素材组取最完整标注回填到全部副本
function _syncAnnotations(rawList) {
  const groupMap = {}
  for (const row of rawList) {
    const k = matchKey(row)
    if (!k) continue
    if (!groupMap[k]) groupMap[k] = []
    groupMap[k].push(row)
  }
  for (const k in groupMap) {
    const group = groupMap[k]
    if (group.length < 2) continue
    const best = group.reduce((acc, r) => {
      const accScore = (acc.categoryId != null ? 2 : 0) + (acc.supplement?.trim() ? 1 : 0) + (acc.featureDesc?.trim() ? 1 : 0)
      const rScore = (r.categoryId != null ? 2 : 0) + (r.supplement?.trim() ? 1 : 0) + (r.featureDesc?.trim() ? 1 : 0)
      return rScore > accScore ? r : acc
    })
    for (const r of group) {
      r.categoryId = best.categoryId
      r.featureDesc = best.featureDesc
      r.supplement = best.supplement
    }
  }
  // 强制响应式刷新
  rows.value = rows.value.slice()
}

// 分片调度：用 requestIdleCallback 或 setTimeout 分片处理，不阻塞主线程
function _scheduleAnnotationSync(rawList, onDone) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
      _syncAnnotations(rawList)
      if (onDone) onDone()
    }, { timeout: 2000 })
  } else {
    setTimeout(() => {
      _syncAnnotations(rawList)
      if (onDone) onDone()
    }, 50)
  }
}

const isTextOnly = (r) => r.type === '文本'

// 方案B：区分「去重后唯一素材数（卡片数）」与「真实总样本数（去重前原始总数）」
// - dedupedCount：当前渲染的去重后素材卡片数（rows.length）
// - rawTotal：后端返回的该标签去重前真实原始样本总数（props.samples.rawTotal）
//   避免「卡片数 = 真实样本数」的口径误解，明确展示「去重后」与「真实总样本」
const dedupedCount = computed(() => rows.value.length)
const rawTotal = computed(() => {
  const v = props.samples && props.samples.rawTotal
  return Number(v) || 0
})
const dupMerged = computed(() => (rawTotal.value > dedupedCount.value ? rawTotal.value - dedupedCount.value : 0))

// 清洗标签ID字符串：去除方括号/空白，空数组或空值返回 ''，否则返回逗号分隔的ID
function cleanIds(s) {
  if (s == null) return ''
  const ids = String(s).replace(/[[\]\s]/g, '').split(',').filter(Boolean)
  return ids.join(', ')
}

// 判断人审标签是否为空数组（[] 或 '[]'），空数组表示人审通过
function isHumanTagEmpty(s) {
  if (s == null) return false
  const str = String(s).replace(/[\s"'"]/g, '')
  return str === '[]' || str === ''
}

// 判断 URL 是否为真正的媒体文件（图片/视频），非媒体 URL（如 HTML 落地页）不应作为 src 加载
// 统一复用公共层 isMediaUrl（覆盖无扩展名的社交广告 CDN 如 gtiimg.com/snscosdow）
// CDN 域名白名单：这些域名的资源即使 URL 不带扩展名也应尝试走 proxy 加载
// 例如 h5.gdt.qq.com/xjviewer/nemo/xxx 不带扩展名但实际返回图片/视频
const CDN_HOST_WHITELIST = [
  'gtimg.cn', 'gtimg.com', 'qpic.cn', 'qq.com',
  'myqcloud.com', 'tencent-cloud.com',
]
function isCdnHost(url) {
  try {
    const { hostname } = new URL(url)
    return CDN_HOST_WHITELIST.some(h => hostname.endsWith(h))
  } catch { return false }
}
// 判断是否为合法 HTTP(S) URL
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  return /^https?:\/\//i.test(url)
}
// 非文本素材：若 mediaUrl 存在但是非媒体文件（HTML 落地页等），则回退为链接展示；
// 合法 HTTP URL 且不是已知媒体扩展名 → 作为链接，避免浏览器直接加载 HTML 页面报错
// 但如果是 CDN 域名（即使无扩展名）仍应尝试加载
function isLinkOnly(r) {
  if (isTextOnly(r)) return false
  if (!r.mediaUrl) return false
  if (!isValidHttpUrl(r.mediaUrl)) return true
  // CDN 域名白名单：无扩展名也尝试加载
  if (isCdnHost(r.mediaUrl)) return false
  // 有 HTTP URL 但不是已知媒体扩展名（如 h5.gdt.qq.com/xjviewer/nemo/xxx）→ 作为链接展示
  return !isMediaUrl(r.mediaUrl)
}

// 预览直连 CDN（http→https 自动升级），加载失败由 onErr 触发「打开原链接」逃生通道。
import { previewSrc, isBadShardUrl, isMediaUrl, retryOriginalSrc, rawHttpsUrlPlain, mediaProxyFallback } from '../../utils/mediaPreview.js'
// 模板中直接使用 previewSrc（src 与 href 统一走直连）

// 归因分类：用户手动添加的（source !== 'auto' && source !== 'ai_optimize'）
const attrCats = computed(() => cats.value.filter(c => c.source !== 'auto' && c.source !== 'ai_optimize'))
// 分类概况：脚本预分类 / AI 优化生成的（source === 'auto' || source === 'ai_optimize'）
const overviewCats = computed(() => cats.value.filter(c => c.source === 'auto' || c.source === 'ai_optimize'))

async function loadCategories() {
  if (!tagId.value) { cats.value = []; return }
  try { cats.value = await materialApi.categories(tagId.value) || [] } catch { cats.value = [] }
}
async function addCat() {
  const v = catInput.value.trim()
  if (!v) { toast.warn('请输入分类名称'); return }
  if (cats.value.some(c => c.name === v)) { toast.warn('该分类已存在'); return }
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再编辑分类'); return }
  if (!tagId.value) { toast.warn('请先加载标签'); return }
  try {
    const c = await materialApi.addCategory(tagId.value, { name: v, source: 'manual' })
    cats.value.push(c); catInput.value = ''
    toast.success(`已新增归因分类「${v}」`)
  } catch (e) { toast.warn(e.message || '新增失败') }
}
async function removeCat(c) {
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再编辑分类'); return }
  try {
    await materialApi.removeCategory(tagId.value, c.id)
    cats.value = cats.value.filter(x => x.id !== c.id)
    rows.value.forEach(r => { if (r.categoryId == c.id) { r.categoryId = null; syncAnnotationAcrossArrays(r) } })
    toast.success('已删除分类')
  } catch (e) { toast.warn(e.message || '删除失败') }
}
function toggleCatEdit(id) {
  catExpanded.value.has(id) ? catExpanded.value.delete(id) : catExpanded.value.add(id)
  catExpanded.value = new Set(catExpanded.value)
}
function expandAllCats() {
  catExpanded.value = new Set(cats.value.map(c => c.id))
}
function collapseAllCats() {
  catExpanded.value = new Set()
}
async function saveCatFeature(c) {
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再编辑分类'); return }
  try {
    await materialApi.updateCategory(tagId.value, c.id, {
      name: c.name,
      feature: c.featureBrief || c.feature || '',
      featureBrief: c.featureBrief || '',
      featureDetail: c.featureDetail || '',
      sampleSnapshot: c.sampleSnapshot || '',
    })
    // 同步回 cats.value 原始对象，确保 grouped 等下游 computed 实时刷新
    const orig = cats.value.find(x => x.id === c.id)
    if (orig) {
      orig.featureBrief = c.featureBrief || ''
      orig.featureDetail = c.featureDetail || ''
      orig.sampleSnapshot = c.sampleSnapshot || ''
      orig.feature = c.featureBrief || c.feature || ''
      orig.name = c.name
    }
    toast.success('凝练特征已保存')
  } catch (e) { toast.warn(e.message || '保存失败') }
}
// 分类概况实时统计（仅统计 overviewCats）
const overviewStat = computed(() => {
  const map = {}
  overviewCats.value.forEach(c => { map[c.id] = 0 })
  let unclassified = 0
  rows.value.forEach(r => {
    if (r.categoryId != null && map[r.categoryId] != null) map[r.categoryId]++
    else unclassified++
  })
  const total = rows.value.length || 1
  const list = overviewCats.value.map(c => ({ ...c, count: map[c.id] || 0, pct: Math.round((map[c.id] || 0) / total * 100) }))
  return { list, unclassified, total: rows.value.length }
})
// 归因分类实时统计（仅统计 attrCats）
const attrStat = computed(() => {
  const map = {}
  attrCats.value.forEach(c => { map[c.id] = 0 })
  let unclassified = 0
  rows.value.forEach(r => {
    if (r.categoryId != null && map[r.categoryId] != null) map[r.categoryId]++
    else unclassified++
  })
  const total = rows.value.length || 1
  const list = attrCats.value.map(c => ({ ...c, count: map[c.id] || 0, pct: Math.round((map[c.id] || 0) / total * 100) }))
  return { list, unclassified, total: rows.value.length }
})

/* ============ 归类：单选下拉 + 批量 ============ */
// 统一匹配键：指纹 > 归一化 mediaUrl（去签名+http→https） > ocr+asr（纯文本兜底）
// 归一化 URL 抗同一素材不同 CDN 签名/协议造成的重复
function matchKey(r) {
  if (r.elementFingerprint) return `fp:${r.elementFingerprint}`
  if (r.mediaUrl) return `url:${normUrl(r.mediaUrl)}`
  // 纯文本素材无指纹无 URL，用 ocr+asr 组合作为兜底匹配键
  const textKey = `${r.ocr || ''}|${r.asr || ''}`
  return textKey ? `text:${textKey}` : null
}
// 通过匹配键同步标注到 _rawRows 和 _dedupedRows 两个数组，保证去重/全量展示标注一致
function syncAnnotationAcrossArrays(r) {
  const key = matchKey(r)
  if (!key) return
  const fields = { categoryId: r.categoryId, featureDesc: r.featureDesc, supplement: r.supplement }
  for (const arr of [_rawRows, _dedupedRows]) {
    for (const row of arr) {
      if (matchKey(row) === key) {
        row.categoryId = fields.categoryId
        row.featureDesc = fields.featureDesc
        row.supplement = fields.supplement
      }
    }
  }
  // 强制响应式刷新，让当前列表立即反映同步结果
  rows.value = rows.value.slice()
}
// 获取同匹配键的所有 sampleId（去重模式下需保存全部副本）
function getSiblingIds(r) {
  const key = matchKey(r)
  if (!key) return [r.id]
  const ids = _rawRows.filter(row => matchKey(row) === key).map(row => row.id)
  return ids.length ? ids : [r.id]
}
async function assignOne(r) {
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再标注'); return }
  if (!tagId.value) return
  // API 调用前先同步前端两个数组，保证即使 API 失败标注仍一致
  syncAnnotationAcrossArrays(r)
  try {
    const ids = getSiblingIds(r)
    const items = ids.map(id => {
      const row = _rawRows.find(x => x.id === id) || r
      return { sampleId: id, categoryId: r.categoryId || 0, featureDesc: r.featureDesc, supplement: r.supplement, mediaUrl: row.mediaUrl || '' }
    })
    await materialApi.assign(tagId.value, items)
  } catch (e) { toast.warn(e.message || '归类失败') }
}
const batchCat = ref('')
async function batchAssign() {
  if (props.shareMode) { toast.warn('分享只读模式：请先「另存为我的副本」后再批量归类'); return }
  if (!selected.value.size) { toast.warn('请先勾选素材'); return }
  if (!batchCat.value) { toast.warn('请选择要移动到的分类'); return }
  const cid = Number(batchCat.value)
  const updatedRows = []
  const items = [...selected.value].map(id => {
    const r = rows.value.find(x => x.id === id)
    if (r) { r.categoryId = cid; updatedRows.push(r) }
    return { sampleId: id, categoryId: cid, mediaUrl: r?.mediaUrl || '' }
  })
  // 去重模式下，补充同指纹的其他 sampleId
  const extraItems = []
  for (const r of updatedRows) {
    const siblings = getSiblingIds(r).filter(sid => !items.some(it => it.sampleId === sid))
    for (const sid of siblings) extraItems.push({ sampleId: sid, categoryId: cid, mediaUrl: r?.mediaUrl || '' })
  }
  try {
    await materialApi.assign(tagId.value, [...items, ...extraItems])
    updatedRows.forEach(r => syncAnnotationAcrossArrays(r))
    toast.success(`已将 ${items.length} 条素材移动到该分类`)
    selected.value = new Set()
  } catch (e) { toast.warn(e.message || '批量归类失败') }
}

/* ============ 选择模式 ============ */
const selected = ref(new Set())
const allChecked = computed(() => filtered.value.length && filtered.value.every(r => selected.value.has(r.id)))
function toggle(id) { selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id); selected.value = new Set(selected.value) }
function toggleAll() {
  if (allChecked.value) filtered.value.forEach(r => selected.value.delete(r.id))
  else filtered.value.forEach(r => selected.value.add(r.id))
  selected.value = new Set(selected.value)
}
function goTicket() {
  const objs = rows.value.filter(r => selected.value.has(r.id)).map(r => ({
    id: r.id, type: r.type, isVideo: r.isVideo,
    mediaUrl: r.mediaUrl, ocr: r.ocr, asr: r.asr,
    elementFingerprint: r.elementFingerprint || '',
    industryL1: r.industryL1, industryL2: r.industryL2,
    tagId: props.loadedTag?.id || '', tag: props.loadedTag?.name || '',
    reviewerName: r.reviewerName || '',
    dcId: r.dcId || '',
    advertiserId: r.advertiserId || '',
  }))
  const ctx = {
    tagId: props.loadedTag?.id, tag: props.loadedTag?.name,
    elementType: objs.length ? objs[0].type : '',
    industryL1: objs.length ? objs[0].industryL1 : '',
    industryL2: objs.length ? objs[0].industryL2 : '',
  }
  const wasActive = ticketFlow.active
  if (!wasActive) ticketFlow.begin()
  ticketFlow.setSamples(objs, ctx)
  // 记录当前选素材页作为来源，退出提需流程时可返回
  ticketFlow.setOrigin(route.fullPath)
  toast.success(wasActive
    ? `已选 ${selected.value.size} 条素材，返回提需`
    : `已选 ${selected.value.size} 条素材，前往提需`)
  router.push({ name: 'tickets' })
}

// 导出选中素材为 Excel（按数据源切换 API）
async function exportExcel() {
  if (!selected.value.size) { toast.warn('请先勾选要导出的素材'); return }
  if (!tagId.value) { toast.warn('请先加载标签'); return }
  try {
    const ids = [...selected.value]
    if (props.dataSource === 'upload') {
      await classifyUploadApi.exportExcel(tagId.value, {
        sampleIds: ids,
      })
    } else {
      await tagApi.exportExcel(tagId.value, {
        sampleIds: ids,
        start: '',
        end: '',
      })
    }
    toast.success(`已导出 ${ids.length} 条素材为 Excel`)
  } catch (e) {
    toast.warn(e.message || '导出失败')
  }
}

/* ============ 筛选 + 展示模式 + 行数 ============ */
const typeFilter = usePersistedRef('preview:typeFilter', '全部')
const onlyAnnotated = ref(false) // 只看标注：有分类或补充说明
const displayMode = usePersistedRef('preview:display', 'all')  // all | byCat
const activeCatGroup = ref(null) // 分类卡片模式下，当前展开查看的分类id（null=概览）
const cols = usePersistedRef('preview:cols', 4)                // 1 | 4 | 8 | 10 | 自定义
const customCols = usePersistedRef('preview:customCols', 6)
const activeCols = computed(() => cols.value === 'custom' ? Math.max(1, Number(customCols.value) || 1) : Number(cols.value))
const gridStyle = computed(() => ({ gridTemplateColumns: `repeat(${activeCols.value}, minmax(150px, 1fr))` }))

/* ============ 行业筛选（一级 + 二级，联动） ============ */
const industryL1Filter = ref('全部')
const industryL2Filter = ref('全部')
// 一级行业选项：从当前素材中提取去重
const industryL1Options = computed(() => {
  const set = new Set()
  rows.value.forEach(r => { if (r.industryL1) set.add(r.industryL1) })
  return ['全部', ...Array.from(set).sort()]
})
// 二级行业选项：如果选了一级行业，仅显示该一级行业下的二级行业
const industryL2Options = computed(() => {
  const set = new Set()
  rows.value.forEach(r => {
    if (!r.industryL2) return
    if (industryL1Filter.value !== '全部' && r.industryL1 !== industryL1Filter.value) return
    set.add(r.industryL2)
  })
  return ['全部', ...Array.from(set).sort()]
})
// 选一级行业时重置二级行业
function onL1Change() { industryL2Filter.value = '全部' }

/* ============ 审核人 + 广告主ID 筛选 ============ */
const reviewerFilter = ref('全部')
const advertiserIdFilter = ref('全部')
const reviewerOptions = computed(() => {
  const set = new Set()
  rows.value.forEach(r => { if (r.reviewerName) set.add(r.reviewerName) })
  return ['全部', ...Array.from(set).sort()]
})
const advertiserIdOptions = computed(() => {
  const set = new Set()
  rows.value.forEach(r => { if (r.advertiserId) set.add(r.advertiserId) })
  return ['全部', ...Array.from(set).sort()]
})

/* ============ 人审标签筛选（逐个拆分） ============ */
const humanTagFilter = ref('全部')
const humanTagOptions = computed(() => {
  const set = new Set()
  rows.value.forEach(r => {
    if (!r.humanTag && r.humanTagEmpty) {
      set.add('通过')
    } else if (r.humanTag) {
      const tags = String(r.humanTag).split(/[,，]/).map(t => t.trim()).filter(Boolean)
      for (const t of tags) set.add(t)
    }
  })
  return ['全部', ...Array.from(set).sort()]
})

/* ============ 多列模式：详情弹窗 ============ */
const detailRow = ref(null)
const tragSearchVisible = ref(false)
const tragSearchMaterial = ref(null)

// 本地版自动检测任务类型（与TragSearchModal逻辑一致，用于后台预热）
function autoDetectTaskLocal(r) {
  if (!r) return 'text_text'
  if (r.type === '文本' || (!r.isVideo && !r.mediaUrl)) return 'text_text'
  if (r.isVideo) {
    // 视频优先用 OCR/ASR 文本检索（基于 bge-large-zh，稳定可用）
    // video_video 依赖 ElementHub+Venus 视觉嵌入服务，经常不可用
    if (r.ocr) return 'video_ocr'
    if (r.asr) return 'video_asr'
    if (r.elementFingerprint) return 'video_video'
    return 'video_frame'
  }
  // 图片优先用 OCR 文本检索（基于 bge-large-zh，稳定可用）
  // image_image 依赖 Venus 视觉嵌入服务，经常返回 500
  if (r.ocr) return 'image_ocr'
  if (r.mediaUrl) return 'image_image'
  return 'text_text'
}
function autoFillQueryLocal(task, r) {
  if (!r) return ''
  switch (task) {
    case 'text_text': return r.mediaUrl || r.ocr || r.asr || ''
    case 'image_image':
    case 'video_frame': return r.mediaUrl || ''
    case 'image_ocr':
    case 'video_ocr': return r.ocr || ''
    case 'video_asr': return r.asr || ''
    case 'video_video': return r.elementFingerprint || ''
    default: return ''
  }
}

function openTragSearch(r) {
  openDetail(r)
}
function closeTragSearch() {
  closeDetail()
}
/* 卡片信息区点击：始终进入检索详情，选择通过右上角小正方形 */
function onCardEnter(r) {
  openDetail(r)
}

/* ============ 检索预热：hover 时提前发请求（debounce 300ms） ============ */
let _preloadTimer = null
const _preloadedIds = new Set()
function preloadSearch(r) {
  if (_preloadedIds.has(r.id)) return
  if (_preloadTimer) clearTimeout(_preloadTimer)
  _preloadTimer = setTimeout(() => {
    _preloadedIds.add(r.id)
    const task = autoDetectTaskLocal(r)
    const query = autoFillQueryLocal(task, r)
    if (task && query) {
      tragApi.search({ task, query, input_mode: 'auto', limit: 10, threshold: 0 }).catch(() => {})
    }
  }, 300)
}
function cancelPreload() {
  if (_preloadTimer) { clearTimeout(_preloadTimer); _preloadTimer = null }
}

/* ============ TragSearchModal 编辑事件回调 ============ */
function onTragAssign(payload) {
  const r = payload.item
  if (!r) return
  r.categoryId = payload.categoryId
  assignOne(r)
}
/* ============ 视频播放状态同步（卡片 ↔ 弹窗共享同一播放进度） ============ */
const videoStates = reactive({})  // { [sampleId]: { currentTime, paused, duration } }

function syncVideoState(el, sampleId) {
  if (!el || !sampleId) return
  // 读取已保存的状态并同步到当前 video 元素
  const st = videoStates[sampleId]
  if (st) {
    try {
      if (st.currentTime != null && Math.abs(el.currentTime - st.currentTime) > 0.3) {
        el.currentTime = st.currentTime
      }
      if (st.paused === false) {
        el.play().catch(() => {})
      } else {
        el.pause()
      }
      if (st.playbackRate) el.playbackRate = st.playbackRate
    } catch {}
  }
  // 绑定事件（防重复）
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

function pauseCardVideo(sampleId) {
  // 暂停卡片中的视频（通过 data-vid 查找）
  const cardVideo = document.querySelector(`video[data-vid="${sampleId}"]`)
  if (cardVideo) {
    if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0, playbackRate: 1 }
    videoStates[sampleId].currentTime = cardVideo.currentTime
    videoStates[sampleId].paused = true
    videoStates[sampleId].duration = cardVideo.duration || 0
    videoStates[sampleId].playbackRate = cardVideo.playbackRate || 1
    cardVideo.pause()
  }
}

function openDetail(r) {
  // 打开弹窗前：保存并暂停卡片视频
  if (r.isVideo) pauseCardVideo(r.id)

  // 检索预热：使用静态导入的 tragApi 立即发请求填补时间窗口（缓存命中后弹窗内秒出）
  const task = autoDetectTaskLocal(r)
  const query = autoFillQueryLocal(task, r)
  if (task && query) {
    tragApi.search({ task, query, input_mode: 'auto', limit: 10, threshold: 0 }).catch(() => {})
  }

  // 统一打开 TragSearchModal
  tragSearchMaterial.value = r
  tragSearchVisible.value = true
  // 弹窗渲染后：同步播放进度到弹窗视频
  if (r.isVideo) {
    nextTick(() => {
      const modalVideo = document.querySelector('.trag-modal video')
      if (modalVideo) syncVideoState(modalVideo, r.id)
    })
  }
}
function closeDetail() {
  // 关闭弹窗前：保存弹窗视频进度（含播放状态）
  const closingId = tragSearchMaterial.value?.isVideo ? tragSearchMaterial.value.id : null
  if (closingId) {
    const modalVideo = document.querySelector('.trag-modal video')
    if (modalVideo) {
      if (!videoStates[closingId]) videoStates[closingId] = { currentTime: 0, paused: true, duration: 0, playbackRate: 1 }
      const wasPlaying = !modalVideo.paused
      videoStates[closingId].currentTime = modalVideo.currentTime
      videoStates[closingId].duration = modalVideo.duration || 0
      videoStates[closingId].playbackRate = modalVideo.playbackRate || 1
      modalVideo.pause()
      videoStates[closingId].paused = !wasPlaying
    }
  }
  tragSearchVisible.value = false
  tragSearchMaterial.value = null
  // 回写进度到卡片视频
  if (closingId) {
    nextTick(() => {
      const cardVideo = document.querySelector(`video[data-vid="${closingId}"]`)
      if (cardVideo) syncVideoState(cardVideo, closingId)
    })
  }
}
const types = computed(() => {
  const c = {}
  rows.value.forEach(r => { c[r.type] = (c[r.type] || 0) + 1 })
  const arr = [{ v: '全部', n: rows.value.length }]
  Object.keys(c).forEach(k => arr.push({ v: k, n: c[k] }))
  return arr
})
const filtered = computed(() => {
  let r = rows.value
  if (typeFilter.value !== '全部') r = r.filter(x => x.type === typeFilter.value)
  if (industryL1Filter.value !== '全部') r = r.filter(x => x.industryL1 === industryL1Filter.value)
  if (industryL2Filter.value !== '全部') r = r.filter(x => x.industryL2 === industryL2Filter.value)
  if (reviewerFilter.value !== '全部') r = r.filter(x => x.reviewerName === reviewerFilter.value)
  if (advertiserIdFilter.value !== '全部') r = r.filter(x => x.advertiserId === advertiserIdFilter.value)
  if (humanTagFilter.value !== '全部') {
    r = r.filter(x => {
      if (humanTagFilter.value === '通过') return !x.humanTag && x.humanTagEmpty
      const tags = String(x.humanTag).split(/[,，]/).map(t => t.trim()).filter(Boolean)
      return tags.includes(humanTagFilter.value)
    })
  }
  if (onlyAnnotated.value) r = r.filter(x => x.categoryId != null || (x.supplement && x.supplement.trim()))
  return r
})
// 分页状态：每次 filtered 变化时重置
const pageSize = ref(50)
const pageOffset = ref(0)
// 当前页展示的数据（分片，避免一次性渲染过多 DOM 节点）
const displayed = computed(() => {
  const all = filtered.value
  const end = pageOffset.value + pageSize.value
  return all.slice(0, Math.min(end, all.length))
})
const hasMore = computed(() => displayed.value.length < filtered.value.length)
function loadMore() {
  pageOffset.value += pageSize.value
}
// filtered 变化时重置分页
watch(filtered, () => { pageOffset.value = 0 }, { immediate: false })
// 分类卡片模式：按分类分组
const grouped = computed(() => {
  const g = cats.value.map(c => ({ id: c.id, name: c.name, feature: c.feature, featureBrief: c.featureBrief, featureDetail: c.featureDetail, sampleSnapshot: c.sampleSnapshot, items: [] }))
  const un = { id: 0, name: '未归类', feature: '', featureBrief: '', featureDetail: '', sampleSnapshot: '', items: [] }
  filtered.value.forEach(r => {
    // 使用 == 松散比较，兼容 number/string 类型差异（后端不同API可能返回不同类型）
    const t = r.categoryId != null ? g.find(x => x.id == r.categoryId) : undefined
    ;(t || un).items.push(r)
  })
  return un.items.length ? [...g, un] : g
})

// 进入分类卡片模式时重置 activeCatGroup
watch(displayMode, (v) => { if (v === 'byCat') activeCatGroup.value = null })

/* ============ 一键预分类：脚本关键词分类 ============ */
const classifying = ref(false)

/** 一键预分类：按 classNum 分组 → 读取全量文本提取高频词/句式 → 输出三段式分类 */
function runPreClassify() {
  scriptPreClassify()
}
async function ensureCatByName(name) {
  let c = cats.value.find(x => x.name === name)
  if (c) return c
  try {
    c = await materialApi.addCategory(tagId.value, { name, source: 'auto' })
    cats.value.push(c)
    return c
  } catch (e) {
    // 新增失败（如重名冲突），回退：从后端重新拉取分类列表并按名称匹配
    try {
      const list = await materialApi.categories(tagId.value) || []
      const found = list.find(x => x.name === name)
      if (found) {
        if (!cats.value.some(x => x.id === found.id)) cats.value.push(found)
        return found
      }
    } catch {}
    throw new Error(`创建分类「${name}」失败：${e.message || '未知错误'}`)
  }
}

// 清空分类概况中的自动生成分类（预分类前调用，不影响归因分类）
async function clearAllCats() {
  const overview = cats.value.filter(c => c.source === 'auto' || c.source === 'ai_optimize')
  if (!overview.length) return
  for (const c of overview) {
    try { await materialApi.removeCategory(tagId.value, c.id) } catch {}
  }
  cats.value = cats.value.filter(c => c.source !== 'auto' && c.source !== 'ai_optimize')
  rows.value.forEach(r => {
    if (overview.some(c => c.id == r.categoryId)) { r.categoryId = null; syncAnnotationAcrossArrays(r) }
  })
}

// 脚本预分类：纯JS关键词+句式匹配（两阶段）
// Phase 1: 快速分组 → 创建分类 → 归入素材 → 立即展示分类名+数量
// Phase 2: 渐进式分析文本 → 逐个分类填充特征 → 实时更新UI
async function scriptPreClassify() {
  if (!rows.value.length) { toast.warn('请先加载素材'); return }
  if (!tagId.value) { toast.warn('请先加载标签'); return }
  classifying.value = true
  try {
    // 0. 先清空所有已有分类
    await clearAllCats()

    // ========== Phase 1: 快速分组 + 创建分类 + 归入素材（毫秒级） ==========
    // 记录分类创建前的基准索引，用于 onFeature 回调中定位新创建的分类
    const baseIdx = cats.value.length
    // 缓存机制：Phase 2 的 onFeature 可能在分类创建前触发（竞态），暂存特征数据
    const pendingFeatures = []
    let catsCreated = false
    const result = scriptClassify(rows.value, {
      maxSnapshotCount: 3,
      onFeature: (idx, feature) => {
        // Phase 2 回调：逐个分类的特征生成完毕，更新 UI + 后端
        // 注意：idx 是 scriptClassify 返回数组中的索引，需要加上 baseIdx 偏移
        if (!catsCreated) {
          // 分类尚未创建完成，暂存特征数据
          pendingFeatures[idx] = feature
          return
        }
        const c = cats.value[baseIdx + idx]
        if (!c) return
        c.feature = feature.featureBrief
        c.featureBrief = feature.featureBrief
        c.featureDetail = feature.featureDetail
        c.sampleSnapshot = feature.sampleSnapshot
        // 异步写入后端（不阻塞 UI）
        materialApi.updateCategory(tagId.value, c.id, {
          name: c.name,
          feature: feature.featureBrief,
          featureBrief: feature.featureBrief,
          featureDetail: feature.featureDetail,
          sampleSnapshot: feature.sampleSnapshot,
        }).catch(() => {})
      },
    })
    if (!result.length) { toast.warn('未能生成分类，请检查素材内容'); return }

    // 立即创建分类并归入素材（不等待特征生成）
    const items = []
    for (const r of result) {
      const c = await ensureCatByName(r.name)
      // Phase 1 只写入名称，特征字段留空（Phase 2 会通过 onFeature 回调填充）
      // 归入素材
      r.sampleIds.forEach(sid => {
        const row = rows.value.find(x => x.id === sid)
        if (row) { row.categoryId = c.id; syncAnnotationAcrossArrays(row) }
        items.push({ sampleId: sid, categoryId: c.id })
      })
    }

    if (items.length) await materialApi.assign(tagId.value, items)

    // 分类创建完成，标记并应用暂存的特征数据（处理 Phase 2 竞态）
    catsCreated = true
    pendingFeatures.forEach((feature, idx) => {
      if (!feature) return
      const c = cats.value[baseIdx + idx]
      if (!c) return
      c.feature = feature.featureBrief
      c.featureBrief = feature.featureBrief
      c.featureDetail = feature.featureDetail
      c.sampleSnapshot = feature.sampleSnapshot
      materialApi.updateCategory(tagId.value, c.id, {
        name: c.name,
        feature: feature.featureBrief,
        featureBrief: feature.featureBrief,
        featureDetail: feature.featureDetail,
        sampleSnapshot: feature.sampleSnapshot,
      }).catch(() => {})
    })

    // 预分类完成后默认展开所有分类
    const allIds = cats.value.map(c => c.id)
    catExpanded.value = new Set(allIds)

    toast.success(`预分类完成，共生成 ${result.length} 个分类，已归入 ${items.length} 条素材。特征分析进行中…`)

    // ========== Phase 2: 渐进式特征生成由 onFeature 回调驱动 ==========
    // scriptClassify 内部通过 setTimeout 让出主线程，逐个分类生成特征
    // 每完成一个即触发 onFeature → 更新 cats 数组 → 响应式 UI 自动刷新
    // classifying 保持 true 直到所有特征生成完毕（由 setTimeout 链式调用自然结束）
    // 简单等待最后一个分类完成（最坏情况：分类数 × 文本分析时间）
    const totalCats = result.length
    let completedCount = 0
    _timers.interval = setInterval(() => {
      completedCount = cats.value.filter(c => c.featureBrief).length
      if (completedCount >= totalCats) {
        clearInterval(_timers.interval)
        _timers.interval = null
        if (_timers.timeout) { clearTimeout(_timers.timeout); _timers.timeout = null }
        classifying.value = false
        toast.success('所有分类特征分析完成')
      }
    }, 500)
    // 安全兜底：随分类数量线性放大（每分类预留 1.5s，最少 30s），避免分类较多时提前结束特征分析
    const safetyMs = Math.max(30000, totalCats * 1500)
    _timers.timeout = setTimeout(() => { clearInterval(_timers.interval); _timers.interval = null; _timers.timeout = null; classifying.value = false }, safetyMs)
  } catch (e) { toast.warn(e.message || '预分类失败'); classifying.value = false }
}

/* ============ 结论：保存 + 导出 ============ */
function buildExportPayload() {
  const overview = overviewStat.value.list.map(c => ({ name: c.name, count: c.count, pct: c.pct }))
  if (overviewStat.value.unclassified) overview.push({ name: '未归类', count: overviewStat.value.unclassified, pct: Math.round(overviewStat.value.unclassified / (overviewStat.value.total || 1) * 100) })
  const attrList = attrStat.value.list.map(c => ({ name: c.name, count: c.count, pct: c.pct }))
  if (attrStat.value.unclassified && attrCats.value.length) attrList.push({ name: '未归类', count: attrStat.value.unclassified, pct: Math.round(attrStat.value.unclassified / (attrStat.value.total || 1) * 100) })
  const categories = grouped.value.filter(g => g.items.length).map(g => ({
    name: g.name,
    feature: g.feature || '',
    featureBrief: g.featureBrief || g.feature || '',
    featureDetail: g.featureDetail || '',
    sampleSnapshot: g.sampleSnapshot || '',
    count: g.items.length,
    samples: g.items.slice(0, 50).map(r => ({ id: r.id, type: r.type, industryL1: r.industryL1, industryL2: r.industryL2, industry: [r.industryL1, r.industryL2].filter(Boolean).join(' / ') || '-', featureDesc: r.featureDesc })),
  }))
  const summary = `本次共分析素材 ${rows.value.length} 条，分类概况 ${overviewCats.value.length} 个分类，归因分类 ${attrCats.value.length} 个，未归类 ${overviewStat.value.unclassified} 条。`
  return { title: '素材预分类结论报告', tagName: props.loadedTag?.name || '', overview, attrList, categories, summary }
}
const saving = ref(false)
async function saveConclusion() {
  if (!tagId.value) { toast.warn('请先加载标签'); return }
  saving.value = true
  try {
    const p = buildExportPayload()
    await materialApi.saveConclusion(tagId.value, { tagName: p.tagName, content: JSON.stringify(p), summary: p.summary })
    toast.success('分类结论已保存')
  } catch (e) { toast.warn(e.message || '保存失败') }
  finally { saving.value = false }
}

/* ============ 分享快照：只读还原 + 另存为我的副本 ============ */
// 由父组件在打开 share 链接时调用，标记为只读分享模式（写操作需先另存为副本）
function setShareMode(on) {
  emit('update:shareMode', !!on)
}
// 由父组件 ClassifyView 在打开 share 链接时调用（shareMode=true 下）
// 直接用快照自带数据填充，不依赖 materialApi（脱离原 tagId）
function loadShare(payload) {
  if (!payload) return
  // 分类：优先用快照自带（已含 id/name/source/feature 等），保证分类与标注对得上
  if (Array.isArray(payload.cats) && payload.cats.length) {
    cats.value = payload.cats.map(c => ({ ...c }))
  } else {
    cats.value = []
  }
  // 素材：快照 samples 已是标准字段，父组件会作为 :samples 传入并触发 watch 派生 rows；
  // 此处再以 categoryId/featureDesc/supplement 兜底套用（防止 props.samples 未带标注的情况）
  if (Array.isArray(payload.samples)) {
    const annMap = new Map()
    for (const s of payload.samples) {
      if (s.categoryId != null || s.featureDesc || s.supplement) {
        const key = s.elementFingerprint ? `fp:${s.elementFingerprint}` : (s.mediaUrl ? `url:${normUrl(s.mediaUrl)}` : null)
        if (key) annMap.set(key, { categoryId: s.categoryId ?? null, featureDesc: s.featureDesc || '', supplement: s.supplement || '' })
      }
    }
    if (annMap.size) {
      // 等 props.samples 派生出 rows 后再套用（nextTick 确保 watch 已执行）
      nextTick(() => {
        for (const r of rows.value) {
          const key = matchKey(r)
          const a = key ? annMap.get(key) : null
          if (a) {
            r.categoryId = a.categoryId
            r.featureDesc = a.featureDesc
            r.supplement = a.supplement
          }
        }
        rows.value = rows.value.slice()
      })
    }
  }
  // 视图状态还原
  const v = payload.view || {}
  if (v.activeCat != null) activeCatGroup.value = v.activeCat
  if (Array.isArray(v.expand)) catExpanded.value = new Set(v.expand)
}

// 另存为我的副本：把当前快照（cats + 标注）写回当前 loadedTag（需已加载真实可写标签）
async function forkToMine() {
  if (!tagId.value) { toast.warn('请先加载一个可写入的标签后再另存'); return }
  const catsToSave = cats.value.filter(c => c.source !== 'auto' && c.source !== 'ai_optimize')
  try {
    // 1) 重建分类（手动/AI优化分类写回；auto 概况由系统重新生成，不写回）
    const idMap = new Map() // 旧 id -> 新 id
    for (const c of catsToSave) {
      const nc = await materialApi.addCategory(tagId.value, {
        name: c.name,
        source: c.source || 'manual',
        feature: c.feature || c.featureBrief || '',
        featureBrief: c.featureBrief || '',
        featureDetail: c.featureDetail || '',
        sampleSnapshot: c.sampleSnapshot || '',
      })
      idMap.set(c.id, nc.id)
    }
    // 2) 把标注（categoryId 映射到新分类 id）批量写回
    const items = []
    for (const r of rows.value) {
      if (r.categoryId != null || r.featureDesc || r.supplement) {
        const cid = idMap.get(r.categoryId) ?? r.categoryId
        items.push({ sampleId: r.id, categoryId: cid || 0, featureDesc: r.featureDesc, supplement: r.supplement, mediaUrl: r.mediaUrl || '' })
      }
    }
    if (items.length) await materialApi.assign(tagId.value, items)
    toast.success(`已另存为我的副本：${catsToSave.length} 个分类、${items.length} 条标注已写入「${props.loadedTag?.name} #${tagId.value}」`)
    return { cats: catsToSave.length, anns: items.length }
  } catch (e) {
    toast.warn(e.message || '另存为副本失败')
    throw e
  }
}

async function exportDoc(kind) {
  if (!tagId.value) { toast.warn('请先加载标签'); return }
  try {
    const p = buildExportPayload()
    if (kind === 'pdf') await materialApi.exportPdf(tagId.value, p)
    else await materialApi.exportWord(tagId.value, p)
    toast.success(`已导出 ${kind.toUpperCase()} 文档`)
  } catch (e) { toast.warn(e.message || '导出失败') }
}

const mediaErr = ref(new Set())
// 媒体加载失败：直链失败统一走「打开原链接」兜底；首次失败先用「原始直连（不重签 dis_t）」重试一次。
// 原因：previewSrc 默认会对广告 CDN 刷新 dis_t 时间戳，个别边缘节点对「新 dis_t + 原始 dis_k」
// 组合可能返回异常而被浏览器拒绝（node/curl 直连却正常）。此时回退到数据库最原始签名直链最稳妥
// （dis_t 有效期实测极长，原始组合通常可用）。视频与图片采用同一套兜底策略。
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
  // 代理仍失败：标记降级，模板切换到「打开原链接」逃生通道（不再强删 src，避免破坏重试/播放）
  if (mediaErr.value.has(id)) return
  mediaErr.value.add(id); mediaErr.value = new Set(mediaErr.value)
}
function catName(id) { return cats.value.find(c => c.id === id)?.name || '' }

// ===== 与「标签跟踪素材预览」完全一致的素材卡片辅助函数 =====
// 类型标签：图片/视频/文本/落地页 → 英文展示
const TYPE_EN_MAP_PA = { '视频': 'Video', '图片': 'Image', '文本': 'Text', '落地页': 'URL' }
function cardTypeText(s) {
  const t = s.type || (!s.mediaUrl ? '文本' : (s.isVideo ? '视频' : '图片'))
  return TYPE_EN_MAP_PA[t] || t
}
// 三态审核判定角标：一致 / 漏放 / 误杀（素材无 verifyStatus 时不展示，与标签跟踪一致）
function verifyBadge(s) {
  const map = { consistent: ['一致', 'v-consistent'], miss: ['漏放', 'v-miss'], fp: ['误杀', 'v-fp'] }
  const pair = map[s.verifyStatus]
  return pair ? { label: pair[0], cls: pair[1] } : { label: '', cls: '' }
}
function humanTagText(s) {
  const t = (s.aiEvaluatePolicyIds || s.humanTag) && String(s.aiEvaluatePolicyIds || s.humanTag).replace(/[\[\]]/g, '').trim()
  return t || '通过'
}
function machineTagText(s) {
  const t = String(s.policyIds || s.machineTag || '').replace(/[\[\]]/g, '').trim()
  return t || ''
}
function cardMediaErr(id) { return mediaErr.value.has(id) }
function resolveSignedSrc(rawUrl) { return previewSrc(rawUrl) }
// 折叠 OCR/ASR（复用每行已有 open 展开态，与标签跟踪点击标题展开一致）
function cardSectionOpen(s, field) { return !!(s.open && s.open[field]) }
function toggleCardSection(s, field) { if (s.open) s.open[field] = !s.open[field] }
// 视频倍速（与卡片 ↔ 弹窗共享 videoStates，进度条原生可拖动）
const SPEED_OPTIONS_PA = [1, 1.5, 2, 3, 0.5]
function speedLabel(sampleId) {
  const rate = videoStates[sampleId]?.playbackRate || 1
  return `${rate}x`
}
function cycleSpeed(sampleId) {
  const cur = videoStates[sampleId]?.playbackRate || 1
  const idx = SPEED_OPTIONS_PA.indexOf(cur)
  const next = SPEED_OPTIONS_PA[(idx + 1) % SPEED_OPTIONS_PA.length]
  if (!videoStates[sampleId]) videoStates[sampleId] = { currentTime: 0, paused: true, duration: 0, playbackRate: next }
  else videoStates[sampleId].playbackRate = next
  document.querySelectorAll(`video[data-vid="${sampleId}"], .detail-modal video`).forEach(el => { if (el) el.playbackRate = next })
}

// 暴露给父组件：一键预分类触发入口 + 分享快照还原/另存
defineExpose({ scriptPreClassify, classifying, loadShare, forkToMine, setShareMode, buildShareSnapshot })

// 构造当前视图自包含快照（供父组件「复制分享链接」序列化）
function buildShareSnapshot() {
  return {
    cats: cats.value.map(c => ({
      id: c.id, name: c.name, source: c.source,
      feature: c.feature || '', featureBrief: c.featureBrief || c.feature || '',
      featureDetail: c.featureDetail || '', sampleSnapshot: c.sampleSnapshot || '',
    })),
    samples: rows.value.map(r => ({
      id: r.id,
      type: r.type,
      isVideo: r.isVideo,
      mediaUrl: r.mediaUrl || '',
      ocrContent: r.ocr || '',
      asrContent: r.asr || '',
      industryL1: r.industryL1 || '',
      industryL2: r.industryL2 || '',
      elementTypeName: r.type,
      elementFingerprint: r.elementFingerprint || '',
      machineTag: r.machineTag || '',
      humanTag: r.humanTag || '',
      policyIds: r.policyIds || '',
      aiEvaluatePolicyIds: r.aiEvaluatePolicyIds || '',
      humanTagEmpty: r.humanTagEmpty || false,
      dcId: r.dcId || '',
      reviewerName: r.reviewerName || '',
      opsAdvertiserName: r.opsAdvertiserName || '',
      advertiserId: r.advertiserId || '',
      tagId: r.tagId || '',
      tagName: r.tagName || '',
      elementId: r.elementId || r.id || '',
      classNum: r.classNum || 0,
      classId: r.classId || '',
      categoryId: r.categoryId ?? null,
      featureDesc: r.featureDesc || '',
      supplement: r.supplement || '',
    })),
    view: {
      activeCat: activeCatGroup.value,
      expand: Array.from(catExpanded.value),
      onlyAnnotated: onlyAnnotated.value,
    },
  }
}

// recompile-trigger: 2026-07-22 强制 Vite 重新编译
</script>

<template>
  <div class="pa">
    <!-- 归因分类（用户自定义）+ 一键预分类 —— 仅加载素材后显示 -->
    <div class="card attr-card rise" v-if="rows.length">
      <div class="cat-hd">
        <h3><Icon name="tag" :size="16" />归因分类</h3>
        <div class="cat-hd-right">
          <span class="cat-sub">用户自定义分类，用于标注归因结论</span>
          <button class="btn btn-soft btn-sm" :disabled="classifying" @click="runPreClassify()">
            <Icon name="robot" :size="15" />{{ classifying ? '分类中…' : '一键预分类' }}
          </button>
        </div>
      </div>
      <div class="cat-add">
        <input class="field" v-model="catInput" placeholder="输入归因分类名称，如：规则变更 / 模型误判" @keyup.enter="addCat" />
        <button class="btn btn-primary btn-sm" @click="addCat"><Icon name="plus" :size="15" />添加归因分类</button>
      </div>

      <div class="cat-rows" v-if="attrCats.length">
        <div v-for="c in attrStat.list" :key="c.id" class="cat-row">
          <div class="cr-main" @click="toggleCatEdit(c.id)">
            <span class="cr-name" v-if="!catEditing.has(c.id)" @click.stop="startEditCatName(c.id)">{{ c.name }}</span>
            <input class="cr-name-input" v-else v-model="c.name" @click.stop @blur="saveCatName(c)" @keyup.enter="saveCatName(c)" />
            <span class="cr-badge">{{ c.pct }}%（{{ c.count }}/{{ attrStat.total }}）</span>
            <div class="cr-bar"><i :style="{ width: c.pct + '%' }"></i></div>
            <span class="cr-feat" v-if="c.featureBrief && !catExpanded.has(c.id)">{{ c.featureBrief }}</span>
            <Icon :name="catExpanded.has(c.id) ? 'chevronUp' : 'chevronDown'" :size="14" class="cr-caret" />
            <i class="cr-del" @click.stop="removeCat(c)"><Icon name="close" :size="12" /></i>
          </div>
          <transition name="fold">
            <div v-if="catExpanded.has(c.id)" class="cr-edit">
              <div class="cr-edit-grid">
                <div class="cr-field">
                  <div class="cr-field-hd"><Icon name="sparkle" :size="13" /><label>凝练特征（高频词语/句式）</label></div>
                  <input class="field" v-model="c.featureBrief" placeholder="如：营销推广、价格优惠、限时活动" />
                </div>
                <div class="cr-field">
                  <div class="cr-field-hd"><Icon name="edit" :size="13" /><label>具体特征（一句话）</label></div>
                  <textarea class="field" v-autosize v-model="c.featureDetail" rows="2" placeholder="一句话概括该类素材的共性问题或现象"></textarea>
                </div>
                <div class="cr-field">
                  <div class="cr-field-hd"><Icon name="doc" :size="13" /><label>原文摘录</label></div>
                  <textarea class="field" v-autosize v-model="c.sampleSnapshot" rows="5" placeholder="该分类下典型素材的原文摘录（2-3条）"></textarea>
                </div>
              </div>
              <div class="cr-edit-foot">
                <button class="btn btn-primary btn-sm" @click="saveCatFeature(c)"><Icon name="check" :size="14" />保存特征</button>
              </div>
            </div>
          </transition>
        </div>
      </div>
      <div v-else class="cat-empty">暂无归因分类，请在上方手动添加</div>

      <!-- 预分类结果（一键预分类自动生成，展示在归因分类下方） -->
      <div class="overview-section" v-if="overviewCats.length">
        <div class="overview-hd">
          <Icon name="classify" :size="14" />
          <span>预分类结果</span>
          <span class="overview-count">{{ overviewCats.length }} 个分类</span>
        </div>
        <div class="cat-rows">
          <div v-for="c in overviewStat.list" :key="c.id" class="cat-row">
            <div class="cr-main" @click="toggleCatEdit(c.id)">
              <span class="cr-name" v-if="!catEditing.has(c.id)" @click.stop="startEditCatName(c.id)">{{ c.name }}</span>
              <input class="cr-name-input" v-else v-model="c.name" @click.stop @blur="saveCatName(c)" @keyup.enter="saveCatName(c)" />
              <span class="cr-badge">{{ c.pct }}%（{{ c.count }}/{{ overviewStat.total }}）</span>
              <div class="cr-bar"><i :style="{ width: c.pct + '%' }"></i></div>
              <span class="cr-feat" v-if="c.featureBrief && !catExpanded.has(c.id)">{{ c.featureBrief }}</span>
              <span class="cr-feat cr-feat-loading" v-else-if="!c.featureBrief && classifying && !catExpanded.has(c.id)"><span class="dot-pulse"></span>特征分析中…</span>
              <Icon :name="catExpanded.has(c.id) ? 'chevronUp' : 'chevronDown'" :size="14" class="cr-caret" />
              <i class="cr-del" @click.stop="removeCat(c)"><Icon name="close" :size="12" /></i>
            </div>
            <transition name="fold">
              <div v-if="catExpanded.has(c.id)" class="cr-edit">
                <div class="cr-edit-grid">
                  <div class="cr-field">
                    <div class="cr-field-hd"><Icon name="sparkle" :size="13" /><label>凝练特征（高频词语/句式）</label></div>
                    <input class="field" v-model="c.featureBrief" placeholder="如：营销推广、价格优惠、限时活动" />
                  </div>
                  <div class="cr-field">
                    <div class="cr-field-hd"><Icon name="edit" :size="13" /><label>具体特征（一句话）</label></div>
                    <textarea class="field" v-autosize v-model="c.featureDetail" rows="2" placeholder="一句话概括该类素材的共性问题或现象"></textarea>
                  </div>
                  <div class="cr-field">
                    <div class="cr-field-hd"><Icon name="doc" :size="13" /><label>原文摘录</label></div>
                    <textarea class="field" v-autosize v-model="c.sampleSnapshot" rows="5" placeholder="该分类下典型素材的原文摘录（2-3条）"></textarea>
                  </div>
                </div>
                <div class="cr-edit-foot">
                  <button class="btn btn-primary btn-sm" @click="saveCatFeature(c)"><Icon name="check" :size="14" />保存特征</button>
                </div>
              </div>
            </transition>
          </div>
        </div>
      </div>
      <div class="overview-empty" v-else-if="rows.length">
        <Icon name="robot" :size="20" />
        <span>暂无预分类结果，点击右上角「一键预分类」自动生成</span>
      </div>

      <!-- 折叠/展开全部 -->
      <div class="cat-collapse-bar" v-if="cats.length">
        <button class="btn btn-soft btn-sm" @click="collapseAllCats"><Icon name="chevronUp" :size="14" />全部折叠</button>
        <button class="btn btn-soft btn-sm" @click="expandAllCats"><Icon name="chevronDown" :size="14" />全部展开</button>
      </div>

      <!-- 操作区：导出 + 保存 -->
      <div class="cat-actions">
        <div class="ca-right">
          <button class="btn btn-ghost btn-sm" @click="exportDoc('pdf')"><Icon name="doc" :size="15" />导出 PDF</button>
          <button class="btn btn-ghost btn-sm" @click="exportDoc('word')"><Icon name="doc" :size="15" />导出 Word</button>
          <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveConclusion"><Icon name="check" :size="15" />{{ saving ? '保存中…' : '保存结论' }}</button>
        </div>
      </div>
    </div>

    <!-- 筛选 + 展示模式 + 行数 -->
    <div class="card filter-card rise" v-if="rows.length">
      <!-- 方案B：去重展示口径说明——胶囊标「去重后」，副标题显示真实总样本数，避免误解 -->
      <div class="pa-stat-bar">
        <div class="pa-stat">
          <span class="pa-stat-cap">素材数（去重后）</span>
          <span class="pa-stat-num">{{ dedupedCount }}</span>
          <span class="pa-stat-unit">条唯一素材</span>
        </div>
        <div class="pa-stat-sub" v-if="rawTotal">
          <span class="pa-sub-cap">真实总样本数</span>
          <span class="pa-sub-num">{{ rawTotal }}</span>
          <span class="pa-sub-unit">条</span>
          <span v-if="dupMerged" class="pa-sub-dup">（已合并 {{ dupMerged }} 条重复记录）</span>
          <span v-else class="pa-sub-nodup">（无重复合并）</span>
        </div>
        <div class="pa-stat-sub" v-else>
          <span class="pa-sub-nodup">未返回真实总数，按去重后展示</span>
        </div>
      </div>
      <div class="filter-left">
        <div class="chips">
          <button v-for="t in types" :key="t.v" class="chip" :class="{ on: typeFilter===t.v }" @click="typeFilter=t.v">{{ t.v }}<b>{{ t.n }}</b></button>
        </div>
        <div class="industry-filters">
          <div class="ind-sel">
            <span class="ind-lb">一级行业</span>
            <select class="ind-dd" v-model="industryL1Filter" @change="onL1Change">
              <option v-for="o in industryL1Options" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="ind-sel">
            <span class="ind-lb">二级行业</span>
            <select class="ind-dd" v-model="industryL2Filter" :disabled="industryL2Options.length <= 1">
              <option v-for="o in industryL2Options" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="ind-sel">
            <span class="ind-lb">审核人</span>
            <select class="ind-dd" v-model="reviewerFilter">
              <option v-for="o in reviewerOptions" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="ind-sel">
            <span class="ind-lb">广告主ID</span>
            <select class="ind-dd" v-model="advertiserIdFilter">
              <option v-for="o in advertiserIdOptions" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="ind-sel">
            <span class="ind-lb">人审标签</span>
            <select class="ind-dd" v-model="humanTagFilter">
              <option v-for="o in humanTagOptions" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="filter-right">
        <div class="seg-mini">
          <button :class="{ on: displayMode==='all' }" @click="displayMode='all'">全部展示</button>
          <button :class="{ on: displayMode==='byCat' }" @click="displayMode='byCat'">分类卡片</button>
        </div>
        <div class="cols-pick">
          <span>行数</span>
          <button v-for="n in [1,4]" :key="n" :class="{ on: cols===n }" @click="cols=n">{{ n }}</button>
          <button :class="{ on: cols==='custom' }" @click="cols='custom'">自定义</button>
          <input v-if="cols==='custom'" class="col-inp" type="number" min="1" max="12" v-model="customCols" />
        </div>
        <button class="sel-btn" @click="toggleAll"><Icon name="check" :size="14" />{{ allChecked ? '取消全选' : '全选' }}</button>
        <select class="field batch-sel" v-model="batchCat">
          <option value="">移动到…</option>
          <option v-for="c in cats" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button class="btn btn-soft btn-sm" @click="batchAssign">批量归类</button>
        <button class="mode-btn" :class="{ on: onlyAnnotated }" @click="onlyAnnotated = !onlyAnnotated"><Icon name="edit" :size="14" />{{ onlyAnnotated ? '只看标注中' : '只看标注' }}</button>
      </div>
    </div>

    <!-- 素材卡片：全部展示 -->
    <div v-if="rows.length && displayMode==='all'" class="cards" :style="gridStyle" :class="{ single: activeCols===1 }">
      <!-- 单列模式：完整卡片（与标签跟踪素材预览完全一致：原生 video controls 进度条可拖动 + 一致/漏放/误杀角标） -->
      <template v-if="activeCols===1">
      <div v-for="r in displayed" :key="r.id" class="mcard card" :class="{ sel: selected.has(r.id) }" @click="openDetail(r)">
        <div class="m-media" :class="{ 'm-media-text': isTextOnly(r) }" @click.stop>
          <label class="card-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
          <template v-if="isTextOnly(r)">
            <span v-if="r.verifyStatus" class="mp-verify-badge" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
            <div class="m-text-bold">{{ r.mediaUrl || '（无文本内容）' }}</div>
          </template>
          <template v-else>
            <div class="mc-type-group mc-type-group-lg">
              <span class="m-type" :class="isVideoByUrl(r.mediaUrl) ? 'vid' : 'img'"><Icon :name="isVideoByUrl(r.mediaUrl) ? 'film' : 'image'" :size="11" />{{ cardTypeText(r) }}</span>
              <span v-if="r.verifyStatus" class="mc-verify-tag" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
            </div>
            <div v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="vid-thumb">
              <video v-lazy-video :data-src="r.mediaUrl" :data-raw-url="r.mediaUrl" :data-vid="r.id" controls playsinline muted @error="onErr(r.id)" @loadedmetadata="syncVideoState($event.target, r.id)" @click.stop></video>
            </div>
            <button v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="speed-btn" @click.stop="cycleSpeed(r.id)">{{ speedLabel(r.id) }}</button>
            <a v-else-if="isVideoByUrl(r.mediaUrl) && cardMediaErr(r.id) && r.mediaUrl" class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />视频加载失败，打开原链接</a>
            <img v-else-if="!isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" v-lazy-img :data-src="previewSrc(r.mediaUrl)" :data-raw-url="r.mediaUrl" :data-vid="r.id" referrerpolicy="no-referrer" @error="onErr(r.id)" alt="" />
            <a v-else class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="22" />打开原链接</a>
          </template>
        </div>
        <div class="m-body">
          <div class="m-head" style="cursor:pointer">
            <span class="mh-dot" :class="verifyBadge(r).cls"></span>
            <span class="mh-id">{{ r.id }}</span>
            <span class="mh-type">{{ cardTypeText(r) }}</span>
            <span class="mh-ind" v-if="r.industryL1 || r.industryL2">{{ r.industryL1 }}<template v-if="r.industryL2"> / {{ r.industryL2 }}</template></span>
          </div>
          <div class="m-tags" @click.stop>
            <span class="mt-tag mt-machine" v-if="machineTagText(r)">机审: {{ machineTagText(r) }}</span>
            <span class="mt-tag mt-human">人审: {{ humanTagText(r) }}</span>
            <span class="mt-tag mt-reviewer" v-if="r.reviewerName">审核人: {{ r.reviewerName }}</span>
            <span class="mt-tag mt-adid">广告主ID: {{ r.advertiserId || '无' }}</span>
            <span class="mt-tag mt-dcid" v-if="r.dcId">DCID: {{ r.dcId }}</span>
            <span class="mt-tag mt-fp" v-if="r.elementFingerprint" :title="r.elementFingerprint">审核物理指纹（md5）: {{ r.elementFingerprint.length > 12 ? r.elementFingerprint.slice(0, 12) + '…' : r.elementFingerprint }}</span>
            <a v-if="r.mediaUrl" class="mt-tag mt-link" :href="resolveSignedSrc(r.mediaUrl)" target="_blank" @click.stop :title="r.mediaUrl"><Icon name="link" :size="11" />原文链接</a>
          </div>
          <div class="m-section" v-if="!isTextOnly(r)" @click.stop>
            <div class="ms-hd clickable" @click="toggleCardSection(r, 'ocr')">OCR 内容<Icon :name="cardSectionOpen(r, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
            <div class="ms-body" :class="{ muted: !r.ocr, collapsed: !cardSectionOpen(r, 'ocr') }">{{ r.ocr || '—' }}</div>
          </div>
          <div class="m-section" v-if="!isTextOnly(r)" @click.stop>
            <div class="ms-hd clickable" @click="toggleCardSection(r, 'asr')">ASR 内容<Icon :name="cardSectionOpen(r, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
            <div class="ms-body" :class="{ muted: !r.asr, collapsed: !cardSectionOpen(r, 'asr') }">{{ r.asr || '—' }}</div>
          </div>
          <MaterialAnnotations class="m-supp" :tag-id="tagId" :sample-id="r.id" :media-url="r.mediaUrl" :disabled="props.shareMode" />
        </div>
      </div>
        <!-- 加载更多（单列模式） -->
        <div v-if="hasMore" class="load-more-bar">
          <button class="btn btn-ghost" @click="loadMore">加载更多（{{ filtered.length - displayed.length }} 条剩余）</button>
        </div>
      </template>
      <!-- 多列模式：紧凑卡片（与标签跟踪素材预览完全一致） -->
      <template v-if="activeCols!==1">
        <div v-for="r in displayed" :key="r.id" class="mcard card compact" :class="{ sel: selected.has(r.id) }" @click="openDetail(r)">
          <div class="m-media" v-if="!isTextOnly(r)">
            <label class="card-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
            <div class="mc-type-group">
              <span class="m-type-sm">{{ isVideoByUrl(r.mediaUrl) ? 'V' : 'I' }}</span>
              <span v-if="r.verifyStatus" class="mc-verify-tag" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
            </div>
            <div v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="vid-thumb">
              <video v-lazy-video :data-src="r.mediaUrl" :data-raw-url="r.mediaUrl" :data-vid="r.id" controls playsinline muted @error="onErr(r.id)" @loadedmetadata="syncVideoState($event.target, r.id)"></video>
            </div>
            <button v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="speed-btn" @click.stop="cycleSpeed(r.id)">{{ speedLabel(r.id) }}</button>
            <a v-else-if="isVideoByUrl(r.mediaUrl) && cardMediaErr(r.id) && r.mediaUrl" class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
            <img v-else-if="!isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" v-lazy-img :data-src="previewSrc(r.mediaUrl)" :data-raw-url="r.mediaUrl" :data-vid="r.id" referrerpolicy="no-referrer" @error="onErr(r.id)" alt="" />
            <a v-else class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
          </div>
          <div class="mc-info">
            <label class="card-cbx mc-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
            <div class="mc-r1">
              <span class="mc-badge mc-ind-badge" :class="{ on: r.industryL1 && r.industryL1 !== '未知' }">{{ r.industryL1 && r.industryL1 !== '未知' ? `${r.industryL1}${r.industryL2 ? '/' + r.industryL2 : ''}` : '行业' }}</span>
              <span class="mc-badge mc-machine-badge" v-if="machineTagText(r)" :title="machineTagText(r)">机审:{{ machineTagText(r).length > 12 ? machineTagText(r).slice(0, 12) + '…' : machineTagText(r) }}</span>
              <span class="mc-badge mc-human-badge" :title="humanTagText(r)">人审:{{ humanTagText(r).length > 8 ? humanTagText(r).slice(0, 8) + '…' : humanTagText(r) }}</span>
              <a v-if="r.mediaUrl && !isTextOnly(r)" class="mc-link-icon" :href="resolveSignedSrc(r.mediaUrl)" target="_blank" @click.stop :title="r.mediaUrl"><Icon name="link" :size="11" /></a>
            </div>
            <div class="mc-text" v-if="isTextOnly(r)">{{ r.mediaUrl || '（无文本内容）' }}</div>
            <div class="mc-r2" @click.stop>
              <select class="mc-select-sm" :class="{ 'has-cat': r.categoryId > 0 }" v-model="r.categoryId" @change="assignOne(r)">
                <option :value="null">未归类</option>
                <option v-for="c in cats" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </div>
            <div class="mc-r3" @click.stop>
              <MaterialAnnotations :tag-id="tagId" :sample-id="r.id" :media-url="r.mediaUrl" :disabled="props.shareMode" lastOnly />
            </div>
          </div>
        </div>
        <!-- 加载更多（多列模式） -->
        <div v-if="hasMore" class="load-more-bar">
          <button class="btn btn-ghost" @click="loadMore">加载更多（{{ filtered.length - displayed.length }} 条剩余）</button>
        </div>
      </template>
    </div>

    <!-- 素材卡片：分类卡片模式 -->
    <div v-else-if="rows.length && displayMode==='byCat'" class="by-cat">

      <!-- 概览：分类卡片网格 -->
      <div v-if="activeCatGroup === null" class="cat-overview">
        <div class="cat-overview-hint">
          <Icon name="grid" :size="14" />
          <span>点击分类卡片查看该分类下的素材</span>
        </div>
        <div class="cat-cards-grid">
          <div v-for="g in grouped" :key="g.id ?? 'un'" class="cat-card-mini card rise" :class="{ empty: !g.items.length }" @click="g.items.length && (activeCatGroup = g.id)">
            <div class="ccm-top">
              <div class="ccm-icon"><Icon name="box" :size="20" /></div>
              <div class="ccm-count">{{ g.items.length }}</div>
            </div>
            <div class="ccm-name">{{ g.name }}</div>
            <div class="ccm-feature" v-if="g.featureBrief">{{ g.featureBrief }}</div>
            <div class="ccm-bar"><i :style="{ width: Math.min(100, Math.round(g.items.length / (filtered.length || 1) * 100)) + '%' }"></i></div>
            <div class="ccm-pct">{{ Math.round(g.items.length / (filtered.length || 1) * 100) }}% · {{ g.items.length }} 条</div>
          </div>
        </div>
      </div>

      <!-- 钻取：某分类下的素材列表 -->
      <template v-else>
        <div class="cat-drill-hd">
          <button class="btn btn-soft btn-sm" @click="activeCatGroup = null"><Icon name="chevronLeft" :size="14" />返回分类</button>
          <h4>{{ (grouped.find(g => g.id === activeCatGroup) || {}).name || '未归类' }}</h4>
          <span class="cg-n">{{ (grouped.find(g => g.id === activeCatGroup) || { items: [] }).items.length }} 条</span>
          <em v-if="(grouped.find(g => g.id === activeCatGroup) || {}).feature">{{ (grouped.find(g => g.id === activeCatGroup) || {}).feature }}</em>
        </div>
        <div class="cards" :style="gridStyle" :class="{ single: activeCols===1 }">
          <!-- 单列模式（与标签跟踪素材预览完全一致） -->
          <template v-if="activeCols===1">
          <div v-for="r in (grouped.find(g => g.id === activeCatGroup) || { items: [] }).items" :key="r.id" class="mcard card" :class="{ sel: selected.has(r.id) }" @click="openDetail(r)">
            <div class="m-media" :class="{ 'm-media-text': isTextOnly(r) }" @click.stop>
              <label class="card-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
              <template v-if="isTextOnly(r)">
                <span v-if="r.verifyStatus" class="mp-verify-badge" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
                <div class="m-text-bold sm">{{ r.mediaUrl || '（无文本）' }}</div>
              </template>
              <template v-else>
                <div class="mc-type-group mc-type-group-lg">
                  <span class="m-type" :class="isVideoByUrl(r.mediaUrl) ? 'vid' : 'img'"><Icon :name="isVideoByUrl(r.mediaUrl) ? 'film' : 'image'" :size="11" />{{ cardTypeText(r) }}</span>
                  <span v-if="r.verifyStatus" class="mc-verify-tag" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
                </div>
                <div v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="vid-thumb">
                  <video v-lazy-video :data-src="r.mediaUrl" :data-raw-url="r.mediaUrl" :data-vid="r.id" controls playsinline muted @error="onErr(r.id)" @loadedmetadata="syncVideoState($event.target, r.id)" @click.stop></video>
                </div>
                <button v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="speed-btn" @click.stop="cycleSpeed(r.id)">{{ speedLabel(r.id) }}</button>
                <a v-else-if="isVideoByUrl(r.mediaUrl) && cardMediaErr(r.id) && r.mediaUrl" class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" />视频加载失败，打开原链接</a>
                <img v-else-if="!isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" v-lazy-img :data-src="previewSrc(r.mediaUrl)" :data-raw-url="r.mediaUrl" :data-vid="r.id" referrerpolicy="no-referrer" @error="onErr(r.id)" alt="" />
                <a v-else class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" />打开原链接</a>
              </template>
            </div>
            <div class="m-body">
              <div class="m-head" style="cursor:pointer">
                <span class="mh-dot" :class="verifyBadge(r).cls"></span>
                <span class="mh-id">{{ r.id }}</span>
                <span class="mh-type">{{ cardTypeText(r) }}</span>
                <span class="mh-ind" v-if="r.industryL1 || r.industryL2">{{ r.industryL1 }}<template v-if="r.industryL2"> / {{ r.industryL2 }}</template></span>
              </div>
              <div class="m-tags" @click.stop>
                <span class="mt-tag mt-machine" v-if="machineTagText(r)">机审: {{ machineTagText(r) }}</span>
                <span class="mt-tag mt-human">人审: {{ humanTagText(r) }}</span>
                <span class="mt-tag mt-reviewer" v-if="r.reviewerName">审核人: {{ r.reviewerName }}</span>
                <span class="mt-tag mt-adid">广告主ID: {{ r.advertiserId || '无' }}</span>
                <span class="mt-tag mt-dcid" v-if="r.dcId">DCID: {{ r.dcId }}</span>
                <span class="mt-tag mt-fp" v-if="r.elementFingerprint" :title="r.elementFingerprint">审核物理指纹（md5）: {{ r.elementFingerprint.length > 12 ? r.elementFingerprint.slice(0, 12) + '…' : r.elementFingerprint }}</span>
                <a v-if="r.mediaUrl" class="mt-tag mt-link" :href="resolveSignedSrc(r.mediaUrl)" target="_blank" @click.stop :title="r.mediaUrl"><Icon name="link" :size="11" />原文链接</a>
              </div>
              <div class="m-cattags" @click.stop>
                <div class="mc-title">归因分类</div>
                <select class="mc-select" :class="{ 'has-cat': r.categoryId > 0 }" v-model="r.categoryId" @change="assignOne(r)">
                  <option :value="null">未归类</option>
                  <option v-for="c in cats" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </div>
              <div class="m-section" v-if="!isTextOnly(r)" @click.stop>
                <div class="ms-hd clickable" @click="toggleCardSection(r, 'ocr')">OCR<Icon :name="cardSectionOpen(r, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                <div class="ms-body" :class="{ muted: !r.ocr, collapsed: !cardSectionOpen(r, 'ocr') }">{{ r.ocr || '—' }}</div>
              </div>
              <div class="m-section" v-if="!isTextOnly(r)" @click.stop>
                <div class="ms-hd clickable" @click="toggleCardSection(r, 'asr')">ASR<Icon :name="cardSectionOpen(r, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" class="ms-caret" /></div>
                <div class="ms-body" :class="{ muted: !r.asr, collapsed: !cardSectionOpen(r, 'asr') }">{{ r.asr || '—' }}</div>
              </div>
              <MaterialAnnotations class="m-supp" :tag-id="tagId" :sample-id="r.id" :media-url="r.mediaUrl" :disabled="props.shareMode" />
            </div>
          </div>
          </template>
          <!-- 多列模式：紧凑卡片（与标签跟踪素材预览完全一致） -->
          <template v-if="activeCols!==1">
            <div v-for="r in (grouped.find(g => g.id === activeCatGroup) || { items: [] }).items" :key="r.id" class="mcard card compact" :class="{ sel: selected.has(r.id) }" @click="openDetail(r)">
              <div class="m-media" v-if="!isTextOnly(r)">
                <label class="card-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
                <div class="mc-type-group">
                  <span class="m-type-sm">{{ isVideoByUrl(r.mediaUrl) ? 'V' : 'I' }}</span>
                  <span v-if="r.verifyStatus" class="mc-verify-tag" :class="verifyBadge(r).cls">{{ verifyBadge(r).label }}</span>
                </div>
                <div v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="vid-thumb">
                  <video v-lazy-video :data-src="r.mediaUrl" :data-raw-url="r.mediaUrl" :data-vid="r.id" controls playsinline muted @error="onErr(r.id)" @loadedmetadata="syncVideoState($event.target, r.id)"></video>
                </div>
                <button v-if="isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" class="speed-btn" @click.stop="cycleSpeed(r.id)">{{ speedLabel(r.id) }}</button>
                <a v-else-if="isVideoByUrl(r.mediaUrl) && cardMediaErr(r.id) && r.mediaUrl" class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
                <img v-else-if="!isVideoByUrl(r.mediaUrl) && !cardMediaErr(r.id) && !isLinkOnly(r)" v-lazy-img :data-src="previewSrc(r.mediaUrl)" :data-raw-url="r.mediaUrl" :data-vid="r.id" referrerpolicy="no-referrer" @error="onErr(r.id)" alt="" />
                <a v-else class="m-fallback" :href="previewSrc(r.mediaUrl)" target="_blank" @click.stop><Icon name="link" :size="18" /></a>
              </div>
              <div class="mc-info" @click.stop>
                <label class="card-cbx mc-cbx" :class="{ on: selected.has(r.id) }" @click.stop="toggle(r.id)"><Icon v-if="selected.has(r.id)" name="check" :size="12" /></label>
                <div class="mc-r1">
                  <span class="mc-badge mc-ind-badge" :class="{ on: r.industryL1 && r.industryL1 !== '未知' }">{{ r.industryL1 && r.industryL1 !== '未知' ? `${r.industryL1}${r.industryL2 ? '/' + r.industryL2 : ''}` : '行业' }}</span>
                  <span class="mc-badge mc-machine-badge" v-if="machineTagText(r)" :title="machineTagText(r)">机审:{{ machineTagText(r).length > 12 ? machineTagText(r).slice(0, 12) + '…' : machineTagText(r) }}</span>
                  <span class="mc-badge mc-human-badge" :title="humanTagText(r)">人审:{{ humanTagText(r).length > 8 ? humanTagText(r).slice(0, 8) + '…' : humanTagText(r) }}</span>
                  <a v-if="r.mediaUrl && !isTextOnly(r)" class="mc-link-icon" :href="resolveSignedSrc(r.mediaUrl)" target="_blank" @click.stop :title="r.mediaUrl"><Icon name="link" :size="11" /></a>
                </div>
                <div class="mc-text" v-if="isTextOnly(r)">{{ r.mediaUrl || '（无文本内容）' }}</div>
                <div class="mc-r2">
                  <select class="mc-select-sm" :class="{ 'has-cat': r.categoryId > 0 }" v-model="r.categoryId" @change="assignOne(r)">
                    <option :value="null">未归类</option>
                    <option v-for="c in cats" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                </div>
                <div class="mc-r3">
                  <MaterialAnnotations :tag-id="tagId" :sample-id="r.id" :media-url="r.mediaUrl" :disabled="props.shareMode" lastOnly />
                </div>
              </div>
            </div>
          </template>
        </div>
      </template>

    </div>

    <div v-else class="card">
      <EmptyState icon="image" title="请先加载素材" desc="可先上传数据，系统会自动解析出标签供你选择；或在上方「选择标签」中输入标签 ID/名称并点击「一键加载」，即可载入该标签下全部误杀素材进行预分类" />
    </div>

    <!-- 选择浮条 -->
    <transition name="pop">
      <div v-if="selected.size" class="sel-bar">
        <span>已选 <b>{{ selected.size }}</b> 条素材</span>
        <button class="btn-clear" @click="selected = new Set()">清空</button>
        <button class="btn btn-primary btn-sm" @click="goTicket"><Icon name="ticket" :size="15" />前往提需</button>
        <button class="btn btn-primary btn-sm" @click="exportExcel"><Icon name="download" :size="15" />导出 Excel</button>
      </div>
    </transition>

    <!-- TRAG 相似素材检索弹窗（统一弹窗入口） -->
    <TragSearchModal
      :visible="tragSearchVisible"
      :material="tragSearchMaterial"
      :cats="cats"
      :tag-id="tagId"
      @close="closeTragSearch"
      @assign="onTragAssign"
    />
  </div>
</template>

<style scoped>
.cat-card { padding: 16px 20px; margin-bottom: 14px; }
.attr-card { padding: 16px 20px; margin-bottom: 14px; border-left: 3px solid var(--brand); }
.cat-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.cat-hd h3 { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 7px; }
.cat-hd h3 svg { color: var(--brand); }
.cat-sub { font-size: 12px; color: var(--text-4); }
.cat-add { display: flex; gap: 10px; margin-bottom: 12px; }
.cat-add .field { flex: 1; height: 34px; font-size: 13px; }
.cat-rows { display: flex; flex-direction: column; gap: 8px; }
.cat-row { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; transition: all .18s; }
.cat-row:hover { border-color: var(--border-strong); }
.cr-main { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; }
.cr-name { font-size: 13px; font-weight: 700; min-width: 90px; }
.cr-badge { font-size: 11px; font-weight: 700; color: var(--brand); background: var(--brand-soft); padding: 2px 9px; border-radius: 20px; }
.cr-bar { flex: 1; min-width: 80px; height: 7px; background: #eef1f6; border-radius: 6px; overflow: hidden; }
.cr-bar i { display: block; height: 100%; background: linear-gradient(90deg, #5b7cfa, #7c6df0); border-radius: 6px; transition: width .5s; }
.cr-pct { font-size: 13px; font-weight: 800; color: var(--brand); min-width: 40px; text-align: right; }
.cr-feat { font-size: 12px; color: var(--text-3); flex: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-feat-loading { color: var(--brand); display: inline-flex; align-items: center; gap: 6px; font-style: italic; }
.dot-pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--brand); animation: dotPulse 1s infinite ease-in-out; }
@keyframes dotPulse { 0%, 100% { opacity: .3; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
.cr-caret { color: var(--text-4); }
.cr-del { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; color: var(--text-4); cursor: pointer; transition: all .15s; }
.cr-del:hover { background: #ffe9e9; color: #e5484d; }
.cr-edit { padding: 14px 16px 16px; background: linear-gradient(180deg, #f8faff 0%, #f1f5ff 100%); border-top: 1px solid #e0e8ff; }
.cr-edit-grid { display: flex; flex-direction: column; gap: 14px; }
.cr-field { display: flex; flex-direction: column; gap: 6px; }
.cr-field-hd { display: flex; align-items: center; gap: 6px; }
.cr-field-hd svg { color: var(--brand); flex-shrink: 0; }
.cr-field-hd label { font-size: 12px; font-weight: 600; color: var(--text-2); }
.cr-field .field { width: 100%; font-size: 13px; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: 9px; background: #fff; color: var(--text-1); transition: all .18s; box-sizing: border-box; resize: vertical; font-family: inherit; }
.cr-field .field:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.cr-field .field::placeholder { color: var(--text-4); }
.cr-edit-foot { display: flex; justify-content: flex-end; margin-top: 12px; }
.cat-collapse-bar { display: flex; justify-content: center; gap: 10px; margin-top: 10px; }
.cat-empty { font-size: 12px; color: var(--text-4); padding: 8px 0; }
.cat-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
.ca-left { display: flex; gap: 10px; flex-wrap: wrap; }
.ca-right { display: flex; gap: 10px; }
.btn-ghost { border: 1px solid var(--border-strong); background: #fff; color: var(--text-2); }
.btn-ghost:hover { border-color: var(--brand); color: var(--brand); }

.pre-card { padding: 14px 20px; margin-bottom: 14px; }

.filter-card { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; }
.filter-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.industry-filters { display: flex; align-items: center; gap: 10px; }
.ind-sel { display: flex; align-items: center; gap: 6px; }
.ind-lb { font-size: 12px; font-weight: 600; color: var(--text-3); white-space: nowrap; }
.ind-dd { height: 32px; padding: 0 28px 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; font-size: 12px; color: var(--text-1); background: #fff; cursor: pointer; transition: all .15s; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; max-width: 180px; }
.ind-dd:hover { border-color: var(--brand); }
.ind-dd:focus { border-color: var(--brand); outline: none; box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.ind-dd:disabled { opacity: .5; cursor: not-allowed; }
.filter-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); font-size: 13px; color: var(--text-2); background: #fff; transition: all .18s; }
.chip.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); font-weight: 600; }
.chip b { color: var(--text-4); } .chip.on b { color: var(--brand); }
.seg-mini, .cols-pick { display: flex; align-items: center; background: #f0f2f6; border-radius: 9px; padding: 3px; gap: 2px; }
.seg-mini button, .cols-pick button { height: 28px; padding: 0 12px; border-radius: 7px; font-size: 12px; color: var(--text-3); transition: all .15s; }
.seg-mini button.on, .cols-pick button.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); font-weight: 600; }
.cols-pick { padding: 3px 3px 3px 10px; } .cols-pick > span { font-size: 12px; color: var(--text-4); margin-right: 4px; }
.col-inp { width: 46px; height: 26px; margin-left: 4px; border: 1px solid var(--border-strong); border-radius: 6px; font-size: 12px; text-align: center; }
.batch-sel { height: 32px; font-size: 12px; min-width: 110px; }
.mode-btn { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); font-size: 13px; color: var(--text-2); background: #fff; cursor: pointer; transition: all .18s; }
.mode-btn:hover, .mode-btn.on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
.sel-btn { display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--brand); font-size: 13px; color: var(--brand); background: var(--brand-soft); cursor: pointer; font-weight: 600; }

.cards { display: grid; gap: 18px; }
.cards.single { display: flex; flex-direction: column; }
/* 多列模式：列数由内联 gridStyle 控制（用户选择的列数），不在此处强制覆盖 */
.mcard { overflow: hidden; transition: all .2s; position: relative; border: 1.5px solid #dbeee2; border-radius: 16px; background: #fff; box-shadow: 0 2px 10px rgba(30,120,70,.05); }
.mcard:hover { box-shadow: 0 6px 22px rgba(30,120,70,.12); border-color: #b9e3c9; }
.mcard.sel { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }

/* 横向布局：仅单列模式媒体区固定大方形，右侧内容宽 */
.cards.single .mcard { display: flex; align-items: flex-start; }
.cards.single .m-media { width: 540px; height: 540px; flex-shrink: 0; border-right: none; }
.cards.single .m-body { max-height: 540px; overflow-y: auto; }

/* 加载更多按钮 */
.load-more-bar { display: flex; align-items: center; justify-content: center; padding: 20px 0; grid-column: 1 / -1; }
.load-more-bar .btn { padding: 10px 28px; font-size: 14px; border-radius: 10px; color: var(--brand); border: 1.5px dashed var(--brand); background: var(--brand-soft); cursor: pointer; transition: all .18s; }
.load-more-bar .btn:hover { background: var(--brand); color: #fff; }

/* 多列模式：紧凑卡片 —— 媒体区自带比例，卡片高度随内容自适应，内容不被遮盖 */
.cards:not(.single) .mcard { display: flex; flex-direction: column; cursor: pointer; container-type: inline-size; }
.cards:not(.single) .mcard.compact .m-media { width: 100%; flex: 0 0 auto; min-height: 0; max-width: none; padding: 4px; aspect-ratio: 4/3; }
.cards:not(.single) .mcard.compact .m-media img,
.cards:not(.single) .mcard.compact .m-media video { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
.mcard.compact .mc-info { display: flex; flex-direction: column; gap: clamp(4px, 1.8cqw, 8px); padding: clamp(7px, 3cqw, 12px) clamp(8px, 3.5cqw, 14px) clamp(8px, 3.5cqw, 14px); background: #fff; border-top: 1px solid #eef2ee; flex: 0 0 auto; min-height: 0; position: relative; }
.mc-r1 { display: flex; align-items: center; gap: clamp(5px, 2cqw, 10px); font-size: clamp(13px, 5cqw, 18px); min-width: 0; overflow: hidden; }
.mc-r1 .mc-dot { width: clamp(8px, 2.5cqw, 10px); height: clamp(8px, 2.5cqw, 10px); border-radius: 50%; background: #c6ccd8; flex-shrink: 0; }
.mc-r1 .mc-dot.done { background: var(--brand); }
.mc-r1 .mc-id { display: none; }
.mc-type-tag { font-size: clamp(11px, 3.8cqw, 15px); padding: 3px clamp(5px, 2cqw, 10px); border-radius: 5px; background: #f0f2f6; color: var(--text-3); flex-shrink: 0; white-space: nowrap; }
.mc-ind { font-size: 9px; color: var(--brand); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc-link-icon { display: flex; color: var(--text-4); margin-left: auto; flex-shrink: 0; transition: color .15s; }
.mc-link-icon:hover { color: var(--brand); }
.mc-cat-name { font-size: clamp(11px, 4cqw, 15px); color: var(--brand); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc-text { font-size: clamp(11px, 4cqw, 14px); font-weight: 700; color: var(--text-1); line-height: 1.5; white-space: pre-wrap; word-break: break-word; padding: clamp(4px, 2cqw, 8px) clamp(5px, 2.5cqw, 10px); background: #f7f9fc; border-left: 3px solid var(--green); border-radius: 5px; max-height: 80px; overflow-y: auto; }
.mc-r2 { display: flex; align-items: center; gap: clamp(4px, 1.5cqw, 8px); }
.mc-select-sm { flex: 1; min-width: 0; font-size: clamp(10px, 3.5cqw, 13px); padding: clamp(3px, 1.5cqw, 6px) clamp(4px, 2cqw, 9px); padding-right: clamp(14px, 7cqw, 26px); border-radius: 5px; border: 1px solid var(--border); background: #f7f8fa; color: var(--text-2); cursor: pointer; line-height: 1.3; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right clamp(4px, 2cqw, 8px) center; }
.mc-select-sm:hover { border-color: var(--brand); }
.mc-select-sm.has-cat { border-color: var(--brand); background-color: #e8eaff; color: var(--brand); font-weight: 600; }
.mc-r3 { display: flex; }
.mc-badge { font-size: clamp(11px, 3.8cqw, 15px); font-weight: 600; padding: 3px clamp(5px, 2cqw, 10px); border-radius: 5px; background: #f0f2f6; color: var(--text-4); flex-shrink: 0; }
.mc-badge.mc-ind-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: clamp(80px, 40cqw, 200px); font-weight: 700; font-size: clamp(11px, 3.8cqw, 14px); color: var(--brand); background: #e8eaff; border: 1.5px solid #b3c6ff; }
.mc-badge.on { background: #e8f5ed; color: #2ec16a; }
.mc-badge.mc-machine-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: clamp(70px, 30cqw, 140px); background: #e8f0fe; color: #1a73e8; }
.mc-badge.mc-human-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: clamp(70px, 30cqw, 140px); background: #e6f4ea; color: #137333; }
.mc-badge.mc-fp-badge { background: #eceff1; color: #37474f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; flex-shrink: 0; }
.mc-badge.mc-dup-badge { background: #f0f2f6; color: #9aa3b2; flex-shrink: 0; }
.mc-badge.mc-dup-badge.on { background: #fff3e0; color: #e08e0b; font-weight: 700; }
.mc-supp-sm { width: 100%; font-size: clamp(10px, 3.5cqw, 13px); padding: clamp(4px, 2cqw, 7px) clamp(4px, 2cqw, 9px); border: 1px solid var(--border); border-radius: 5px; background: #fafbfc; color: var(--text-2); line-height: 1.3; }
.mc-supp-sm::placeholder { color: var(--text-4); font-size: clamp(9px, 3.2cqw, 12px); }
.mc-supp-sm:focus { border-color: var(--brand); outline: none; }
.m-type-sm { position: absolute; top: 6px; left: 6px; z-index: 2; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(45,52,66,.75); color: #dfe4ee; }
/* 多列紧凑卡片：V 标识与审核角标并排（角标在 V 右侧） */
.mc-type-group { position: absolute; top: 6px; left: 6px; z-index: 2; display: flex; align-items: center; gap: 4px; }
.mc-type-group .m-type-sm { position: static; }
/* 单列卡片：类型标签（Video）与审核角标并排，角标在类型右侧 */
.mc-type-group-lg { position: absolute; top: 14px; left: 14px; z-index: 2; display: flex; align-items: center; gap: 6px; }
.mc-type-group-lg .m-type { position: static; }
.mc-verify-tag { padding: 2px 8px; border-radius: 6px; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .5px; pointer-events: none; white-space: nowrap; line-height: 1; }
.mc-verify-tag.v-consistent { background: #1fb574; box-shadow: 0 2px 8px rgba(31,181,116,.45); }
.mc-verify-tag.v-miss { background: #f5a000; box-shadow: 0 2px 8px rgba(245,160,0,.45); }
.mc-verify-tag.v-fp { background: #e5484d; box-shadow: 0 2px 8px rgba(229,72,77,.45); }
.mp-verify-badge { position: absolute; top: 12px; left: 12px; z-index: 3; padding: 3px 10px; border-radius: 6px; color: #fff; font-size: 12px; font-weight: 700; letter-spacing: .5px; pointer-events: none; white-space: nowrap; }
.mp-verify-badge.v-consistent { background: #1fb574; box-shadow: 0 2px 8px rgba(31,181,116,.45); }
.mp-verify-badge.v-miss { background: #f5a000; box-shadow: 0 2px 8px rgba(245,160,0,.45); }
.mp-verify-badge.v-fp { background: #e5484d; box-shadow: 0 2px 8px rgba(229,72,77,.45); }
.speed-btn { position: absolute; bottom: 8px; right: 8px; z-index: 5; padding: 4px 10px; border-radius: 8px; background: rgba(20,24,34,.6); color: #fff; font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,.25); cursor: pointer; backdrop-filter: blur(4px); transition: all .15s; }
.speed-btn:hover { background: rgba(40,120,255,.85); border-color: rgba(255,255,255,.5); transform: scale(1.05); }

/* 视频点击加载：封面占位 + 播放按钮覆盖 */
.vid-thumb { position: relative; width: 100%; height: 100%; cursor: pointer; background: linear-gradient(135deg, #1a1e2a 0%, #252a3a 50%, #1a1e2a 100%); border-radius: 8px; display: flex; align-items: center; justify-content: center; min-height: 180px; }
.vid-thumb video { width: 100%; height: 100%; object-fit: contain; border-radius: 8px; }
.vid-play-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.35); border-radius: 8px; transition: background .2s; }
.vid-play-overlay:hover { background: rgba(0,0,0,.5); }
.vid-play-icon { width: 0; height: 0; border-style: solid; border-width: 16px 0 16px 28px; border-color: transparent transparent transparent rgba(255,255,255,.9); filter: drop-shadow(0 2px 6px rgba(0,0,0,.4)); transition: transform .2s; }
.vid-thumb:hover .vid-play-icon { transform: scale(1.15); }

.m-media { position: relative; background: #12161f; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 12px; box-sizing: border-box; }
.m-media-text { background: #f7f9fc; align-items: flex-start; justify-content: flex-start; overflow: auto; }
.m-text-bold { font-weight: 700; font-size: 14px; color: var(--text-1); line-height: 1.7; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--green); padding: 12px 14px; width: 100%; box-sizing: border-box; }
.m-text-bold.sm { font-size: 13px; padding: 10px 12px; }
.m-media img, .m-media video { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; border-radius: 8px; box-sizing: border-box; }
.m-type { position: absolute; top: 14px; left: 14px; z-index: 2; display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: .3px; background: rgba(30,35,48,.88); color: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.3); line-height: 1; white-space: nowrap; }
.m-type.vid { background: transparent; box-shadow: none; text-shadow: 0 1px 4px rgba(0,0,0,.55); }
.m-type.img { background: rgba(30,35,48,.88); }
.m-fallback { display: flex; flex-direction: column; align-items: center; gap: 6px; color: #8b94a8; font-size: 12px; padding: 16px; text-align: center; }

.m-body { flex: 1; padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-y: auto; }
.mcard.mini .m-body { padding: 12px 14px; gap: 9px; }

/* 头部：状态点 + 编号 + 类型 */
.m-head { display: flex; align-items: center; gap: 10px; }
/* 标签行：机审/人审/DCID */
.m-tags { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 0; }
.mt-tag { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 5px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.mt-machine { background: #e8f0fe; color: #1a73e8; }
.mt-human { background: #e6f4ea; color: #137333; }
.mt-reviewer { background: #fef7e0; color: #b06000; }
.mt-ops { background: #e0f2f1; color: #00695c; }
.mt-adid { background: #fce4ec; color: #c62828; }
.mc-adid-badge { flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: clamp(90px, 45%, 220px); background: #fce4ec; color: #c62828; font-weight: 600; }
.mc-adid-badge:not(.on) { background: #f1f3f5; color: #9aa3b2; }
  .mt-dcid { background: #f3e8fd; color: #7b1fa2; }
  .mt-fp { background: #eceff1; color: #37474f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mh-dot { width: 9px; height: 9px; border-radius: 50%; background: #c6ccd8; flex-shrink: 0; }
.mh-dot.v-consistent { background: #1fb574; box-shadow: 0 0 0 3px rgba(31,181,116,.15); }
.mh-dot.v-miss { background: #f5a000; box-shadow: 0 0 0 3px rgba(245,160,0,.15); }
.mh-dot.v-fp { background: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
.mh-dot.done { background: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.15); }
.mh-id { font-size: 15px; font-weight: 800; color: var(--text-1); }
.mh-type { font-size: 13px; color: var(--text-3); }
.mh-ind { font-size: 13px; font-weight: 700; color: var(--brand); background: #e8eaff; padding: 3px 10px; border-radius: 6px; margin-left: auto; white-space: nowrap; border: 1.5px solid #b3c6ff; }

/* 原链接：紧凑徽章 */
.m-url { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-3); padding: 2px 8px; border-radius: 6px; background: #f0f1f3; text-decoration: none; transition: all .15s; white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.m-url:hover { color: var(--brand); background: #e8eaff; }
.m-url.sm { font-size: 10.5px; padding: 2px 6px; }
.m-url.full { max-width: none; white-space: normal; word-break: break-all; line-height: 1.4; padding: 0; font-size: 12px; background: none; color: var(--text-3); }
.m-url.full:hover { background: none; color: var(--brand); }
.m-url.full .m-url-txt { display: inline; }

/* 归因分类 下拉 */
.m-cattags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mc-title { font-size: 13px; font-weight: 700; color: var(--text-2); margin-bottom: 0; flex-shrink: 0; }
.mc-cat-tag { display: inline-flex; align-items: center; font-size: 12px; font-weight: 600; padding: 5px 16px; border-radius: 6px; background: #e8eaff; color: var(--brand); white-space: nowrap; cursor: pointer; transition: all .15s; border: 1px solid #c5d3ff; }
.mc-cat-tag:hover { background: #d4deff; }
.m-cattags .mc-select { flex: 1 1 180px; width: auto; }
.m-cattags.sm .mc-title { font-size: 12px; margin-bottom: 0; }
.mc-select { width: 100%; font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: #f7f8fa; color: var(--text-2); cursor: pointer; transition: all .15s; line-height: 1.3; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 32px; }
.m-cattags.sm .mc-select { font-size: 11px; padding: 5px 10px; padding-right: 28px; border-radius: 7px; }
.mc-select:hover { border-color: var(--brand); color: var(--brand); background-color: #fff; }
.mc-select:focus { border-color: var(--brand); outline: none; box-shadow: 0 0 0 3px rgba(79,124,255,.15); }
.mc-select.has-cat { border-color: var(--brand); background-color: #e8eaff; color: var(--brand); font-weight: 600; }

/* TRAG 检索触发按钮 */
.m-trag-btn-wrap { margin-top: 8px; }
.trag-trigger { width: 100%; justify-content: center; }
.trag-trigger-sm { flex-shrink: 0; padding: 2px clamp(3px, 1.5cqw, 7px); font-size: clamp(10px, 3.5cqw, 13px); border-radius: 4px; gap: 2px; white-space: nowrap; line-height: 1.3; background: transparent; border: none; color: var(--brand); cursor: pointer; }

/* 内容分区（OCR/ASR 可折叠） */
.m-section { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fafbfc; }
.m-section.sm { border-radius: 8px; }
.ms-hd { display: flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12px; font-weight: 600; color: var(--text-3); background: #f0f2f6; }
.m-section.sm .ms-hd { font-size: 11px; padding: 5px 10px; }
.ms-badge { font-size: 10px; color: #fff; background: #b0b7c3; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
.ms-body { padding: 9px 12px; font-size: 12.5px; color: var(--text-1); line-height: 1.6; word-break: break-word; white-space: pre-wrap; max-height: 120px; overflow-y: auto; transition: max-height .25s ease, padding .25s ease; }
.ms-body.collapsed { max-height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; }
.ms-hd.clickable { cursor: pointer; user-select: none; }
.ms-hd.clickable:hover { color: var(--brand); }
.ms-caret { margin-left: auto; color: var(--text-4); }
.m-section.sm .ms-body { font-size: 11px; padding: 6px 10px; max-height: 90px; }
.m-section.sm .ms-body.collapsed { max-height: 0; padding-top: 0; padding-bottom: 0; }
.ms-body.muted { color: var(--text-4); font-style: italic; }

/* 补充说明 */
.m-supp { display: flex; flex-direction: column; gap: 6px; }
.ms-lb { font-size: 13px; font-weight: 700; color: var(--text-2); }
.m-cattags.sm ~ .m-supp .ms-lb, .m-supp-inp.sm ~ .ms-lb { font-size: 12px; }
.m-supp-inp { width: 100%; height: 40px; border: 1px solid var(--border-strong); border-radius: 10px; padding: 0 14px; font-size: 13px; color: var(--text-1); background: #fff; transition: all .15s; box-sizing: border-box; }
.m-supp-inp:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.m-supp-inp.sm { height: 34px; font-size: 12px; padding: 0 12px; }

/* 文本素材 */
.m-text { font-size: 13px; color: var(--text-1); line-height: 1.6; background: #f7f9fc; border-radius: 10px; padding: 12px 14px; white-space: pre-wrap; word-break: break-word; border-left: 3px solid var(--green); }
.m-text.sm { font-size: 12px; padding: 8px; }
.card-cbx { position: absolute; top: 12px; right: 12px; z-index: 3; width: 22px; height: 22px; border-radius: 7px; border: 1.5px solid rgba(255,255,255,.7); background: rgba(0,0,0,.3); backdrop-filter: blur(4px); display: grid; place-items: center; color: #fff; cursor: pointer; }
.card-cbx.on { background: var(--brand); border-color: var(--brand); }
/* mc-info 内的复选框：定位在信息区右上角 */
.mc-cbx { top: 6px; right: 6px; border-color: var(--border-strong); background: rgba(255,255,255,.9); color: var(--brand); }
.mc-cbx.on { background: var(--brand); border-color: var(--brand); color: #fff; }

.by-cat { display: flex; flex-direction: column; gap: 16px; }
.cat-group { padding: 14px 18px; }
.cg-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.cg-hd h4 { font-size: 14px; font-weight: 700; }
.cg-n { font-size: 11px; font-weight: 700; color: var(--brand); background: var(--brand-soft); padding: 2px 9px; border-radius: 20px; }
.cg-hd em { font-style: normal; font-size: 12px; color: var(--text-4); }

/* 分类卡片概览 */
.cat-overview-hint { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-3); margin-bottom: 14px; padding: 0 2px; }
.cat-cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.cat-card-mini { padding: 16px 18px; cursor: pointer; transition: transform .2s, box-shadow .2s; border: 1.5px solid #eaedf3; }
.cat-card-mini:hover { transform: translateY(-3px); box-shadow: 0 8px 24px rgba(92,122,254,.12); border-color: var(--brand); }
.cat-card-mini.empty { opacity: .5; cursor: default; }
.cat-card-mini.empty:hover { transform: none; box-shadow: none; border-color: #eaedf3; }
.ccm-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ccm-icon { width: 36px; height: 36px; border-radius: 9px; background: var(--brand-soft); color: var(--brand); display: flex; align-items: center; justify-content: center; }
.ccm-count { font-size: 26px; font-weight: 800; color: var(--text-1); line-height: 1; }
.ccm-name { font-size: 14px; font-weight: 700; color: var(--text-1); margin-bottom: 4px; }
.ccm-feature { font-size: 11.5px; color: var(--text-3); line-height: 1.4; margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccm-bar { height: 4px; background: #eef0f5; border-radius: 4px; overflow: hidden; margin-bottom: 6px; }
.ccm-bar i { display: block; height: 100%; background: var(--brand); border-radius: 4px; transition: width .3s; }
.ccm-pct { font-size: 11px; color: var(--text-4); font-weight: 500; }

/* 分类钻取视图 */
.cat-drill-hd { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.cat-drill-hd h4 { font-size: 16px; font-weight: 700; color: var(--text-1); }
.cat-drill-hd em { font-style: normal; font-size: 12.5px; color: var(--text-4); }
.mcard.mini .m-body { padding: 9px 11px; gap: 6px; }

/* 详情弹窗 */
.detail-overlay { position: fixed; inset: 0; background: rgba(15,22,36,.55); backdrop-filter: blur(6px); z-index: 300; display: flex; align-items: center; justify-content: center; padding: 40px; }
.detail-modal { position: relative; width: 100%; max-width: 680px; max-height: 85vh; background: #fff; border-radius: 18px; box-shadow: 0 24px 80px rgba(15,22,36,.3); overflow: hidden; }
.detail-close { position: absolute; top: 14px; right: 14px; z-index: 10; width: 36px; height: 36px; border-radius: 10px; background: rgba(20,24,34,.55); border: 1px solid rgba(255,255,255,.35); box-shadow: 0 4px 14px rgba(0,0,0,.25); display: grid; place-items: center; color: #fff; cursor: pointer; transition: all .15s; backdrop-filter: blur(4px); }
.detail-close:hover { background: #ff4d4f; color: #fff; border-color: #ff4d4f; box-shadow: 0 4px 14px rgba(255,77,79,.4); transform: scale(1.06); }
.detail-content { display: flex; flex-direction: column; width: 100%; max-height: 85vh; }
.detail-media { width: 100%; flex-shrink: 0; background: #0e1118; display: flex; align-items: center; justify-content: center; max-height: 420px; }
.detail-media img, .detail-media video { max-width: 100%; max-height: 420px; object-fit: contain; }
.detail-panel { padding: 18px 22px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.fade-scale-enter-active, .fade-scale-leave-active { transition: all .22s ease; }
.fade-scale-enter-from, .fade-scale-leave-to { opacity: 0; transform: scale(.96); }

.sel-bar { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 18px; padding: 12px 16px 12px 22px; background: #1d2433; color: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(29,36,51,.35); z-index: 200; }
.sel-bar b { color: #8fb0ff; font-size: 16px; }
.btn-clear { color: #aeb6c6; font-size: 13px; }
.btn-clear:hover { color: #fff; }
.fold-enter-active, .fold-leave-active { transition: all .2s; }
.fold-enter-from, .fold-leave-to { opacity: 0; }
.cat-hd-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

/* 预分类结果区域 */
.overview-section { margin-top: 18px; padding-top: 16px; border-top: 1.5px dashed var(--border); }
.overview-hd { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--text-2); margin-bottom: 12px; }
.overview-hd .overview-count { font-size: 12px; font-weight: 400; color: var(--text-4); margin-left: 4px; }
.overview-empty { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 14px 16px; background: linear-gradient(135deg, #f8faff, #f1f5ff); border-radius: 10px; font-size: 13px; color: var(--text-3); }

/* 分类名可点击编辑 */
.cr-name { cursor: pointer; transition: color .15s; }
.cr-name:hover { color: var(--brand); }
.cr-name-input { font-size: 14px; font-weight: 600; color: var(--text-1); border: 1.5px solid var(--brand); border-radius: 6px; padding: 2px 8px; width: 160px; background: #fff; outline: none; }
@media (max-width: 1100px) { .cards:not(.single) { gap: 10px; } }
@media (max-width: 680px) { .cards:not(.single) { gap: 8px; } }

/* 方案B：去重展示口径概览栏 */
.pa-stat-bar { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px 18px; padding: 12px 16px; margin-bottom: 14px; background: linear-gradient(135deg, #f6f9ff, #eef3ff); border: 1px solid #e1e8fb; border-radius: 12px; }
.pa-stat { display: flex; align-items: baseline; gap: 6px; }
.pa-stat-cap { font-size: 13px; font-weight: 600; color: var(--text-3); }
.pa-stat-num { font-size: 24px; font-weight: 800; color: var(--brand); line-height: 1; }
.pa-stat-unit { font-size: 12px; color: var(--text-3); }
.pa-stat-sub { display: flex; align-items: baseline; gap: 5px; font-size: 12.5px; color: var(--text-3); }
.pa-sub-cap { color: var(--text-4); }
.pa-sub-num { font-size: 15px; font-weight: 700; color: var(--text-2); }
.pa-sub-unit { color: var(--text-4); }
.pa-sub-dup { font-size: 12px; font-weight: 600; color: #d97706; background: #fff7ed; border: 1px solid #fde6c8; padding: 1px 8px; border-radius: 20px; }
.pa-sub-nodup { font-size: 12px; color: var(--text-4); }
</style>