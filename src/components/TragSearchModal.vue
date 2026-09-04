<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { tragApi, sedimentApi } from '../api'
import { previewSrc, rawHttpsUrlPlain, mediaProxyFallback } from '../utils/mediaPreview.js'
import Icon from './Icon.vue'
import MaterialAnnotations from './MaterialAnnotations.vue'
import VideoPlayer from './VideoPlayer.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  material: { type: Object, default: null },
  cats: { type: Array, default: () => [] },
  tagId: { type: [String, Number], default: '' },
  showAttribution: { type: Boolean, default: true }, // 归因分类仅在素材分类点击 case 跳转相似检索时显示
})
const emit = defineEmits(['close', 'assign'])

// 素材预览统一直连 CDN（如 cdn.example.com），不走后端 /api/media-proxy 代理。
// 代理对部分视频链接（如 .f0.mp4）回源会返回非法数据，导致 Resource loading error。
// previewSrc 仅做 http→https 升级（页面 https 时规避混合内容），失败由 @error + 兜底「打开原链接」逃生。
function safeUrl(url) {
  return previewSrc(url)
}

/* ============ 任务类型 ============ */
// 与正式 TRAG 检索 API（GET /api/tasks）8 种任务类型保持一致（release.html v1.0）
// 方案A：sortedTaskTypes 会根据素材类型动态重排，这里只是静态基准顺序
const TASK_TYPES = [
  { task: 'text_text',            label: '文本→文本',        icon: 'doc',    input_type: 'text' },
  { task: 'image_image_shangshu', label: '图片→图片（商数）', icon: 'image',  input_type: 'shangshu' },
  { task: 'image_ocr',            label: '图片OCR→文本',     icon: 'search', input_type: 'text' },
  { task: 'video_video',          label: '视频→视频',        icon: 'film',   input_type: 'fingerprint' },
  { task: 'video_ocr',            label: '视频OCR→文本',     icon: 'film',   input_type: 'text' },
  { task: 'video_asr',            label: '视频ASR→文本',     icon: 'film',   input_type: 'text' },
  { task: 'video_patch_asr',      label: '视频ASR片段→文本',  icon: 'film',   input_type: 'text' },
  { task: 'video_frame',          label: '图片→视频风险帧',  icon: 'alert',  input_type: 'url' },
]

/* ============ 方案A：按素材类型动态排序（分组型） ============ */
// 不同素材类型对应不同的优先级顺序：
//   image : 图片相关任务优先（图片→图片、图片OCR→文本、图片→视频风险帧）
//   video : 视频相关任务优先（视频→视频、视频OCR→文本、视频ASR→文本、视频ASR片段→文本、图片→视频风险帧）
//   text  : 文本任务优先（文本→文本、图片OCR→文本、视频OCR→文本、视频ASR→文本、视频ASR片段→文本）
//   link/unknown : 保持静态基准顺序
const TASK_PRIORITY_BY_TYPE = {
  image: ['image_image_shangshu', 'image_ocr', 'video_frame', 'text_text', 'video_video', 'video_ocr', 'video_asr', 'video_patch_asr'],
  video: ['video_video', 'video_ocr', 'video_asr', 'video_patch_asr', 'video_frame', 'image_image_shangshu', 'image_ocr', 'text_text'],
  text:  ['text_text', 'image_ocr', 'video_ocr', 'video_asr', 'video_patch_asr', 'image_image_shangshu', 'video_video', 'video_frame'],
  link:  ['image_image_shangshu', 'image_ocr', 'video_frame', 'text_text', 'video_video', 'video_ocr', 'video_asr', 'video_patch_asr'],
}

// 视频扩展名列表
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
// 图片扩展名列表（避免 ads_svp_video__xxx.jpeg 被误判为视频）
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif', 'avif']

// 通过 URL 后缀判断是否为视频（不依赖 isVideo 字段）
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

// 判断素材主类型（与 autoDetectTask / autoFillQuery 的判断口径一致）
function detectMaterialType(r) {
  if (!r) return 'link'
  if (r.type === '文本' || (!isVideoByUrl(r.mediaUrl) && !r.mediaUrl)) return 'text'
  if (isVideoByUrl(r.mediaUrl)) return 'video'
  // 落地页：媒体 URL 是 http 但既不是视频也不是图片
  const url = r.mediaUrl || ''
  if (url && /\.(mp4|mov|avi|webm|mkv|flv)(\?|$)/i.test(url)) return 'video'
  if (url && /\.(jpg|jpeg|png|webp|gif|bmp)(\?|$)/i.test(url)) return 'image'
  if (url && /^https?:\/\//i.test(url)) return 'link'
  return 'image'
}
const materialType = computed(() => detectMaterialType(props.material))

// 当前素材是否已生成视频指纹（video_video 任务检索词必须是指纹，否则永远查不到）
// 指纹来自 ElementHub + Venus 视觉嵌入服务，不稳定且并非所有素材都会预生成
const hasFingerprint = computed(() => !!(props.material && props.material.elementFingerprint))

// 任务类型是否可点：视频→视频 必须依赖指纹，无指纹则禁用并提示
function isTaskDisabled(t) {
  return t.task === 'video_video' && !hasFingerprint.value
}

// 动态排序后的任务列表：当前素材类型相关的任务排在前
const sortedTaskTypes = computed(() => {
  const order = TASK_PRIORITY_BY_TYPE[materialType.value] || Object.keys(TASK_TYPES).map(k => TASK_TYPES[k].task)
  const byTask = {}
  for (const t of TASK_TYPES) byTask[t.task] = t
  const ordered = []
  const seen = new Set()
  for (const taskKey of order) {
    if (byTask[taskKey] && !seen.has(taskKey)) {
      ordered.push(byTask[taskKey])
      seen.add(taskKey)
    }
  }
  // 兜底：把不在优先级表里的任务追加到末尾（保证 7 项全部展示）
  for (const t of TASK_TYPES) {
    if (!seen.has(t.task)) {
      ordered.push(t)
      seen.add(t.task)
    }
  }
  return ordered
})

/* ============ 状态 ============ */
const selectedTask = ref('')
const searchText = ref('')
const searchResults = ref([])
const searching = ref(false)
const searchError = ref('')
const resultTotal = ref(0)
const isCached = ref(false)
const showFilters = ref(false)
const filterMachineTag = ref('')
const filterHumanTag = ref('')
const filterIndL1 = ref('')
const filterIndL2 = ref('')
const resultLimit = ref(10)
const thresholdVal = ref(0)
const groupByVideo = ref(false)
const mediaErr = reactive({})
const detailVisible = ref(false)
const detailResult = ref(null)

/* ============ Tab 切换 ============ */
const activeTab = ref('trag') // 'trag' | 'sediment'

/* ============ 结论沉淀检索 ============ */
const sedSearchText = ref('')
const sedTagId = ref('')
const sedTagName = ref('')
const sedIndustry = ref('')
const sedResultType = ref('')
const sedResults = ref([])
const sedSearching = ref(false)
const sedError = ref('')
const sedTagOptions = ref([])
const sedDetailVisible = ref(false)
const sedDetailItem = ref(null)
const RESULT_TYPE_MAP = {
  real_fp: { label: '真实误杀', color: '#ef4444' },
  machine_right: { label: '机审正确', color: '#22c55e' },
  other: { label: '其他', color: '#64748b' },
}

async function loadSedTagOptions() {
  try {
    const tags = await sedimentApi.tags()
    sedTagOptions.value = tags
  } catch { sedTagOptions.value = [] }
}

async function doSedSearch() {
  if (sedSearching.value) return
  sedSearching.value = true
  sedError.value = ''
  try {
    const params = {}
    if (sedSearchText.value.trim()) params.q = sedSearchText.value.trim()
    if (sedTagId.value) params.tagId = sedTagId.value
    else if (sedTagName.value.trim()) params.tagName = sedTagName.value.trim()
    if (sedIndustry.value.trim()) params.industry = sedIndustry.value.trim()
    if (sedResultType.value) params.resultType = sedResultType.value
    sedResults.value = await sedimentApi.search(params)
  } catch (e) {
    sedError.value = e.message || '检索失败'
    sedResults.value = []
  } finally {
    sedSearching.value = false
  }
}

function onSedSearchInput() {
  clearTimeout(sedSearchTimer)
  sedSearchTimer = setTimeout(() => doSedSearch(), 500)
}
let sedSearchTimer = null

function openSedDetail(item) {
  sedDetailItem.value = item
  sedDetailVisible.value = true
}

function closeSedDetail() {
  sedDetailVisible.value = false
}

function switchTab(tab) {
  activeTab.value = tab
  if (tab === 'sediment' && !sedTagOptions.value.length) {
    loadSedTagOptions()
  }
  if (tab === 'sediment' && !sedResults.value.length && !sedSearching.value) {
    doSedSearch()
  }
}

/* 字数控制：基于多少字检索 */
const queryCharLimit = ref(0) // 0 = 不限制（全部文本）
const charLimitOptions = [
  { value: 0, label: '全部' },
  { value: 50, label: '50字' },
  { value: 100, label: '100字' },
  { value: 200, label: '200字' },
  { value: 500, label: '500字' },
  { value: 1000, label: '1000字' },
]

let debounceTimer = null

/* ============ 自动判断任务类型 ============ */
function autoDetectTask(r) {
  if (!r) return 'text_text'
  if (r.type === '文本' || (!isVideoByUrl(r.mediaUrl) && !r.mediaUrl)) return 'text_text'
  if (isVideoByUrl(r.mediaUrl)) {
    // 视频优先用 OCR/ASR 文本检索（基于 bge-large-zh，稳定可用）
    // video_video 依赖 ElementHub+Venus 视觉嵌入服务，经常不可用
    if (r.ocr) return 'video_ocr'
    if (r.asr) return 'video_asr'
    if (r.elementFingerprint) return 'video_video'
    return 'video_frame'
  }
  // 图片优先用 OCR 文本检索（基于 bge-large-zh，稳定可用）
  // image_image（商数）依赖视觉嵌入服务，先用 OCR 文本检索更稳妥
  if (r.ocr) return 'image_ocr'
  if (r.mediaUrl) return 'image_image_shangshu'
  return 'text_text'
}

/* ============ 自动填充检索内容 ============ */
function autoFillQuery(task, r) {
  if (!r) return ''
  switch (task) {
    case 'text_text':
      return r.mediaUrl || r.ocr || r.asr || ''
    case 'image_image_shangshu':
    case 'video_frame':
      return r.mediaUrl || ''
    case 'image_ocr':
    case 'video_ocr':
      return r.ocr || ''
    case 'video_asr':
    case 'video_patch_asr':
      return r.asr || r.ocr || ''
    case 'video_video':
      return r.elementFingerprint || ''
    default:
      return ''
  }
}

/* ============ 根据字数限制截断查询文本 ============ */
function truncateQuery(text, charLimit) {
  if (!charLimit || charLimit <= 0) return text
  if (!text) return text
  return text.length > charLimit ? text.slice(0, charLimit) : text
}

/* ============ 打开弹窗时初始化 ============ */
watch(() => props.visible, async (v) => {
  if (v && props.material) {
    const r = props.material
    selectedTask.value = autoDetectTask(r)
    searchText.value = autoFillQuery(selectedTask.value, r)
    detailVisible.value = false
    detailResult.value = null
    searchResults.value = []
    searchError.value = ''
    await nextTick()
    // 立即检索（缓存预热后应秒出结果）
    doSearch()
  }
}, { immediate: true })

/* ============ 切换任务类型（下拉框） ============ */
function onTaskSelectChange() {
  searchText.value = autoFillQuery(selectedTask.value, props.material)
  detailVisible.value = false
  detailResult.value = null
  searchResults.value = []
  searchError.value = ''
  // 立即检索
  doSearch()
}

function switchTask(task) {
  if (task === selectedTask.value) return
  selectedTask.value = task
  searchText.value = autoFillQuery(task, props.material)
  detailVisible.value = false
  detailResult.value = null
  searchResults.value = []
  searchError.value = ''
  // 立即检索
  doSearch()
}

/* ============ 字数限制变更后自动重新检索 ============ */
function onCharLimitChange() {
  if (searchText.value.trim()) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => doSearch(), 500)
  }
}

/* ============ 检索（带防抖） ============ */
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => doSearch(), 500)
}

async function doSearch() {
  if (!searchText.value.trim()) {
    searchResults.value = []
    searchError.value = ''
    return
  }
  // 兜底防护：视频→视频 需要视频指纹，无指纹时直接提示，避免"选了没反应"的空结果困惑
  if (selectedTask.value === 'video_video' && !hasFingerprint.value) {
    searchResults.value = []
    searchError.value = '当前素材未生成视频指纹，无法使用「视频→视频」检索。请切换至「视频OCR→文本」或「视频ASR→文本」（用素材文本检索，稳定可用）。'
    return
  }
  searching.value = true
  searchError.value = ''
  try {
    // 根据字数限制截断查询文本
    const actualQuery = truncateQuery(searchText.value.trim(), queryCharLimit.value)
    const params = {
      task: selectedTask.value,
      query: actualQuery,
      limit: resultLimit.value,
      threshold: thresholdVal.value,
    }
    // 正式 API 使用 tags / first_industries / second_industries 数组字段
    if (filterMachineTag.value.trim()) params.tags = filterMachineTag.value.split(',').map(s => s.trim()).filter(Boolean)
    if (filterIndL1.value.trim()) params.first_industries = [filterIndL1.value.trim()]
    if (filterIndL2.value.trim()) params.second_industries = [filterIndL2.value.trim()]
    if (selectedTask.value === 'video_frame') params.group_by_video = groupByVideo.value

    const data = await tragApi.search(params)
    searchResults.value = data.results || []
    resultTotal.value = data.total || 0
    isCached.value = !!data.cached
  } catch (e) {
    // 后端已在上游不可达/403 ACL 时给出明确原因（"无访问权限"/"暂不可达"等）
    let msg = e.message || '检索失败'
    // 兜底：若后端未带原因，补充自助排查提示，避免用户误以为是平台 bug
    if (!/权限|ACL|igate|不可达|白名单|IDC|403|503/i.test(msg)) {
      msg += '（若提示检索服务无响应，多为当前环境无法访问 IDC 检索集群，需 igate 源 IP 白名单或部署到 IDC 内网）'
    }
    searchError.value = msg
    searchResults.value = []
  } finally {
    searching.value = false
  }
}

/* ============ 导出 CSV ============ */
const exportingCsv = ref(false)
async function doExportCsv() {
  if (!searchResults.value.length || exportingCsv.value) return
  exportingCsv.value = true
  try {
    await tragApi.exportCsv({
      task: selectedTask.value,
      query: searchText.value.trim(),
      results: searchResults.value,
    })
  } catch (e) {
    searchError.value = e.message || '导出失败'
  } finally {
    exportingCsv.value = false
  }
}

/* ============ 图片上传（契约 3.5 节，用于 image_image_shangshu / video_frame 检索） ============ */
const uploadingImage = ref(false)
const uploadedImageUrl = ref('')
const uploadImageError = ref('')

// 当前任务类型是否支持"用图片 URL 做 query"（图片相关任务）
const imageQueryTasks = computed(() =>
  ['image_image_shangshu', 'video_frame'].includes(selectedTask.value)
)

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onImageSelected(e) {
  const file = e.target?.files?.[0]
  if (!file) return
  if (!/^image\//.test(file.type)) {
    uploadImageError.value = '请选择图片文件（jpg/png/webp 等）'
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    uploadImageError.value = '图片超过 20MB 上限'
    return
  }
  uploadingImage.value = true
  uploadImageError.value = ''
  uploadedImageUrl.value = ''
  try {
    const dataUrl = await fileToDataUrl(file)
    const data = await tragApi.uploadImage({
      filename: file.name || 'upload.png',
      data_url: dataUrl,
    })
    // 上传成功：把可回拉 URL 作为检索 query，并自动触发检索
    uploadedImageUrl.value = data.url
    searchText.value = data.url
    await doSearch()
  } catch (err) {
    uploadImageError.value = err.message || '图片上传失败'
  } finally {
    uploadingImage.value = false
    // 清空 input，允许重复选择同一文件
    if (e.target) e.target.value = ''
  }
}

function clearUploadedImage() {
  uploadedImageUrl.value = ''
  searchError.value = ''
}

/* ============ 分数颜色 ============ */
function scoreColor(score) {
  if (score >= 0.85) return '#e53e3e'
  if (score >= 0.7) return '#dd6b20'
  if (score >= 0.5) return '#d69e2e'
  return '#718096'
}
function fmtScore(score) {
  return (score * 100).toFixed(1) + '%'
}

/* ============ 结果媒体处理 ============ */
function getResultMediaUrl(r) {
  return r.element_value || r.media_url || r.cos_url || r.video_url || ''
}
function getResultOcr(r) {
  return r.ocr_content || r.ocr_text || ''
}
function getResultAsr(r) {
  return r.asr_content || r.asr_text || ''
}
function getResultPatchAsr(r) {
  return r.patch_asr_text || ''
}
// 视频 ASR 片段任务的展示文本（优先 patch_asr_text）
function getResultPrimaryText(r) {
  return getResultPatchAsr(r) || getResultOcr(r) || getResultAsr(r) || getResultMediaUrl(r)
}
function getResultElementType(r) {
  const mediaType = getResultMediaType(r)
  const typeMap = { image: '图片', video: '视频', text: '文本' }
  const raw = r.element_type || r.data_type || typeMap[mediaType] || mediaType
  // 与 elementTypeName 共用同一套映射，避免数字编码直接透传到界面
  return ELEMENT_TYPE_MAP[raw] || raw
}
function detectMediaType(url) {
  if (!url || typeof url !== 'string') return 'text'
  if (/\.(mp4|mov|avi|webm|mkv|flv)(\?|$)/i.test(url)) return 'video'
  if (/\.(jpg|jpeg|png|webp|gif|bmp)(\?|$)/i.test(url)) return 'image'
  // 非媒体扩展名的 http URL（如 HTML 落地页）标记为 link，不作为 img/video src 加载
  if (url.startsWith('http')) return 'link'
  return 'text'
}
function getResultMediaType(r) {
  const task = selectedTask.value
  if (task === 'video_frame') return 'image'
  if (task === 'video_video') return 'video'
  if (task === 'image_image') return 'image'
  if (task === 'text_text' || task === 'image_ocr' || task === 'video_ocr' || task === 'video_asr') {
    const url = getResultMediaUrl(r)
    if (url.startsWith('http')) return detectMediaType(url)
    return 'text'
  }
  return detectMediaType(getResultMediaUrl(r))
}
function truncateText(text, max) {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function parsePolicyList(raw) {
  if (raw == null || raw === '') return []
  let arr = null
  if (Array.isArray(raw)) {
    arr = raw
  } else if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    try {
      const parsed = JSON.parse(s)
      arr = Array.isArray(parsed) ? parsed : [parsed]
    } catch (e) {
      arr = [s]
    }
  } else {
    arr = [raw]
  }
  const seen = new Set()
  const out = []
  for (const x of arr) {
    if (x == null) continue
    const pid = String(x).trim()
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
  }
  return out
}

/* ============ 元素类型名称映射 ============ */
// 必须与后端 server/src/routes/{tags,classifyUpload}.js 的 ELEMENT_TYPE_MAP 完全一致
// 缺失映射会导致 element_type 原值（如数字 4）直接显示在界面上
const ELEMENT_TYPE_MAP = {
  'ELEMENT_TYPE_IMAGE': '图片',
  'ELEMENT_TYPE_VIDEO': '视频',
  'ELEMENT_TYPE_TEXT': '文本',
  'ELEMENT_TYPE_URL': '落地页',
  // real_data_samples / TRAG 返回的 element_type 可能是数字编码
  '1': '文本',
  '2': '图片',
  '3': '图片',
  '4': '视频',
  '5': '落地页',
  '6': '音频',
  '7': '图文',
}
function elementTypeName(val) {
  if (val == null || val === '') return ''
  const s = String(val)
  return ELEMENT_TYPE_MAP[s] || s
}

/* ============ 卡片点击 → 弹出详情弹窗 ============ */
function openResultDetail(r) {
  detailResult.value = r
  detailVisible.value = true
}
function closeResultDetail() {
  detailVisible.value = false
  detailResult.value = null
}

/* ============ 复制指纹 ============ */
const leftFpCopied = ref(false)
const detailFpCopied = ref(false)

function copyLeftFingerprint(fp) {
  if (!fp) return
  navigator.clipboard.writeText(fp).then(() => {
    leftFpCopied.value = true
    setTimeout(() => { leftFpCopied.value = false }, 1500)
  }).catch(() => {})
}

function copyFingerprint(fp) {
  if (!fp) return
  navigator.clipboard.writeText(fp).then(() => {
    detailFpCopied.value = true
    setTimeout(() => { detailFpCopied.value = false }, 1500)
  }).catch(() => {})
}

// 结果卡片列表中的指纹复制（独立状态，避免与详情区冲突）
const gridFpCopied = ref(false)
function copyGridFingerprint(fp) {
  if (!fp) return
  navigator.clipboard.writeText(fp).then(() => {
    gridFpCopied.value = true
    setTimeout(() => { gridFpCopied.value = false }, 1500)
  }).catch(() => {})
}

/* ============ 详情弹窗：精标 + 策略数据提取 ============ */

// 提取精标数据 fineDataResult
// TRAG 返回的字段可能是 fine_data_result（下划线）或 fineDataResult（驼峰）
function parseFineData(r) {
  if (!r) return null
  let fd = r.fine_data_result || r.fineDataResult
  if (!fd) return null
  if (typeof fd === 'string') {
    try { fd = JSON.parse(fd) } catch { return null }
  }
  // 如果 TRAG 数据中没有 is_model_correct，根据 isHumanResult / finePerson 推断
  if (fd.is_model_correct === undefined) {
    const isHuman = r.isHumanResult === '1' || r.is_human_result === '1'
    if (isHuman) {
      fd._inferred_correct = true  // 有人审结果 = 采纳
    }
  }
  return fd
}

// 精标标签列表（优先从 extra_policy_id_list 提取，兜底从 humanTag / ai_evaluate_policy_ids 提取）
function parseFineLabels(r) {
  const fd = parseFineData(r)
  // 优先：fine_data_result.extra_policy_id_list（即使为空数组也要返回标记）
  if (fd && Array.isArray(fd.extra_policy_id_list)) {
    return fd.extra_policy_id_list.map(x => ({
      policyId: x.policyId ?? x.policy_id ?? '',
      fullReason: x.fullReason || x.full_reason || '',
    }))
  }
  // 兜底：从 humanTag / ai_evaluate_policy_ids 提取（由后端 enrichResultsWithTags 填充）
  const tagStr = r?.humanTag || r?.ai_evaluate_policy_ids || ''
  if (tagStr) {
    return String(tagStr).split(',').map(s => s.trim()).filter(Boolean).map(pid => ({
      policyId: pid,
      fullReason: '',
    }))
  }
  return []
}

// 精标终审结果标签ID列表（用于卡片展示）
function getFineLabelIds(r) {
  const labels = parseFineLabels(r)
  return labels.map(l => l.policyId).filter(Boolean)
}

// 精标采纳状态判断
function isFineCorrect(r) {
  const fd = parseFineData(r)
  if (fd) {
    if (fd.is_model_correct !== undefined) return fd.is_model_correct
    return fd._inferred_correct === true
  }
  // 无 fine_data_result 但有人审标签ID（humanTag/ai_evaluate_policy_ids），推断为采纳
  const tagStr = r?.humanTag || r?.ai_evaluate_policy_ids || ''
  if (tagStr) return true
  return null  // null 表示无数据
}

// 精标审核人
function getFinePerson(r) {
  return r?.finePerson || r?.fine_person || r?.finePersonResult?.fine_person || ''
}

// 精标审核时间
function getFineTime(r) {
  return r?.fineTime || r?.fine_time || r?.finePersonResult?.fine_time || ''
}

// 机审标签字符串
function getMachineTags(r) {
  if (!r) return ''
  const pl = r.policy_list
  if (Array.isArray(pl)) return pl.join(', ')
  if (typeof pl === 'string') return pl
  return ''
}

// 人审标签字符串（从 fineDataResult.extra_policy_id_list 提取 policyId）
function getHumanTags(r) {
  const labels = parseFineLabels(r)
  if (!labels.length) return ''
  return labels.map(l => l.policyId).join(', ')
}

// 审核时间格式化
function formatFineTime(val) {
  if (!val) return ''
  const s = String(val)
  if (s.length >= 10) return s.substring(0, 10)
  return s
}

// 详情弹窗计算属性（实时从 detailResult 派生，避免 computed 依赖问题）
const fineData = computed(() => parseFineData(detailResult.value))
const fineLabels = computed(() => parseFineLabels(detailResult.value))
const fineExtraPolicyListEmpty = computed(() => {
  const fd = parseFineData(detailResult.value)
  if (!fd) return false
  return Array.isArray(fd.extra_policy_id_list) && fd.extra_policy_id_list.length === 0
})
const machineTagStr = computed(() => getMachineTags(detailResult.value))
const humanTagStr = computed(() => getHumanTags(detailResult.value))

/* ============ 媒体错误处理（直连为主 + 代理兜底）============ */
// 直连 CDN 预览，加载失败时先尝试后端代理（服务端续期 dis_t 代拉）兜底一次，
// 仍失败再由 @error 标记 mediaErr，并展示「打开原链接」（data-raw-url 逃生通道）兜底。
const _proxyTried = new Set()
function onResultMediaErr(id, e) {
  const el = e && e.target
  if (el && !_proxyTried.has(id)) {
    _proxyTried.add(id)
    if (mediaProxyFallback(el)) return // 已切到代理路径，不标记失败
  }
  mediaErr[id] = true
}
// 重新打开/切换素材时重置代理重试标记，允许下次重新尝试
watch(() => props.material, () => { _proxyTried.clear() })

/* ============ 关闭弹窗 ============ */
function handleClose() {
  if (debounceTimer) clearTimeout(debounceTimer)
  detailVisible.value = false
  detailResult.value = null
  emit('close')
}

function onOverlayClick() {
  handleClose()
}

/* ============ ESC 关闭 ============ */
function onKeydown(e) {
  if (e.key === 'Escape' && props.visible) {
    if (detailVisible.value) {
      closeResultDetail()
    } else {
      handleClose()
    }
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (debounceTimer) clearTimeout(debounceTimer)
})

/* ============ 左栏编辑功能 ============ */
const editCategoryId = ref(null)
const showOcrDetail = ref(false)
const showAsrDetail = ref(false)

watch(() => props.material, (r) => {
  if (r) {
    editCategoryId.value = r.categoryId ?? r.category_id ?? ''
    // OCR/ASR 有内容时默认展开显示全部
    showOcrDetail.value = !!r.ocr
    showAsrDetail.value = !!r.asr
  }
}, { immediate: true })

function onCategoryChange() {
  emit('assign', { item: props.material, categoryId: editCategoryId.value })
}

/* ============ 当前任务元信息 ============ */
const currentTaskMeta = computed(() => sortedTaskTypes.value.find(t => t.task === selectedTask.value) || {})

/* ============ 素材顶部标题字段 ============ */
const matElementId = computed(() => props.material?.elementId || props.material?.id || '—')
const matSampleId = computed(() => props.material?.elementId || props.material?.id || '')
const matTypeName = computed(() => {
  const r = props.material
  if (!r) return '—'
  return isVideoByUrl(r.mediaUrl) ? '视频' : (r.type === '文本' ? '文本' : '图片')
})
</script>

<template>
  <transition name="fade-scale">
    <div v-if="visible" class="trag-overlay" @click.self="onOverlayClick">
      <div class="trag-modal">
        <button class="trag-close" @click="handleClose"><Icon name="close" :size="20" /></button>

        <div class="trag-body">
          <!-- ====== 左侧（60%）：原始素材 ====== -->
          <div class="trag-left" v-if="material">
            <!-- 顶部标题：元素ID、编号、元素类型、行业、人审&机审、指纹 -->
            <div class="tl-title-bar">
              <div class="tl-title-row">
                <span class="tl-title-val mono tl-eid">{{ matElementId }}</span>
                <span class="tl-title-badge tl-badge-type">{{ matTypeName }}</span>
                <span class="tl-title-badge tl-badge-ind" v-if="material.industryL1">{{ material.industryL1 }}</span>
                <span class="tl-title-badge tl-badge-ind2" v-if="material.industryL2">{{ material.industryL2 }}</span>
              </div>
              <div class="tl-title-row" v-if="material.policyIds || material.aiEvaluatePolicyIds || material.humanTagEmpty || material.dcId || material.reviewerName || material.opsAdvertiserName">
                <span class="tl-title-val mono tl-tagval" v-if="material.policyIds">机审: {{ material.policyIds }}</span>
                <span class="tl-title-val mono tl-tagval" v-if="material.aiEvaluatePolicyIds || material.humanTagEmpty">人审: {{ material.aiEvaluatePolicyIds || '通过' }}</span>
                <span class="tl-title-val mono tl-tagval" v-if="material.reviewerName">审核人: {{ material.reviewerName }}</span>
                <span class="tl-title-val mono tl-tagval" v-if="material.opsAdvertiserName">客户主体: {{ material.opsAdvertiserName }}</span>
                <span class="tl-title-val mono tl-tagval" v-if="material.dcId">DCID: {{ material.dcId }}</span>
              </div>
              <div class="tl-title-row" v-if="material.elementFingerprint">
                <div class="fp-hover-wrap" @click.stop="copyLeftFingerprint(material.elementFingerprint)">
                  <span class="tl-title-val mono ellipsis fp-hover-text">指纹: {{ material.elementFingerprint }}</span>
                  <span class="fp-hover-icon" :class="{ copied: leftFpCopied }">
                    <Icon :name="leftFpCopied ? 'check' : 'copy'" :size="14" />
                    <span class="fp-hover-tip">{{ leftFpCopied ? '已复制' : '复制' }}</span>
                  </span>
                </div>
              </div>
              <div class="tl-title-row" v-if="material.mediaUrl">
                <a class="tl-title-link" :href="material.mediaUrl" target="_blank"><Icon name="link" :size="12" /> 原文链接</a>
              </div>
            </div>

            <!-- 媒体预览区（flex:1 黑底占满） -->
            <div class="tl-media">
              <template v-if="material.type === '文本' || (!isVideoByUrl(material.mediaUrl) && !material.mediaUrl)">
                <div class="tl-text-content">{{ material.mediaUrl || material.ocr || '（无文本内容）' }}</div>
              </template>
              <template v-else>
<VideoPlayer v-if="isVideoByUrl(material.mediaUrl) && !mediaErr['src']" :src="material.mediaUrl" :raw-url="material.mediaUrl" fit="contain" />
                <img v-else-if="!mediaErr['src']" :src="safeUrl(material.mediaUrl)" :data-raw-url="material.mediaUrl" @error="onResultMediaErr('src', $event)" alt="素材预览" />
                <a v-else class="tl-fallback" :href="rawHttpsUrlPlain(material.mediaUrl)" target="_blank" referrerpolicy="no-referrer"><Icon name="link" :size="20" />打开原链接</a>
              </template>
            </div>

            <!-- 底部信息区（OCR/ASR 可折叠，独立滚动） -->
            <div class="tl-bottom-info">
              <!-- OCR 可折叠文本框 -->
              <div class="tl-info-row">
                <div class="ti-collapsible" @click="showOcrDetail = !showOcrDetail">
                  <Icon :name="showOcrDetail ? 'chevronDown' : 'chevronRight'" :size="12" class="ti-toggle-icon" />
                  <span class="ti-label">OCR</span>
                  <span class="ti-preview" v-if="!showOcrDetail && material.ocr">{{ material.ocr.slice(0, 60) }}{{ material.ocr.length > 60 ? '…' : '' }}</span>
                </div>
                <div class="ti-textbox-wrap" v-if="showOcrDetail">
                  <textarea class="ti-textbox" readonly rows="3">{{ material.ocr || '（无OCR内容）' }}</textarea>
                </div>
              </div>
              <!-- ASR 可折叠文本框 -->
              <div class="tl-info-row">
                <div class="ti-collapsible" @click="showAsrDetail = !showAsrDetail">
                  <Icon :name="showAsrDetail ? 'chevronDown' : 'chevronRight'" :size="12" class="ti-toggle-icon" />
                  <span class="ti-label">ASR</span>
                  <span class="ti-preview" v-if="!showAsrDetail && material.asr">{{ material.asr.slice(0, 60) }}{{ material.asr.length > 60 ? '…' : '' }}</span>
                </div>
                <div class="ti-textbox-wrap" v-if="showAsrDetail">
                  <textarea class="ti-textbox" readonly rows="3">{{ material.asr || '（无ASR内容）' }}</textarea>
                </div>
              </div>
            </div>

            <!-- 归因分类（仅素材分类跳转时显示）+ 标注（固定在底部，始终可见） -->
            <div class="tl-edit">
              <div class="tle-section" v-if="showAttribution">
                <span class="tle-label">归因分类</span>
                <select class="tle-select" v-model="editCategoryId" @change="onCategoryChange">
                  <option value="">请选择分类</option>
                  <option v-for="c in cats" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </div>
              <div class="tle-section tle-ann">
                <MaterialAnnotations :tag-id="tagId" :sample-id="matSampleId" :media-url="material.mediaUrl || ''" unlimited />
              </div>
            </div>
          </div>

          <!-- ====== 右侧（40%）：检索结果 ====== -->
          <div class="trag-right">
            <!-- Tab 切换栏 -->
            <div class="trag-tabs">
              <button class="trag-tab" :class="{ active: activeTab === 'trag' }" @click="switchTab('trag')">
                <Icon name="search" :size="14" /> 相似样本检索
              </button>
              <button class="trag-tab" :class="{ active: activeTab === 'sediment' }" @click="switchTab('sediment')">
                <Icon name="sediment" :size="14" /> 结论沉淀库
              </button>
            </div>

            <!-- ====== Tab1: 相似样本检索 ====== -->
            <template v-if="activeTab === 'trag'">
            <!-- 任务类型下拉框 + 字数控制 -->
            <div class="trag-task-bar">
              <div class="ttb-row">
                <label class="ttb-label">任务类型</label>
                <select class="ttb-select" v-model="selectedTask" @change="onTaskSelectChange">
                  <option v-for="t in sortedTaskTypes" :key="t.task" :value="t.task" :disabled="isTaskDisabled(t)">
                    {{ t.label }}{{ isTaskDisabled(t) ? '（当前素材无指纹，不可用）' : '' }}
                  </option>
                </select>
                <span v-if="isTaskDisabled(currentTaskMeta)" class="ttb-warn">
                  ⚠ 当前素材未生成视频指纹，无法使用「视频→视频」检索。请改用「视频OCR→文本」或「视频ASR→文本」（自动用素材文本检索，稳定可用）。
                </span>
              </div>
              <div class="ttb-row" v-if="currentTaskMeta.input_type === 'text'">
                <label class="ttb-label">识别字数</label>
                <select class="ttb-select ttb-select-sm" v-model="queryCharLimit" @change="onCharLimitChange">
                  <option v-for="opt in charLimitOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <span class="ttb-hint">基于前N字检索</span>
              </div>
            </div>

            <!-- 检索输入 + 按钮 -->
            <div class="trag-input-area">
              <div class="ti-search-box">
                <Icon name="search" :size="15" class="ti-search-icon" />
                <input
                  v-model="searchText"
                  class="ti-search-input"
                  :placeholder="`输入${currentTaskMeta.input_type === 'text' ? '文本' : currentTaskMeta.input_type === 'url' ? 'URL' : '指纹'}进行检索...`"
                  @input="onSearchInput"
                  @keyup.enter="doSearch"
                />
                <button class="ti-search-btn" :disabled="searching" @click="doSearch">
                  <Icon name="refresh" :size="14" :class="{ spinning: searching }" />
                </button>
              </div>
              <div class="ti-upload-row" v-if="imageQueryTasks">
                <label class="ti-upload-btn" :class="{ disabled: uploadingImage }">
                  <Icon name="image" :size="14" />
                  {{ uploadingImage ? '上传中…' : '上传本地图片' }}
                  <input type="file" accept="image/*" class="ti-upload-input" :disabled="uploadingImage" @change="onImageSelected" />
                </label>
                <span v-if="uploadedImageUrl" class="ti-upload-ok" @click="clearUploadedImage">
                  <Icon name="check" :size="13" /> 已上传，点击清除
                </span>
                <span v-if="uploadImageError" class="ti-upload-err">{{ uploadImageError }}</span>
              </div>
              <button class="ti-filter-toggle" @click="showFilters = !showFilters">
                <Icon name="settings" :size="13" />
                {{ showFilters ? '收起筛选' : '高级筛选' }}
              </button>
              <transition name="slide-down">
                <div v-if="showFilters" class="ti-filters">
                  <div class="filter-row">
                    <label>机审违规标签</label>
                    <input v-model="filterMachineTag" placeholder="逗号分隔" @input="onSearchInput" />
                  </div>
                  <div class="filter-row">
                    <label>人审违规标签</label>
                    <input v-model="filterHumanTag" placeholder="逗号分隔" @input="onSearchInput" />
                  </div>
                  <div class="filter-row">
                    <label>一级行业</label>
                    <input v-model="filterIndL1" placeholder="如：电商" @input="onSearchInput" />
                  </div>
                  <div class="filter-row">
                    <label>二级行业</label>
                    <input v-model="filterIndL2" placeholder="如：美妆" @input="onSearchInput" />
                  </div>
                  <div class="filter-row">
                    <label>结果数</label>
                    <select v-model="resultLimit" @change="doSearch">
                      <option :value="5">5</option>
                      <option :value="10">10</option>
                      <option :value="20">20</option>
                      <option :value="50">50</option>
                    </select>
                  </div>
                  <div class="filter-row">
                    <label>阈值</label>
                    <input type="number" v-model="thresholdVal" min="0" max="1" step="0.05" @input="onSearchInput" />
                  </div>
                  <div class="filter-row" v-if="selectedTask === 'video_frame'">
                    <label>去重</label>
                    <label class="switch-label">
                      <input type="checkbox" v-model="groupByVideo" @change="doSearch" />
                      <span>按视频去重</span>
                    </label>
                  </div>
                </div>
              </transition>
            </div>

            <!-- 检索结果网格 -->
            <div class="trag-results">
              <div class="tr-header">
                <span class="tr-count" v-if="!searching && !searchError">
                  共 {{ resultTotal }} 条结果
                  <span v-if="isCached" class="tr-cached">（缓存）</span>
                </span>
                <span v-if="searching" class="tr-loading">检索中…</span>
                <span v-if="searchError" class="tr-error">{{ searchError }}</span>
                <button
                  v-if="!searching && !searchError && searchResults.length"
                  class="tr-export-btn"
                  :disabled="exportingCsv"
                  @click="doExportCsv"
                >
                  <Icon name="download" :size="13" />
                  {{ exportingCsv ? '导出中…' : '导出CSV' }}
                </button>
              </div>

              <div class="tr-grid" v-if="searchResults.length">
                <div
                  v-for="(r, i) in searchResults"
                  :key="i"
                  class="tr-card"
                  @click="openResultDetail(r)"
                >
                  <!-- 媒体/文字内容区（约占卡片 55% 高度） -->
                  <div class="trc-media" v-if="getResultMediaType(r) === 'image'">
<img v-if="!mediaErr['grid-'+i]" :src="safeUrl(getResultMediaUrl(r))" :data-raw-url="getResultMediaUrl(r)" @error="onResultMediaErr('grid-'+i, $event)" alt="" />
                    <a v-else class="trc-media-fallback" :href="rawHttpsUrlPlain(getResultMediaUrl(r))" target="_blank" referrerpolicy="no-referrer"><Icon name="link" :size="24" /></a>
                  </div>
                  <div class="trc-media trc-media-video" v-else-if="getResultMediaType(r) === 'video'">
<VideoPlayer v-if="!mediaErr['grid-'+i]" :src="getResultMediaUrl(r)" :raw-url="getResultMediaUrl(r)" fit="cover" />
                    <a v-else class="trc-media-fallback" :href="rawHttpsUrlPlain(getResultMediaUrl(r))" target="_blank" referrerpolicy="no-referrer"><Icon name="link" :size="24" /></a>
                  </div>
                  <div class="trc-media trc-media-text" v-else>
                    <div class="trc-text-snippet">{{ truncateText(getResultPrimaryText(r), 120) }}</div>
                  </div>

                  <!-- 左上角相似度分数 -->
                  <div class="trc-score" :style="{ color: scoreColor(r.score) }">
                    <span class="trc-score-dot" :style="{ background: scoreColor(r.score) }"></span>
                    {{ fmtScore(r.score) }}
                  </div>

                  <!-- 底部信息区 -->
                  <div class="trc-info">
                    <!-- 行业 + 元素类型（第一行） -->
                    <div class="trc-tags">
                      <span class="trc-tag trc-tag-ind" v-if="r.v6_level_name_1">{{ r.v6_level_name_1 }}</span>
                      <span class="trc-tag trc-tag-ind2" v-if="r.v6_level_name_2">{{ r.v6_level_name_2 }}</span>
                      <span class="trc-tag trc-tag-element" v-if="elementTypeName(r.element_type)">{{ elementTypeName(r.element_type) }}</span>
                    </div>
                    <!-- 精标终审结果标签（第二行） -->
                    <div class="trc-tags" v-if="getFineLabelIds(r).length">
                      <span class="trc-tag trc-tag-fine" v-for="(pid, fi) in getFineLabelIds(r)" :key="fi">{{ pid }}</span>
                    </div>
                    <!-- 机审标签（第三行） -->
                    <div class="trc-tags" v-if="r.machineTags && r.machineTags.length">
                      <span class="trc-tag-label">机审</span>
                      <span class="trc-tag trc-tag-machine" v-for="(t, ti) in r.machineTags" :key="'m'+ti" :title="t.id + ' ' + t.name">{{ t.id }} {{ t.name }}</span>
                    </div>
                    <!-- 人审标签（第四行） -->
                    <div class="trc-tags" v-if="r.humanTags && r.humanTags.length">
                      <span class="trc-tag-label">人审</span>
                      <span class="trc-tag trc-tag-human" v-for="(t, ti) in r.humanTags" :key="'h'+ti" :title="t.id + ' ' + t.name">{{ t.id }} {{ t.name }}</span>
                    </div>
                    <!-- OCR / ASR / Patch ASR 文字截取 -->
                    <div class="trc-content-text" v-if="getResultOcr(r) || getResultAsr(r) || getResultPatchAsr(r)">
                      {{ truncateText(getResultPrimaryText(r), 55) }}
                    </div>
                    <!-- 审核元素指纹（取自 AI 评测明细表 element_fingerprint） -->
                    <div class="trc-fp" v-if="r.element_fingerprint || r.elementFingerprint" @click.stop="copyGridFingerprint(r.element_fingerprint || r.elementFingerprint)">
                      <Icon name="copy" :size="12" class="trc-fp-ic" :class="{ copied: gridFpCopied }" />
                      <span class="trc-fp-label">审核元素指纹</span>
                      <span class="trc-fp-val mono" :title="r.element_fingerprint || r.elementFingerprint">{{ (r.element_fingerprint || r.elementFingerprint).slice(0, 24) }}{{ (r.element_fingerprint || r.elementFingerprint).length > 24 ? '…' : '' }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 空状态 -->
              <div class="tr-empty" v-if="!searching && !searchError && !searchResults.length">
                <Icon name="search" :size="32" />
                <p>暂无检索结果</p>
              </div>
            </div>
            </template><!-- /Tab1: 相似样本检索 -->

            <!-- ====== Tab2: 结论沉淀库检索 ====== -->
            <template v-if="activeTab === 'sediment'">
            <!-- 沉淀搜索输入区 -->
            <div class="sed-search-area">
              <div class="sed-search-box">
                <Icon name="search" :size="15" class="sed-search-icon" />
                <input
                  v-model="sedSearchText"
                  class="sed-search-input"
                  placeholder="搜索结论/描述/误杀原因/处理信息..."
                  @input="onSedSearchInput"
                  @keyup.enter="doSedSearch"
                />
                <button class="sed-search-btn" :disabled="sedSearching" @click="doSedSearch">
                  <Icon name="refresh" :size="14" :class="{ spinning: sedSearching }" />
                </button>
              </div>
              <!-- 标签精确匹配 -->
              <div class="sed-filter-row">
                <label class="sed-filter-label">标签</label>
                <select v-model="sedTagId" @change="doSedSearch">
                  <option value="">全部标签</option>
                  <option v-for="t in sedTagOptions" :key="t.tagId" :value="t.tagId">{{ t.tagName }} ({{ t.tagId }})</option>
                </select>
              </div>
              <!-- 行业 + 结论类型 -->
              <div class="sed-filter-row sed-filter-row-2">
                <div class="sed-filter-item">
                  <label class="sed-filter-label">行业</label>
                  <input v-model="sedIndustry" placeholder="如：电商" @input="onSedSearchInput" />
                </div>
                <div class="sed-filter-item">
                  <label class="sed-filter-label">结论类型</label>
                  <select v-model="sedResultType" @change="doSedSearch">
                    <option value="">全部</option>
                    <option value="real_fp">真实误杀</option>
                    <option value="machine_right">机审正确</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- 沉淀结果列表 -->
            <div class="sed-results">
              <div class="sed-header">
                <span v-if="!sedSearching && !sedError">共 {{ sedResults.length }} 条结论</span>
                <span v-if="sedSearching" class="tr-loading">检索中…</span>
                <span v-if="sedError" class="tr-error">{{ sedError }}</span>
              </div>

              <div class="sed-list" v-if="sedResults.length">
                <div v-for="s in sedResults" :key="s.id" class="sed-card" @click="openSedDetail(s)">
                  <div class="sed-card-head">
                    <span class="sed-card-title">{{ s.title }}</span>
                    <span class="sed-card-badge" :style="{ background: (RESULT_TYPE_MAP[s.resultType] || RESULT_TYPE_MAP.other).color }">
                      {{ (RESULT_TYPE_MAP[s.resultType] || RESULT_TYPE_MAP.other).label }}
                    </span>
                  </div>
                  <div class="sed-card-tags">
                    <span class="sed-tag" v-if="s.tagName">{{ s.tagName }} ({{ s.tagId }})</span>
                    <span class="sed-tag sed-tag-ind" v-if="s.industry">{{ s.industry }}</span>
                    <span class="sed-tag sed-tag-cat" v-if="s.category">{{ s.category }}</span>
                  </div>
                  <div class="sed-card-desc" v-if="s.desc">{{ truncateText(s.desc, 100) }}</div>
                  <div class="sed-card-conclusion" v-if="s.conclusion">
                    <span class="sed-card-label">结论：</span>{{ truncateText(s.conclusion, 120) }}
                  </div>
                  <div class="sed-card-meta">
                    <span v-if="s.submitter">提需：{{ s.submitter }}</span>
                    <span v-if="s.handler">处理：{{ s.handler }}</span>
                    <span v-if="s.adoptedAt">{{ s.adoptedAt?.slice(0, 10) }}</span>
                  </div>
                </div>
              </div>

              <!-- 空状态 -->
              <div class="tr-empty" v-if="!sedSearching && !sedError && !sedResults.length">
                <Icon name="sediment" :size="32" />
                <p>暂无结论沉淀</p>
              </div>
            </div>
            </template><!-- /Tab2: 结论沉淀库 -->
          </div>
        </div>

        <!-- ====== 卡片详情弹窗（点击检索结果卡片弹出） ====== -->
        <transition name="fade-scale">
          <div v-if="detailVisible && detailResult" class="detail-overlay" @click.self="closeResultDetail">
            <div class="detail-modal">
              <div class="detail-header">
                <Icon name="info" :size="16" />
                <span>检索结果详情</span>
                <span class="detail-score" :style="{ color: scoreColor(detailResult.score) }">
                  <span class="detail-score-dot" :style="{ background: scoreColor(detailResult.score) }"></span>
                  相似度 {{ fmtScore(detailResult.score) }}
                </span>
                <button class="detail-close" @click="closeResultDetail"><Icon name="close" :size="20" /></button>
              </div>
              <div class="detail-body">
                <!-- 左：素材预览（固定，不滚动） -->
                <div class="detail-left">
                  <div class="dl-media-box" v-if="getResultMediaType(detailResult) === 'image' && getResultMediaUrl(detailResult)">
<img :src="safeUrl(getResultMediaUrl(detailResult))" :data-raw-url="getResultMediaUrl(detailResult)" @error="onResultMediaErr('detail', $event)" alt="预览" />
                  </div>
                  <div class="dl-media-box" v-else-if="getResultMediaType(detailResult) === 'video' && getResultMediaUrl(detailResult)">
<VideoPlayer :src="getResultMediaUrl(detailResult)" :raw-url="getResultMediaUrl(detailResult)" fit="contain" />
                  </div>
                  <div class="dl-media-box dl-media-text" v-else>
                    <div class="dl-text-snippet">{{ truncateText(getResultPrimaryText(detailResult), 200) }}</div>
                  </div>
                  <a v-if="getResultMediaUrl(detailResult)" :href="rawHttpsUrlPlain(getResultMediaUrl(detailResult))" target="_blank" referrerpolicy="no-referrer" class="dl-open-link">
                    <Icon name="link" :size="12" /> 打开原链接
                  </a>
                </div>
                <!-- 右：信息滚动区 -->
                <div class="detail-right">
                  <!-- 信息区：双列 -->
                  <div class="dr-info-grid">
                    <div class="drg-item">
                      <span class="drg-label">元素类型</span>
                      <span class="drg-value">{{ elementTypeName(detailResult.element_type) || getResultElementType(detailResult) }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.v6_level_name_1">
                      <span class="drg-label">一级行业</span>
                      <span class="drg-value">{{ detailResult.v6_level_name_1 }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.v6_level_name_2">
                      <span class="drg-label">二级行业</span>
                      <span class="drg-value">{{ detailResult.v6_level_name_2 }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.element_fingerprint">
                      <span class="drg-label">指纹</span>
                      <div class="drg-value-row fp-detail-row">
                        <span class="drg-value mono fp-detail-text" @click.stop="copyFingerprint(detailResult.element_fingerprint)">{{ detailResult.element_fingerprint }}</span>
                        <button class="drg-copy-btn" :class="{ copied: detailFpCopied }" @click.stop="copyFingerprint(detailResult.element_fingerprint)" title="复制指纹">
                          <Icon :name="detailFpCopied ? 'check' : 'copy'" :size="14" />
                        </button>
                      </div>
                    </div>
                    <div class="drg-item" v-if="detailResult.fine_person">
                      <span class="drg-label">审核人</span>
                      <span class="drg-value">{{ detailResult.fine_person }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.fine_data_time">
                      <span class="drg-label">审核时间</span>
                      <span class="drg-value">{{ formatFineTime(detailResult.fine_data_time) }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.partition_time">
                      <span class="drg-label">数据日期</span>
                      <span class="drg-value">{{ detailResult.partition_time }}</span>
                    </div>
                    <div class="drg-item" v-if="detailResult.is_human_result != null">
                      <span class="drg-label">人工审核</span>
                      <span class="drg-value">{{ detailResult.is_human_result === '1' || detailResult.is_human_result === 1 ? '是' : '否' }}</span>
                    </div>
                  </div>

                  <!-- 机审标签 -->
                  <div class="dr-section" v-if="detailResult.machineTags && detailResult.machineTags.length">
                    <div class="drs-header">
                      <span class="drs-title">机审标签</span>
                    </div>
                    <div class="drs-body">
                      <div class="dr-fine-list">
                        <div class="dr-fine-item" v-for="(t, ti) in detailResult.machineTags" :key="'dm'+ti">
                          <span class="dr-fine-idx">#{{ ti + 1 }}</span>
                          <span class="dr-fine-pid">{{ t.id }}</span>
                          <span class="dr-fine-txt">{{ t.name }}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- 人审标签 -->
                  <div class="dr-section" v-if="detailResult.humanTags && detailResult.humanTags.length">
                    <div class="drs-header">
                      <span class="drs-title">人审标签</span>
                    </div>
                    <div class="drs-body">
                      <div class="dr-fine-list">
                        <div class="dr-fine-item" v-for="(t, ti) in detailResult.humanTags" :key="'dh'+ti">
                          <span class="dr-fine-idx">#{{ ti + 1 }}</span>
                          <span class="dr-fine-pid">{{ t.id }}</span>
                          <span class="dr-fine-txt">{{ t.name }}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- OCR 内容 -->
                  <div class="dr-section" v-if="getResultOcr(detailResult)">
                    <div class="drs-header">
                      <span class="drs-title">OCR 识别文本</span>
                    </div>
                    <div class="drs-body">
                      <div class="drs-textbox">{{ getResultOcr(detailResult) }}</div>
                    </div>
                  </div>

                  <!-- ASR 内容 -->
                  <div class="dr-section" v-if="getResultAsr(detailResult)">
                    <div class="drs-header">
                      <span class="drs-title">ASR 语音识别</span>
                    </div>
                    <div class="drs-body">
                      <div class="drs-textbox">{{ getResultAsr(detailResult) }}</div>
                    </div>
                  </div>

                  <!-- Patch ASR 片段内容（视频 ASR 片段任务） -->
                  <div class="dr-section" v-if="getResultPatchAsr(detailResult)">
                    <div class="drs-header">
                      <span class="drs-title">ASR 片段文本</span>
                    </div>
                    <div class="drs-body">
                      <div class="drs-textbox">{{ getResultPatchAsr(detailResult) }}</div>
                    </div>
                  </div>

                  <!-- 精标终审结果 -->
                  <div class="dr-section" v-if="fineData || fineLabels.length || fineExtraPolicyListEmpty">
                    <div class="drs-header">
                      <span class="drs-title">精标终审结果</span>
                    </div>
                    <div class="drs-body">
                      <div class="dr-fine-root">
                        <div class="dr-fine-row" v-if="isFineCorrect(detailResult) !== null">
                          <span class="dr-fine-label">模型归因：</span>
                          <span :class="isFineCorrect(detailResult) ? 'dr-fine-ok' : 'dr-fine-fail'">
                            {{ isFineCorrect(detailResult) ? '✓ 采纳' : '✗ 不采纳' }}
                          </span>
                        </div>
                        <div class="dr-fine-row" v-if="getFinePerson(detailResult)">
                          <span class="dr-fine-label">审核人：</span>
                          <span class="dr-fine-val">{{ getFinePerson(detailResult) }}</span>
                        </div>
                        <div class="dr-fine-row" v-if="getFineTime(detailResult)">
                          <span class="dr-fine-label">审核时间：</span>
                          <span class="dr-fine-val">{{ formatFineTime(getFineTime(detailResult)) }}</span>
                        </div>
                        <div class="dr-fine-row" v-if="fineLabels.length || fineExtraPolicyListEmpty">
                          <span class="dr-fine-label">最终标签：</span>
                          <span v-if="fineLabels.length">{{ fineLabels.map(l => l.policyId).filter(Boolean).join(', ') }}</span>
                          <span class="dr-fine-empty" v-if="fineExtraPolicyListEmpty">无需追加额外标签</span>
                        </div>
                        <div class="dr-fine-list" v-if="fineLabels.length">
                          <div class="dr-fine-item" v-for="(item, idx) in fineLabels" :key="idx">
                            <span class="dr-fine-idx">#{{ idx + 1 }}</span>
                            <span class="dr-fine-pid">{{ item.policyId }}</span>
                            <span class="dr-fine-txt-sm">(样本)</span>
                            <div class="dr-fine-reason">{{ item.fullReason }}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </transition>

        <!-- ====== 结论沉淀详情弹窗 ====== -->
        <transition name="fade-scale">
          <div v-if="sedDetailVisible && sedDetailItem" class="detail-overlay" @click.self="closeSedDetail">
            <div class="detail-modal sed-detail-modal">
              <div class="detail-header">
                <Icon name="sediment" :size="16" />
                <span>结论沉淀详情</span>
                <span class="sed-detail-badge" :style="{ background: (RESULT_TYPE_MAP[sedDetailItem.resultType] || RESULT_TYPE_MAP.other).color }">
                  {{ (RESULT_TYPE_MAP[sedDetailItem.resultType] || RESULT_TYPE_MAP.other).label }}
                </span>
<button class="detail-close" @click="closeSedDetail"><Icon name="close" :size="20" /></button>
              </div>
              <div class="sed-detail-body">
                <h3 class="sed-detail-title">{{ sedDetailItem.title }}</h3>
                <div class="sed-detail-tags">
                  <span class="sed-tag" v-if="sedDetailItem.tagName">{{ sedDetailItem.tagName }} ({{ sedDetailItem.tagId }})</span>
                  <span class="sed-tag sed-tag-ind" v-if="sedDetailItem.industry">{{ sedDetailItem.industry }}</span>
                  <span class="sed-tag sed-tag-cat" v-if="sedDetailItem.category">{{ sedDetailItem.category }}</span>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.desc">
                  <div class="sed-detail-label">问题描述</div>
                  <div class="sed-detail-text">{{ sedDetailItem.desc }}</div>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.feature">
                  <div class="sed-detail-label">素材特征</div>
                  <div class="sed-detail-text">{{ sedDetailItem.feature }}</div>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.conclusion">
                  <div class="sed-detail-label">结论</div>
                  <div class="sed-detail-text sed-detail-highlight">{{ sedDetailItem.conclusion }}</div>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.fpReason">
                  <div class="sed-detail-label">误杀原因</div>
                  <div class="sed-detail-text">{{ sedDetailItem.fpReason }}</div>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.handleInfo">
                  <div class="sed-detail-label">处理信息</div>
                  <div class="sed-detail-text">{{ sedDetailItem.handleInfo }}</div>
                </div>
                <div class="sed-detail-section" v-if="sedDetailItem.relatedMaterials && sedDetailItem.relatedMaterials.length">
                  <div class="sed-detail-label">关联素材 ({{ sedDetailItem.relatedMaterials.length }})</div>
                  <div class="sed-detail-materials">
                    <div v-for="(m, mi) in sedDetailItem.relatedMaterials" :key="mi" class="sed-detail-mat">
                      <span class="sed-detail-mat-type">{{ m.type || m.mediaType || '素材' }}</span>
                      <span class="sed-detail-mat-url" v-if="m.url || m.mediaUrl">{{ truncateText(m.url || m.mediaUrl, 60) }}</span>
                    </div>
                  </div>
                </div>
                <div class="sed-detail-meta">
                  <span v-if="sedDetailItem.submitter">提需人：{{ sedDetailItem.submitter }}</span>
                  <span v-if="sedDetailItem.handler">处理人：{{ sedDetailItem.handler }}</span>
                  <span v-if="sedDetailItem.adoptedAt">采纳时间：{{ sedDetailItem.adoptedAt?.slice(0, 10) }}</span>
                </div>
                <div class="sed-detail-updates" v-if="sedDetailItem.updates && sedDetailItem.updates.length">
                  <div class="sed-detail-label">更新记录</div>
                  <div v-for="(u, ui) in sedDetailItem.updates" :key="ui" class="sed-detail-update">
                    <span class="sed-detail-update-by">{{ u.by }}</span>
                    <span class="sed-detail-update-time">{{ u.at?.slice(0, 16) }}</span>
                    <span class="sed-detail-update-reason" v-if="u.reason">{{ u.reason }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </transition>

        <!-- 页脚 -->
        <p class="trag-footer">由 <a href="https://platform.example.com/" style="color: #8A2BE2;" target="_blank">With</a> 通过自然语言生成</p>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.trag-overlay {
  position: fixed; inset: 0; background: rgba(15,22,36,.55); backdrop-filter: blur(6px); z-index: 400;
  display: flex; align-items: center; justify-content: center; padding: 8px;
}
.trag-modal {
  position: relative; width: 100%; height: calc(100vh - 16px); max-width: 100%; max-height: none;
  background: #fff; border-radius: 16px; box-shadow: 0 24px 80px rgba(15,22,36,.3);
  overflow: hidden; display: flex; flex-direction: column;
}
.trag-close {
  position: absolute; top: 14px; right: 14px; z-index: 10;
  width: 38px; height: 38px; border-radius: 10px; border: none; cursor: pointer;
  background: rgba(0,0,0,.06); color: #64748b; display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.trag-close:hover { background: rgba(0,0,0,.12); color: #1e293b; }

/* Body: 左右分栏 60/40 */
.trag-body { flex: 1; display: flex; gap: 1px; background: #f1f5f9; overflow: hidden; }

/* ====== 左侧（60%）====== */
.trag-left { width: 60%; background: #fff; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }

/* 顶部标题栏 */
.tl-title-bar { background: #0f0f23; border-radius: 0; padding: 10px 14px; border-bottom: 1px solid #1e293b; flex-shrink: 0; }
.tl-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 14px; flex-wrap: wrap; }
.tl-title-row:last-child { margin-bottom: 0; }
.tl-eid { font-size: 16px; font-weight: 700; color: #e2e8f0; }
.tl-tagval { font-size: 14px; color: #94a3b8; }
.tl-title-badge { font-size: 13px; font-weight: 600; padding: 2px 10px; border-radius: 10px; }
.tl-badge-type { background: rgba(99,102,241,.25); color: #a5b4fc; }
.tl-badge-ind { background: rgba(34,197,94,.2); color: #4ade80; }
.tl-badge-ind2 { background: rgba(14,165,233,.2); color: #67e8f9; }
.tl-title-val { font-size: 15px; color: #c4b5fd; }
.tl-title-link { color: #818cf8; text-decoration: none; font-size: 14px; display: inline-flex; align-items: center; gap: 4px; }
.tl-title-link:hover { color: #a5b4fc; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: 'SF Mono','Menlo',monospace; }

/* 指针 hover 复制功能 */
.fp-hover-wrap { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; max-width: 100%; position: relative; border-radius: 6px; padding: 2px 6px; transition: background .15s; }
.fp-hover-wrap:hover { background: rgba(99,102,241,.15); }
.fp-hover-text { color: #c4b5fd; transition: color .15s; }
.fp-hover-wrap:hover .fp-hover-text { color: #a5b4fc; }
.fp-hover-icon { display: inline-flex; align-items: center; gap: 3px; opacity: 0; transition: all .2s; color: #94a3b8; flex-shrink: 0; }
.fp-hover-wrap:hover .fp-hover-icon { opacity: 1; color: #818cf8; }
.fp-hover-icon.copied { opacity: 1; color: #4ade80; }
.fp-hover-tip { font-size: 12px; white-space: nowrap; }

/* 详情弹窗指纹行 hover */
.fp-detail-row { cursor: pointer; }
.fp-detail-text { cursor: pointer; transition: color .15s; }
.fp-detail-row:hover .fp-detail-text { color: #4f46e5; }
.drg-copy-btn.copied { background: #16a34a; color: #fff; border-color: #16a34a; }
/* 媒体预览区 - 固定大小，不随底部信息区变化 */
.tl-media { flex: 1 0 55%; min-height: 0; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.tl-media video, .tl-media img { max-width: 100%; max-height: 100%; object-fit: contain; }
.tl-text-content { padding: 20px; font-size: 15px; line-height: 1.7; color: #e2e8f0; word-break: break-all; white-space: pre-wrap; height: 100%; overflow-y: auto; background: #0f172a; }
.tl-fallback { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #94a3b8; padding: 30px; font-size: 15px; }

/* 底部信息区（OCR/ASR 折叠区，独立滚动，不挤占标注区） */
.tl-bottom-info { flex: 0 1 auto; max-height: 200px; overflow-y: auto; border-top: 1px solid #e2e8f0; padding: 12px 16px; background: #fff; }
.tl-bottom-info::-webkit-scrollbar { width: 4px; }
.tl-bottom-info::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
.tl-info-row { margin-bottom: 8px; }
.ti-collapsible { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 5px 0; }
.ti-label { font-size: 16px; font-weight: 800; color: #1e293b; text-transform: uppercase; flex-shrink: 0; }
.ti-preview { font-size: 15px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.ti-toggle-icon { color: #94a3b8; flex-shrink: 0; transition: transform .15s; }
.ti-collapsible:hover .ti-toggle-icon { color: #4f46e5; }
.ti-collapsible:hover .ti-label { color: #4f46e5; }
.ti-textbox-wrap { margin-top: 4px; }
.ti-textbox { width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; font-size: 15px; color: #334155; outline: none; resize: vertical; font-family: inherit; line-height: 1.6; background: #f8fafc; word-break: break-all; min-height: 40px; }
.ti-textbox:focus { border-color: #4f46e5; }

/* 编辑功能区（归因分类 + 标注，固定在底部始终可见，可独立滚动） */
.tl-edit { flex: 0 0 auto; max-height: 42%; overflow-y: auto; padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #fff; display: flex; flex-direction: column; gap: 10px; }
.tl-edit::-webkit-scrollbar { width: 4px; }
.tl-edit::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
.tle-section { display: flex; flex-direction: column; gap: 5px; }
.tle-label { font-size: 16px; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: .5px; }
.tle-select { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 12px; font-size: 15px; color: #1e293b; outline: none; background: #fff; cursor: pointer; }
.tle-select:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
.tle-textarea { resize: none; min-height: auto; background: #fff; padding: 8px 12px; font-size: 15px; color: #334155; line-height: 1.5; }

/* ====== 右侧（40%）====== */
.trag-right { width: 40%; background: #fff; display: flex; flex-direction: column; overflow: hidden; }

/* 右侧顶部标题 */
.trag-right-header { padding: 14px 18px 10px; border-bottom: 1px solid #f1f5f9; flex-shrink: 0; display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 800; color: #1e293b; }

/* 任务类型下拉框 + 字数控制 */
.trag-task-bar { padding: 12px 18px; border-bottom: 1px solid #f1f5f9; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px; }
.ttb-row { display: flex; align-items: center; gap: 10px; }
.ttb-label { font-size: 16px; font-weight: 800; color: #1e293b; text-transform: uppercase; letter-spacing: .5px; flex-shrink: 0; min-width: 62px; }
.ttb-select { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; font-size: 16px; font-weight: 700; color: #1e293b; outline: none; background: #fff; cursor: pointer; }
.ttb-select:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
.ttb-select-sm { flex: 0 0 auto; width: 110px; }
.ttb-hint { font-size: 15px; color: #64748b; }
.ttb-warn { display: block; margin-top: 8px; padding: 9px 12px; font-size: 13px; line-height: 1.6; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; }

/* 检索输入区 */
.trag-input-area { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; flex-shrink: 0; }
.ti-search-box { display: flex; align-items: center; gap: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0 8px; }
.ti-search-box:focus-within { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.1); }
.ti-search-icon { color: #94a3b8; flex-shrink: 0; }
.ti-search-input { flex: 1; border: none; outline: none; background: transparent; padding: 10px 4px; font-size: 15px; color: #1e293b; min-width: 0; }
.ti-search-input::placeholder { color: #cbd5e1; }
.ti-search-btn {
  display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 8px;
  border: none; cursor: pointer; background: #4f46e5; color: #fff; transition: all .15s; flex-shrink: 0;
}
.ti-search-btn:hover { background: #4338ca; }
.ti-search-btn:disabled { opacity: .6; cursor: not-allowed; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 图片上传行（契约 3.5 节） */
.ti-upload-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.ti-upload-btn {
  display: inline-flex; align-items: center; gap: 5px; font-size: 14px; color: #4f46e5;
  background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 7px 12px; cursor: pointer;
  transition: all .15s; user-select: none;
}
.ti-upload-btn:hover { background: #e0e7ff; border-color: #a5b4fc; }
.ti-upload-btn.disabled { opacity: .6; cursor: not-allowed; }
.ti-upload-input { display: none; }
.ti-upload-ok { display: inline-flex; align-items: center; gap: 3px; font-size: 13px; color: #16a34a; cursor: pointer; }
.ti-upload-ok:hover { text-decoration: underline; }
.ti-upload-err { font-size: 13px; color: #dc2626; }

.ti-filter-toggle { display: flex; align-items: center; gap: 5px; margin-top: 8px; font-size: 14px; color: #64748b; cursor: pointer; background: none; border: none; padding: 0; }
.ti-filter-toggle:hover { color: #4f46e5; }
.ti-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; }
.filter-row { display: flex; flex-direction: column; gap: 3px; }
.filter-row label { font-size: 13px; color: #94a3b8; font-weight: 600; }
.filter-row input, .filter-row select { border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; font-size: 14px; color: #334155; outline: none; }
.filter-row input:focus, .filter-row select:focus { border-color: #4f46e5; }
.switch-label { display: flex; align-items: center; gap: 5px; font-size: 14px; cursor: pointer; }
.switch-label input { width: 16px; height: 16px; }

/* 检索结果 */
.trag-results { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 12px 16px; }
.tr-header { font-size: 14px; color: #64748b; margin-bottom: 8px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.tr-count { font-weight: 600; }
.tr-cached { color: #d97706; font-size: 13px; }
.tr-loading { color: #4f46e5; }
.tr-error { color: #e53e3e; }
.tr-export-btn {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; color: #4f46e5; background: #eef2ff; border: 1px solid #c7d2fe;
  border-radius: 6px; padding: 3px 10px; cursor: pointer; transition: background .15s, box-shadow .15s;
}
.tr-export-btn:hover { background: #e0e7ff; box-shadow: 0 1px 4px rgba(79,70,229,.2); }
.tr-export-btn:disabled { opacity: .6; cursor: default; }

/* 检索结果网格 */
.tr-grid { overflow-y: auto; display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding-bottom: 4px; align-content: start; flex: 1; min-height: 0; }
.tr-grid::-webkit-scrollbar { width: 5px; }
.tr-grid::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 5px; }

.tr-card {
  border-radius: 10px; border: 1px solid #e2e8f0; overflow: hidden; cursor: pointer;
  transition: all .15s; background: #fff; display: flex; flex-direction: column; position: relative;
  height: 300px;
}
.tr-card:hover { border-color: #a5b4fc; box-shadow: 0 4px 16px rgba(79,70,229,.12); transform: translateY(-2px); }

/* 媒体区：约占卡片 55% 高度 */
.trc-media { position: relative; width: 100%; height: 55%; min-height: 120px; background: #f1f5f9; overflow: hidden; flex-shrink: 0; }
.trc-media img, .trc-media video { width: 100%; height: 100%; object-fit: cover; }
.trc-media-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #cbd5e1; background: #f8fafc; }
.trc-media-text { background: #f8fafc; display: flex; align-items: flex-start; justify-content: flex-start; padding: 12px; }
.trc-text-snippet { font-size: 15px; color: #475569; line-height: 1.6; word-break: break-all; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }

.trc-score { position: absolute; top: 6px; left: 6px; background: rgba(255,255,255,.92); backdrop-filter: blur(4px); border-radius: 6px; padding: 3px 10px; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 4px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
.trc-score-dot { width: 8px; height: 8px; border-radius: 50%; }

/* 底部信息区：自动填充卡片下半部分 */
.trc-info { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 5px; flex: 1; border-top: 1px solid #f1f5f9; overflow: hidden; }
.trc-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.trc-tag { font-size: 13px; padding: 3px 9px; border-radius: 4px; white-space: nowrap; }
.trc-tag-ind { background: #e0e7ff; color: #4f46e5; }
.trc-tag-ind2 { background: #f0f4ff; color: #6366f1; }
.trc-tag-element { background: #ecfdf5; color: #059669; }
.trc-tag-policy { background: #fef2f2; color: #e53e3e; }
.trc-tag-human { background: #fef3c7; color: #d97706; }
.trc-tag-machine { background: #f0fdf4; color: #059669; }
.trc-tag-fine { background: #eef2ff; color: #4f46e5; font-weight: 600; border: 1px solid #c7d2fe; }
.trc-tag-label { font-size: 12px; padding: 3px 6px; border-radius: 3px; background: #f1f5f9; color: #64748b; font-weight: 600; white-space: nowrap; }

/* OCR/ASR 文字截取内容 */
.trc-content-text { font-size: 14px; color: #64748b; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }
.trc-fp { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #475569; padding-top: 2px; cursor: pointer; user-select: none; }
.trc-fp:hover { color: #2d3748; }
.trc-fp-ic { color: #94a3b8; flex-shrink: 0; transition: color .15s; }
.trc-fp-ic.copied { color: #22c55e; }
.trc-fp-label { color: #94a3b8; flex-shrink: 0; }
.trc-fp-val { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #475569; letter-spacing: -0.2px; }

.tr-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #cbd5e1; }
.tr-empty p { font-size: 15px; }

/* ====== 卡片详情弹窗 ====== */
.detail-overlay {
  position: absolute; inset: 0; background: rgba(15,22,36,.45); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; z-index: 50; padding: 12px;
}
.detail-modal {
  position: relative; width: 88%; max-width: 1400px; height: 88%; max-height: none; background: #fff;
  border-radius: 14px; box-shadow: 0 20px 60px rgba(15,22,36,.25);
  overflow: hidden; display: flex; flex-direction: column;
}
.detail-header {
  display: flex; align-items: center; gap: 12px; padding: 14px 24px;
  background: #fff; flex-shrink: 0; border-bottom: 1px solid #f1f5f9;
}
.detail-header > span:first-of-type { font-size: 18px; font-weight: 700; color: #1e293b; }
.detail-score { margin-left: auto; font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 8px; background: #f1f5f9; color: #1e293b; }
.detail-score-dot { width: 8px; height: 8px; border-radius: 50%; }
.detail-close { width: 34px; height: 34px; border-radius: 8px; border: none; cursor: pointer; background: #f1f5f9; color: #64748b; display: flex; align-items: center; justify-content: center; transition: all .15s; flex-shrink: 0; margin-left: 12px; }
.detail-close:hover { background: #e2e8f0; color: #1e293b; }

.detail-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }

/* 左侧：固定素材预览 */
.detail-left { width: 35%; flex-shrink: 0; display: flex; flex-direction: column; background: #000; border-right: 1px solid #1e293b; }
.dl-media-box { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; min-height: 0; }
.dl-media-box img, .dl-media-box video { width: 100%; height: 100%; object-fit: contain; }
.dl-media-text { background: #1a1a2e; padding: 20px; }
.dl-text-snippet { font-size: 16px; color: #c4b5fd; line-height: 1.8; word-break: break-all; white-space: pre-wrap; text-align: left; }
.dl-open-link { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #818cf8; text-decoration: none; padding: 10px 16px; background: #0f0f23; align-self: stretch; border-top: 1px solid #1a1a2e; transition: background .15s; }
.dl-open-link:hover { background: #1a1a2e; color: #a5b4fc; }

/* 右侧：信息滚动区 */
.detail-right { flex: 1; padding: 20px 24px; overflow-y: auto; background: #fafbff; }
.detail-right::-webkit-scrollbar { width: 5px; }
.detail-right::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 5px; }

/* 信息区：双列网格 */
.dr-info-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px 20px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 2px solid #eef2ff; }
.drg-item { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.drg-label { font-size: 17px; font-weight: 700; color: #4f46e5; text-transform: uppercase; letter-spacing: .5px; }
.drg-value { font-size: 17px; color: #1e293b; line-height: 1.5; word-break: break-all; }
.drg-value.mono { font-family: 'SF Mono', 'Menlo', monospace; font-size: 15px; }
.drg-value-row { display: flex; align-items: flex-start; gap: 6px; }
.drg-copy-btn { width: 32px; height: 32px; border-radius: 6px; border: 1px solid #e2e8f0; background: #fff; color: #64748b; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all .15s; }
.drg-copy-btn:hover { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.drg-copy-btn.copied { background: #16a34a; color: #fff; border-color: #16a34a; }

/* Section 通用 */
.dr-section { margin-bottom: 16px; }
.drs-header { display: flex; align-items: center; gap: 8px; padding: 8px 0; cursor: default; }
.drs-title { font-size: 18px; font-weight: 800; color: #1e293b; }
.drs-body { margin-top: 10px; }
.drs-textbox {
  font-size: 16px; color: #334155; line-height: 1.9; background: #f8fafc;
  border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px;
  word-break: break-all; white-space: pre-wrap; max-height: none; overflow-y: auto;
}

/* 精标区域 — 对齐图片样式 */
.dr-fine-root {
  background: #fff; border: 1.5px solid #e0e7ff; border-radius: 10px; padding: 16px 20px;
}
.dr-fine-row { margin-bottom: 10px; font-size: 17px; color: #1e293b; display: flex; align-items: center; gap: 8px; }
.dr-fine-label { font-weight: 700; color: #1e293b; }
.dr-fine-val { color: #334155; font-size: 16px; }
.dr-fine-empty { color: #94a3b8; font-size: 15px; font-style: italic; }
.dr-fine-ok { color: #16a34a; font-weight: 700; background: #f0fdf4; padding: 3px 14px; border-radius: 20px; font-size: 15px; }
.dr-fine-fail { color: #dc2626; font-weight: 700; background: #fef2f2; padding: 3px 14px; border-radius: 20px; font-size: 15px; }
.dr-fine-list { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.dr-fine-item {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  padding: 12px 16px; background: #fafbff; border-radius: 8px; border: 1px solid #eef2ff;
}
.dr-fine-idx { color: #4f46e5; font-weight: 800; font-size: 14px; }
.dr-fine-pid { color: #4f46e5; font-weight: 700; font-size: 17px; background: #eef2ff; padding: 3px 12px; border-radius: 4px; }
.dr-fine-txt-sm { color: #94a3b8; font-size: 15px; }
.dr-fine-reason {
  width: 100%; color: #475569; font-size: 16px; line-height: 1.8; padding-left: 10px;
  border-left: 3px solid #818cf8; margin-top: 6px;
}

/* 页脚 */
.trag-footer { text-align: center; padding: 8px; font-size: 12px; color: #94a3b8; flex-shrink: 0; border-top: 1px solid #f1f5f9; }
.trag-footer a { font-weight: 600; }

/* 动画 */
.fade-scale-enter-active, .fade-scale-leave-active { transition: all .2s ease; }
.fade-scale-enter-from, .fade-scale-leave-to { opacity: 0; transform: scale(.95); }
.slide-down-enter-active, .slide-down-leave-active { transition: all .2s ease; overflow: hidden; }
.slide-down-enter-from, .slide-down-leave-to { opacity: 0; max-height: 0; }
.slide-down-enter-to, .slide-down-leave-from { opacity: 1; max-height: 400px; }

/* ====== Tab 切换栏 ====== */
.trag-tabs {
  display: flex; gap: 0; flex-shrink: 0; border-bottom: 2px solid #f1f5f9;
}
.trag-tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 12px 8px; font-size: 15px; font-weight: 600; color: #94a3b8;
  background: none; border: none; cursor: pointer; transition: all .2s;
  border-bottom: 3px solid transparent; margin-bottom: -2px;
}
.trag-tab:hover { color: #4f46e5; background: #fafbff; }
.trag-tab.active { color: #4f46e5; font-weight: 800; border-bottom-color: #4f46e5; }

/* ====== 结论沉淀检索 ====== */
.sed-search-area { padding: 12px 18px 8px; flex-shrink: 0; border-bottom: 1px solid #f1f5f9; }
.sed-search-box { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.sed-search-icon { color: #94a3b8; flex-shrink: 0; }
.sed-search-input {
  flex: 1; height: 36px; border: 1.5px solid #e2e8f0; border-radius: 8px;
  padding: 0 12px; font-size: 14px; outline: none; transition: border-color .2s;
}
.sed-search-input:focus { border-color: #4f46e5; }
.sed-search-btn {
  width: 36px; height: 36px; border: none; border-radius: 8px; background: #4f46e5;
  color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0;
}
.sed-search-btn:disabled { opacity: .6; cursor: not-allowed; }
.sed-filter-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.sed-filter-row-2 { display: flex; gap: 10px; }
.sed-filter-item { flex: 1; display: flex; align-items: center; gap: 8px; }
.sed-filter-label { font-size: 14px; font-weight: 700; color: #1e293b; white-space: nowrap; }
.sed-filter-row select, .sed-filter-row input, .sed-filter-item select, .sed-filter-item input {
  flex: 1; height: 32px; border: 1.5px solid #e2e8f0; border-radius: 6px; padding: 0 8px;
  font-size: 14px; outline: none;
}
.sed-filter-row select:focus, .sed-filter-row input:focus { border-color: #4f46e5; }

/* 沉淀结果列表 */
.sed-results { flex: 1; overflow-y: auto; padding: 10px 18px; }
.sed-header { padding: 6px 0 10px; font-size: 14px; color: #64748b; }
.sed-list { display: flex; flex-direction: column; gap: 10px; }
.sed-card {
  padding: 14px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px;
  cursor: pointer; transition: all .2s;
}
.sed-card:hover { border-color: #c7d2fe; background: #fafbff; box-shadow: 0 2px 8px rgba(79,70,229,.08); }
.sed-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.sed-card-title { font-size: 15px; font-weight: 700; color: #1e293b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sed-card-badge { color: #fff; font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }
.sed-card-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.sed-tag { font-size: 12px; padding: 2px 8px; border-radius: 4px; background: #f1f5f9; color: #475569; }
.sed-tag-ind { background: #e8eaff; color: #4f46e5; }
.sed-tag-cat { background: #fef3c7; color: #92400e; }
.sed-card-desc { font-size: 13px; color: #64748b; line-height: 1.6; margin-bottom: 4px; }
.sed-card-conclusion { font-size: 13px; color: #334155; line-height: 1.6; }
.sed-card-label { font-weight: 700; color: #4f46e5; }
.sed-card-meta { display: flex; gap: 12px; margin-top: 8px; font-size: 12px; color: #94a3b8; }

/* 结论沉淀详情弹窗 */
.sed-detail-modal { max-width: 700px; }
.sed-detail-badge { color: #fff; font-size: 12px; font-weight: 700; padding: 3px 12px; border-radius: 20px; margin-left: auto; margin-right: 12px; }
.sed-detail-body { padding: 20px 24px; overflow-y: auto; max-height: calc(85vh - 60px); }
.sed-detail-title { font-size: 20px; font-weight: 800; color: #1e293b; margin-bottom: 12px; }
.sed-detail-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.sed-detail-section { margin-bottom: 16px; }
.sed-detail-label { font-size: 15px; font-weight: 800; color: #1e293b; margin-bottom: 6px; }
.sed-detail-text { font-size: 15px; color: #334155; line-height: 1.8; background: #f8fafc; border-radius: 8px; padding: 12px 16px; border: 1px solid #e2e8f0; white-space: pre-wrap; word-break: break-all; }
.sed-detail-highlight { background: #f0fdf4; border-color: #bbf7d0; color: #15803d; }
.sed-detail-materials { display: flex; flex-direction: column; gap: 6px; }
.sed-detail-mat { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f8fafc; border-radius: 6px; font-size: 13px; }
.sed-detail-mat-type { font-weight: 700; color: #4f46e5; white-space: nowrap; }
.sed-detail-mat-url { color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sed-detail-meta { display: flex; gap: 16px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #f1f5f9; font-size: 14px; color: #64748b; }
.sed-detail-updates { margin-top: 16px; }
.sed-detail-update { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 14px; border-bottom: 1px dashed #f1f5f9; }
.sed-detail-update-by { font-weight: 700; color: #4f46e5; }
.sed-detail-update-time { color: #94a3b8; font-size: 13px; }
.sed-detail-update-reason { color: #334155; flex: 1; }
</style>