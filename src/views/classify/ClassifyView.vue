<script setup>
import { ref, computed, onMounted, onActivated, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToastStore } from '../../stores/toast'
import { useTicketFlowStore } from '../../stores/ticketFlow'
import { tagApi, classifyUploadApi, shareApi } from '../../api'
import Icon from '../../components/Icon.vue'
import DateRangeFilter from '../../components/DateRangeFilter.vue'
import PreviewAnnotate from './PreviewAnnotate.vue'
import TagTrackView from './TagTrackView.vue'
import { usePersistedRef, useRemotePersistedRef } from '../../utils/usePersistedRef'
import * as XLSX from 'xlsx'

const route = useRoute()
const router = useRouter()
// 模块内部 tab：标签跟踪（前）/ 自由分析（后）
const innerTab = ref(route.query.tab === 'classify' ? 'classify' : 'track')
// 从提需入口带 tab 参数进入时定位到对应子页（keep-alive 下也需响应）
watch(() => route.query.tab, (tab) => {
  if (tab === 'track' || tab === 'classify') innerTab.value = tab
})
const toast = useToastStore()
const ticketFlow = useTicketFlowStore()
const isTicketFlow = computed(() => ticketFlow.active)

// 是否从标签详情页跳转过来（显示"返回标签明细"按钮）
const fromTagDetail = computed(() => !!route.query.tagId)

// 返回标签详情页
function backToTagDetail() {
  const tagId = route.query.tagId
  if (tagId) router.push({ path: `/classify/tag/${tagId}` })
}

// 预分类子组件 ref
const previewRef = ref(null)

// 分享快照模式：脱高原 tagId 的只读分享视图
const shareMode = ref(false)
const shareMeta = ref(null) // { shareId, owner, createdAt, expireDays }
const shareLoading = ref(false)

// 打开分享链接：拉取快照并脱高 tagId 还原视图
async function loadShare(shareId) {
  shareLoading.value = true
  try {
    const res = await shareApi.get(shareId)
    const p = res.payload || {}
    shareMeta.value = { shareId: res.shareId, owner: res.owner, createdAt: res.createdAt, expireDays: res.expireDays }
    // 进入只读分享模式
    shareMode.value = true
    // 用快照自带素材作为数据源（不依赖 materialApi/原 tagId）
    loadedTag.value = { id: p.tagId ?? `share-${shareId}`, name: p.tagName || '分享的分析', __manual: true, __share: true }
    dataSource.value = p.dataSource || 'platform'
    samples.value = Array.isArray(p.samples) ? p.samples : []
    // 把快照 cats + 标注 + 视图传递给子组件
    await nextTick()
    previewRef.value?.setShareMode?.(true)
    previewRef.value?.loadShare?.(p)
    toast.info(`已打开「${p.tagName || '分享的分析'}」的分享视图（只读）。点击「另存为我的副本」可在此基础上继续分析`)
  } catch (e) {
    toast.warn(e.message || '打开分享链接失败')
    shareMode.value = false
  } finally {
    shareLoading.value = false
  }
}

// 另存为我的副本：在当前已加载的可写标签上写回快照的分类与标注
async function forkShareToMine() {
  if (!loadedTag.value || loadedTag.value.__manual || loadedTag.value.__share) {
    toast.warn('请先加载一个可写入的标签（在上方选择标签并一键加载），再另存为副本')
    return
  }
  try {
    const r = await previewRef.value?.forkToMine?.()
    if (r) {
      shareMode.value = false
      toast.success('已退出只读分享模式，后续编辑将保存到你的标签')
    }
  } catch { /* toast 已在子组件处理 */ }
}

// 标记是否正在从路由参数初始化（防止 watch 触发重复加载）
let initializingFromRoute = false

// 时间窗口（支持从路由 query 初始化）；跨设备延续：服务端镜像
const classifyDate = useRemotePersistedRef('classify:tagDate', { preset: '', start: '', end: '' })
function dateRange() {
  const g = classifyDate.value
  if (g.start || g.end) return { start: g.start, end: g.end }
  return {}
}

// 顶层时间窗口（上提至与 inner-tabs 同一行）：标签跟踪 tab 用 globalDate，素材分类 tab 用 classifyDate
const globalDate = useRemotePersistedRef('tagtrack:globalDate', { preset: '', start: '', end: '' })
// 仅用于顶部 DateRangeFilter 的双向绑定：按当前 tab 自动切换对应底层时间窗口
const topDate = computed({
  get: () => (innerTab.value === 'track' ? globalDate.value : classifyDate.value),
  set: v => { if (innerTab.value === 'track') globalDate.value = v; else classifyDate.value = v },
})

// 真实标签列表（用于下拉候选）
const TAGS = ref([])

// 数据源切换：'platform' = 平台数据，'upload' = 上传数据
const dataSource = ref('platform')

// 选择标签 + 一键加载
const tagInput = ref('')
const loadedTag = ref(null)
const samples = ref([])

// 切换数据源
async function switchDataSource(ds) {
  if (dataSource.value === ds) return
  if (!loadedTag.value || loadedTag.value.__manual) {
    dataSource.value = ds
    toast.info('请先加载标签后切换数据源')
    return
  }
  dataSource.value = ds
  await reloadByDataSource()
}

// 按当前数据源重新加载素材
async function reloadByDataSource() {
  if (!loadedTag.value || loadedTag.value.__manual) return
  const t = loadedTag.value
  try {
    let list
    if (dataSource.value === 'upload') {
      list = await classifyUploadApi.getSamples(t.id)
      // 上传数据为空时提示
      if (!Array.isArray(list) || !list.length) {
        toast.warn(`标签「${t.name} #${t.id}」暂无上传数据，请先上传数据`)
        samples.value = []
        return
      }
    } else {
      list = await tagApi.samples(t.id, { ...dateRange(), source: 'platform' })
    }
    samples.value = Array.isArray(list) ? list : []
    toast.success(`已切换到${dataSource.value === 'upload' ? '上传' : '平台'}数据，加载 ${samples.value.length} 条素材`)
  } catch (e) {
    samples.value = []
    toast.warn(e.message || '加载数据失败')
  }
}

async function loadTag() {
  // 手动粘贴 URL 预览模式下，禁止自动/筛选变化/切换触发 loadTag 覆盖已粘贴的素材
  if (loadedTag.value && loadedTag.value.__manual) return
  const v = tagInput.value.trim()
  if (!v) { toast.warn('请先选择标签，加载后显示该标签下的素材内容'); return }
  const t = TAGS.value.find(x => `${x.id}` === v || x.name === v) || TAGS.value[0]
  if (!t) { toast.warn('未找到匹配的标签'); return }
  loadedTag.value = t
  try {
    let list
    if (dataSource.value === 'upload') {
      list = await classifyUploadApi.getSamples(t.id)
      if (!Array.isArray(list) || !list.length) {
        toast.warn(`标签「${t.name} #${t.id}」暂无上传数据，请先上传数据`)
        samples.value = []
        return
      }
    } else {
      list = await tagApi.samples(t.id, { ...dateRange(), source: 'platform' })
    }
    samples.value = Array.isArray(list) ? list : []
    toast.success(`已加载标签「${t.name} #${t.id}」下 ${samples.value.length} 条 FP 素材`)
  } catch (e) {
    samples.value = []
    toast.warn(e.message || '加载素材失败')
  }
}

onMounted(async () => {
  try { TAGS.value = await tagApi.list() || [] } catch { TAGS.value = [] }
  // 加载上传历史
  await loadUploadHistory()

  // 处理路由参数：从标签详情页跳转过来时自动填充标签和时间窗口
  const q = route.query
  if (q.tagId) {
    tagInput.value = String(q.tagId)
    // 设置时间窗口（标记为路由初始化，防止 watch 重复加载）
    if (q.start || q.end) {
      initializingFromRoute = true
      classifyDate.value = {
        preset: String(q.preset || ''),
        start: String(q.start || ''),
        end: String(q.end || ''),
      }
    }
    // 等待标签列表加载完成后自动触发加载（按当前数据源）
    const t = TAGS.value.find(x => `${x.id}` === String(q.tagId))
    if (t) {
      tagInput.value = String(t.id)
      loadedTag.value = t
      try {
        let list
        if (dataSource.value === 'upload') {
          list = await classifyUploadApi.getSamples(t.id)
          if (!Array.isArray(list) || !list.length) {
            toast.warn(`标签「${t.name} #${t.id}」暂无上传数据`)
            samples.value = []
          } else {
            samples.value = list
            toast.success(`已加载标签「${t.name} #${t.id}」下 ${samples.value.length} 条上传数据`)
          }
        } else {
          list = await tagApi.samples(t.id, { ...dateRange(), source: 'platform' })
          samples.value = Array.isArray(list) ? list : []
          toast.success(`已加载标签「${t.name} #${t.id}」下 ${samples.value.length} 条 FP 素材`)
        }
      } catch (e) {
        toast.warn(e.message || '加载素材失败')
      }
    }
    // 初始化完成，后续时间窗口变化正常触发 watch
    initializingFromRoute = false
  }

  // 处理分享链接（脱离原 tagId 的只读分析视图）
  if (route.query.share) {
    await loadShare(String(route.query.share))
  }
})

// keep-alive 场景：从标签详情页跳转回来时，组件不会重新 mount，需手动响应路由参数变化
// onActivated 在 keep-alive 缓存激活时触发（也包含首次 mount），首次 mount 已由 onMounted 处理
onActivated(async () => {
  // 刷新上传历史（保持与当前数据状态同步）
  loadUploadHistory()
  // 仅在已有标签列表（非首次mount且 keep-alive 重新激活）时处理路由参数
  if (!TAGS.value.length) return
  const q = route.query
  if (!q.tagId) return
  // 如果当前已加载同一标签则跳过
  if (loadedTag.value && String(loadedTag.value.id) === String(q.tagId)) return

  tagInput.value = String(q.tagId)
  if (q.start || q.end) {
    initializingFromRoute = true
    classifyDate.value = {
      preset: String(q.preset || ''),
      start: String(q.start || ''),
      end: String(q.end || ''),
    }
  }
  const t = TAGS.value.find(x => `${x.id}` === String(q.tagId))
  if (t) {
    tagInput.value = String(t.id)
    loadedTag.value = t
    try {
      let list
      if (dataSource.value === 'upload') {
        list = await classifyUploadApi.getSamples(t.id)
        if (!Array.isArray(list) || !list.length) {
          toast.warn(`标签「${t.name} #${t.id}」暂无上传数据`)
          samples.value = []
        } else {
          samples.value = list
          toast.success(`已加载标签「${t.name} #${t.id}」下 ${samples.value.length} 条上传数据`)
        }
      } else {
        list = await tagApi.samples(t.id, { ...dateRange(), source: 'platform' })
        samples.value = Array.isArray(list) ? list : []
        toast.success(`已加载标签「${t.name} #${t.id}」下 ${samples.value.length} 条 FP 素材`)
      }
    } catch (e) {
      toast.warn(e.message || '加载素材失败')
    }
  }
  initializingFromRoute = false
})

// 时间窗口变化时，如果已加载标签且使用平台数据则自动重新加载（上传数据不依赖时间窗口）
watch(classifyDate, () => {
  if (initializingFromRoute) return
  if (loadedTag.value && !loadedTag.value.__manual && dataSource.value === 'platform') {
    loadTag()
  }
}, { deep: true })

/* ============ 素材 URL 手动粘贴加载 ============ */
const urlText = ref('')
const urlSamples = ref([])
const expireOpt = ref('30')
const urlCollapsed = ref(false)

const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm']
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp']

function normUrl(u) {
  // 归一化媒体 URL：去掉签名等查询参数与片段，统一 host 小写、去尾部斜杠
  // http→https 协议归一，并剥离路径段内嵌的签名/令牌后缀（如 /abc_sigXXX/def.mp4 → /abc/def.mp4）
  // 用于去重判定，避免同一素材因 CDN 签名(sign/expire/t/路径令牌)或协议不同而被识别为多个
  if (!u || typeof u !== 'string') return ''
  try {
    const x = new URL(u)
    const path = x.pathname.replace(/\/+$/, '').split('/').map(seg => {
      // 去除路径段末尾嵌入的签名/令牌子串（_sigXXX / -signXXX / .tokenXXX 等），不影响真实目录名
      const clean = seg.replace(/[._-](sign|sig|token|expire|signature|auth)[a-z0-9_]*$/i, '')
      return clean || seg
    }).join('/')
    return `https://${x.hostname.toLowerCase()}/${path}`
  } catch {
    return u.split('?')[0].split('#')[0]
  }
}

function detectType(url) {
  // 去掉查询串后取后缀
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  if (VIDEO_EXT.includes(ext)) return { isVideo: true, type: '视频' }
  if (IMAGE_EXT.includes(ext)) return { isVideo: false, type: '图片' }
  // 无法从后缀判断：优先按视频探测（adsmind 视频链接常无后缀）
  return { isVideo: /video|\.f\d+/.test(clean), type: '未知' }
}

function loadUrls() {
  const lines = urlText.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  // 支持「url|fingerprint」格式：从上传数据导出的素材行可携带 md5 指纹，提升去重准确率
  const parsed = lines.map(line => {
    const idx = line.indexOf('|')
    if (idx > 0) {
      const u = line.slice(0, idx).trim()
      const fp = line.slice(idx + 1).trim()
      if (/^https?:\/\//i.test(u)) return { url: u, fp }
    }
    return { url: line, fp: '' }
  }).filter(p => /^https?:\/\//i.test(p.url))
  if (!parsed.length) { toast.warn('请每行粘贴一个有效的素材 URL（http/https），可选附 md5：URL|fingerprint'); return }
  // 按归一化 key 去重：同一素材即使签名参数/协议不同也只保留一条（保留首个原始 URL 用于加载）
  const seen = new Map()
  for (const p of parsed) {
    const key = normUrl(p.url)
    if (!seen.has(key)) seen.set(key, p)
  }
  const items = [...seen.values()]
  // 同步更新文本框为去重后的URL列表
  urlText.value = items.map(p => p.fp ? `${p.url}|${p.fp}` : p.url).join('\n')
  urlSamples.value = items.map((p, i) => {
    const t = detectType(p.url)
    return {
      id: `URL-${String(i + 1).padStart(3, '0')}`,
      mediaUrl: p.url,
      elementFingerprint: p.fp,
      isVideo: t.isVideo,
      elementTypeName: t.type === '未知' ? (t.isVideo ? '视频' : '图片') : t.type,
      type: t.type,
      ocrContent: '',
      asrContent: '',
      classNum: 0,
    }
  })
  // 手动 URL 加载视为一个虚拟"标签"，让 PreviewAnnotate 正常渲染
  loadedTag.value = { id: `url-${Date.now()}`, name: '手动素材预览', __manual: true }
  samples.value = urlSamples.value
  toast.success(`已加载 ${items.length} 条素材，可直接预览播放`)
}

function clearUrls() {
  urlText.value = ''
  urlSamples.value = []
  if (loadedTag.value?.__manual) { loadedTag.value = null; samples.value = [] }
  toast.info('已清空素材 URL')
}

function copySnapshot() {
  const lines = urlText.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) { toast.warn('暂无可复制的素材 URL'); return }
  // 复制时输出去掉签名参数的干净 URL，避免把易变签名粘回造成重复素材
  const cleanUrls = [...new Set(lines.map(normUrl))].filter(Boolean)
  const text = cleanUrls.join('\n')
  navigator.clipboard?.writeText(text)
    .then(() => toast.success(`已复制 ${cleanUrls.length} 条素材快照（有效期 ${expireOpt.value} 天）`))
    .catch(() => toast.warn('复制失败，请手动选择文本复制'))
}

/* ============ 上传数据（Excel/CSV） ============ */
const uploadInputRef = ref(null)
const uploading = ref(false)
const uploadHistory = ref([])
const showUploadHistory = ref(false)
const uploadedTagIds = ref(new Set()) // 有上传数据的标签ID集合
const hasRetryContext = computed(() => !!window._uploadRetryContext)

// 上传文件后：从内容里解析出全部标签，交由用户选择再上传
const parsedTags = ref([])        // [{ id, name, count, system }]
const showTagSelect = ref(false)
const selectedTagId = ref('')     // 当前选中的标签ID（默认出现最多）
let pendingUpload = null          // 解析结果暂存：{ file, uploadSamples, categories, supplements }

// 触发文件选择
function triggerUpload() {
  uploadInputRef.value?.click()
}

// 解析 Excel/CSV 文件并上传
async function handleFileUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return
  e.target.value = '' // 重置 input 以支持重复选择同一文件

  uploading.value = true
  try {
    // 读取文件
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '' })

    if (!jsonRows.length) {
      toast.warn('文件中没有数据行')
      return
    }

    // 列名映射（兼容中英文表头）
    const colMap = {
      '到达时间': 'arriveTime',
      'AMS一级行业名称(开户行业)': 'industryL1',
      'AMS二级行业名称(开户行业)': 'industryL2',
      '审核元素类型': 'elementTypeName',
      '审核标签ID': 'machineTag',
      'AI评测人审标签': 'humanTag',
      '审核元素值': 'mediaUrl',
      '审核物理指纹(md5)': 'elementFingerprint',
      'ocr_text': 'ocrContent',
      'asr_text': 'asrContent',
      'class_num': 'classNum',
      '分类': 'categoryName',
      '补充说明': 'supplement',
    }

    // 转换每行为统一格式
    const uploadSamples = []
    const categories = []
    const supplements = []
    for (const row of jsonRows) {
      // 灵活匹配列名（大小写、空格不敏感）
      const getVal = (keys) => {
        for (const k of keys) {
          for (const rk of Object.keys(row)) {
            if (rk.replace(/\s+/g, '').toLowerCase() === k.replace(/\s+/g, '').toLowerCase()) {
              return row[rk]
            }
          }
        }
        return ''
      }

      const arriveTime = getVal(['到达时间', 'arrive_time', 'arriveTime'])
      const industryL1 = getVal(['AMS一级行业名称(开户行业)', 'industry_l1', 'industryL1', '一级行业'])
      const industryL2 = getVal(['AMS二级行业名称(开户行业)', 'industry_l2', 'industryL2', '二级行业'])
      const elementTypeName = getVal(['审核元素类型', 'element_type', 'elementType', '元素类型'])
      const machineTag = getVal(['审核标签ID', 'machine_tag', 'machineTag', '审核标签'])
      const humanTag = getVal(['AI评测人审标签', 'human_tag', 'humanTag', '人审标签'])
      const mediaUrl = getVal(['审核元素值', 'element_value', 'elementValue', 'media_url', 'mediaUrl'])
      const elementFingerprint = getVal(['审核物理指纹(md5)', 'element_fingerprint', 'elementFingerprint', 'fingerprint', 'md5'])
      const ocrContent = getVal(['ocr_text', 'ocr_content', 'ocrContent', 'ocr'])
      const asrContent = getVal(['asr_text', 'asr_content', 'asrContent', 'asr'])
      const classNum = Number(getVal(['class_num', 'classNum', '分类号']) || 0)
      const classId = String(getVal(['class_id', 'classId', 'classid', '聚类ID']) || '')
      const categoryName = getVal(['分类', 'category', 'categoryName'])
      const supplement = getVal(['补充说明', 'supplement', '备注'])

      // 生成 sample_id（使用指纹或序号）
      const sampleId = elementFingerprint || `UP-${uploadSamples.length + 1}`

      // 判断元素类型
      let isVideo = false
      let elementType = ''
      if (elementTypeName) {
        // 将数字编码转为字符串，支持数字编码：3=图片，4=视频
        const typeStr = String(elementTypeName)
        if (typeStr.includes('视频') || typeStr === 'ELEMENT_TYPE_VIDEO' || typeStr === '4') {
          isVideo = true; elementType = 'ELEMENT_TYPE_VIDEO'
        } else if (typeStr.includes('图片') || typeStr === 'ELEMENT_TYPE_IMAGE' || typeStr === '3') {
          elementType = 'ELEMENT_TYPE_IMAGE'
        } else if (typeStr.includes('文本') || typeStr === 'ELEMENT_TYPE_TEXT') {
          elementType = 'ELEMENT_TYPE_TEXT'
        } else if (typeStr.includes('落地页') || typeStr === 'ELEMENT_TYPE_URL') {
          elementType = 'ELEMENT_TYPE_URL'
        } else {
          elementType = typeStr
        }
      }

      uploadSamples.push({
        sampleId,
        elementType,
        elementTypeName: elementTypeName || (isVideo ? '视频' : '图片'),
        isVideo,
        machineTag: machineTag || '',
        humanTag,
        industryL1,
        industryL2,
        mediaUrl,
        ocrContent,
        asrContent,
        classNum,
        classId,
        arriveTime,
        elementFingerprint,
        isFp: true,
      })

      // 收集分类和补充说明
      if (categoryName || supplement) {
        categories.push({ sampleId, categoryName: String(categoryName || '') })
        supplements.push({ sampleId, supplement: String(supplement || '') })
      }
    }

    if (!uploadSamples.length) {
      toast.warn('未能从文件中解析出有效数据')
      return
    }

    // ── 从上传内容里解析出全部标签（去重 + 按出现频次排序），交由用户选择 ──
    // 用户若已手动选了标签，则仅作为该标签的默认选中项；不强制、不再自动上传
    const selTagVal = tagInput.value.trim()
    const selTag = selTagVal
      ? TAGS.value.find(x => `${x.id}` === selTagVal || x.name === selTagVal)
      : null

    // 收集出现的所有标签ID（按文件名里「审核标签ID」列解析，支持逗号分隔多个）
    const rawTagIds = uploadSamples
      .map(s => String(s.machineTag || '').trim())
      .flatMap(v => v.split(/[,，]/).map(id => id.replace(/[\[\]()（）\s]/g, '').trim()))
      .filter(Boolean)
    const tagIdCounts = {}
    for (const id of rawTagIds) tagIdCounts[id] = (tagIdCounts[id] || 0) + 1
    // 按出现次数降序，出现最多者默认选中
    const sorted = Object.entries(tagIdCounts).sort((a, b) => b[1] - a[1])
    if (!sorted.length) {
      // 完全没有解析到标签：若用户已手动选了标签，仍以该标签上传；否则提示先选
      if (selTag) {
        doUpload({ id: selTag.id, name: selTag.name }, file, uploadSamples, categories, supplements)
        return
      }
      toast.warn('无法从文件中识别标签ID，请在「选择标签」中手动指定后再上传数据')
      return
    }
    parsedTags.value = sorted.map(([id, count]) => {
      const sys = TAGS.value.find(x => `${x.id}` === id)
      return { id, name: sys ? sys.name : `标签 ${id}`, count, system: !!sys }
    })
    // 默认选中：用户已选标签优先，否则取出现最多的
    selectedTagId.value = selTag ? String(selTag.id) : sorted[0][0]
    pendingUpload = { file, uploadSamples, categories, supplements }
    showTagSelect.value = true
  } catch (err) {
    toast.warn(err.message || '上传失败')
  } finally {
    uploading.value = false
  }
}

// 用户弹窗确认标签后，执行真实上传
function confirmTagAndUpload() {
  const item = parsedTags.value.find(x => x.id === selectedTagId.value)
  if (!item || !pendingUpload) return
  const t = item.system
    ? (TAGS.value.find(x => `${x.id}` === item.id) || { id: item.id, name: item.name })
    : { id: item.id, name: item.name }
  const { file, uploadSamples, categories, supplements } = pendingUpload
  // 把所选标签写入全部样本的 machineTag
  uploadSamples.forEach(s => { if (!s.machineTag) s.machineTag = String(t.id) })
  tagInput.value = String(t.id)
  showTagSelect.value = false
  pendingUpload = null
  doUpload(t, file, uploadSamples, categories, supplements)
}

// 真正执行上传到后端（含部分失败处理、数据源切换、历史刷新）
async function doUpload(t, file, uploadSamples, categories, supplements) {
  uploading.value = true
  try {
    const result = await classifyUploadApi.upload({
      tagId: t.id,
      tagName: t.name,
      fileName: file.name,
      samples: uploadSamples,
      categories: categories.length ? categories : undefined,
      supplements: supplements.length ? supplements : undefined,
    })

    if (result.partialFailure) {
      window._uploadRetryContext = {
        tagId: t.id,
        tagName: t.name,
        fileName: file.name,
        failedBatches: result.failedBatches,
        allSamples: uploadSamples,
        categories,
        supplements,
      }
      const failedCount = result.failedBatches.reduce((s, b) => s + b.count, 0)
      toast.warn(
        `${result.message}\n\n点击按钮重试失败批次（${failedCount} 条），或点击"重试"按钮重新提交失败数据。`,
        { duration: 12000 }
      )
    } else {
      toast.success(`已上传 ${result.sampleCount} 条数据（${result.classCount} 个分类），点击"一键预分类"查看分类结果`)
    }

    if (result.sampleCount > 0) {
      uploadedTagIds.value.add(t.id)
      dataSource.value = 'upload'
      loadedTag.value = t
      samples.value = Array.isArray(result.samples) ? result.samples : []
    }

    await loadUploadHistory()
  } catch (err) {
    toast.warn(err.message || '上传失败')
  } finally {
    uploading.value = false
  }
}

// 加载上传历史
async function loadUploadHistory() {
  try {
    const list = await classifyUploadApi.getHistory()
    uploadHistory.value = Array.isArray(list) ? list : []
  } catch {
    uploadHistory.value = []
  }
}

// 一键清空所有上传数据
async function clearAllUploads() {
  if (!confirm('确定要清空所有标签的上传数据吗？清空后将回退到平台数据。')) return
  try {
    await classifyUploadApi.clearAll()
    uploadedTagIds.value = new Set()
    uploadHistory.value = []
    toast.success('已清空所有上传数据')
    // 如果当前已加载标签，按数据源重新加载数据
    if (loadedTag.value && !loadedTag.value.__manual) {
      if (dataSource.value === 'upload') {
        // 上传数据源被清空了，切换回平台数据
        dataSource.value = 'platform'
        const list = await tagApi.samples(loadedTag.value.id, { ...dateRange(), source: 'platform' })
        samples.value = Array.isArray(list) ? list : []
        toast.info('已自动切换到平台数据')
      } else {
        const list = await tagApi.samples(loadedTag.value.id, { ...dateRange(), source: 'platform' })
        samples.value = Array.isArray(list) ? list : []
      }
    }
  } catch (err) {
    toast.warn(err.message || '清空失败')
  }
}

// 重试上传失败批次
async function retryFailedUpload() {
  const ctx = window._uploadRetryContext
  if (!ctx) {
    toast.warn('没有可重试的失败批次')
    return
  }

  uploading.value = true
  try {
    // 从 allSamples 中提取失败批次的样本数据
    const failedSamples = []
    for (const fb of ctx.failedBatches) {
      const batch = ctx.allSamples.slice(fb.start, fb.end)
      failedSamples.push(...batch)
    }

    if (!failedSamples.length) {
      toast.warn('失败批次中无有效数据')
      return
    }

    const result = await classifyUploadApi.retryFailed({
      tagId: ctx.tagId,
      tagName: ctx.tagName,
      fileName: ctx.fileName,
      failedSamples,
      categories: ctx.categories?.length ? ctx.categories : undefined,
      supplements: ctx.supplements?.length ? ctx.supplements : undefined,
    })

    if (result.ok) {
      toast.success(`重试成功！已补传 ${result.sampleCount} 条数据`)
      delete window._uploadRetryContext
      // 重新加载该标签的完整数据
      if (loadedTag.value?.id === ctx.tagId) {
        const updated = await classifyUploadApi.getSamples(ctx.tagId)
        if (Array.isArray(updated)) samples.value = updated
      }
      await loadUploadHistory()
    } else if (result.partialFailure) {
      // 仍有部分失败，更新重试上下文
      window._uploadRetryContext.failedBatches = result.failedBatches
      const stillFailed = result.failedBatches.reduce((s, b) => s + b.count, 0)
      toast.warn(`重试仍有 ${stillFailed} 条失败，已成功 ${result.sampleCount} 条。可再次重试或联系管理员`)

      if (loadedTag.value?.id === ctx.tagId && result.sampleCount > 0) {
        const updated = await classifyUploadApi.getSamples(ctx.tagId)
        if (Array.isArray(updated)) samples.value = updated
      }
    } else {
      toast.warn(result.message || '重试失败')
    }
  } catch (err) {
    toast.warn(err.message || '重试失败')
  } finally {
    uploading.value = false
  }
}

// 切换上传历史面板
function toggleUploadHistory() {
  showUploadHistory.value = !showUploadHistory.value
  if (showUploadHistory.value && !uploadHistory.value.length) {
    loadUploadHistory()
  }
}
</script>

<template>
  <div class="page-wrap classify">
    <div class="top-bar">
      <div class="top-date">
        <!-- 标签跟踪 tab 不显示时间窗口：素材图片/数据是固定的，不随时间变动（用户要求） -->
        <DateRangeFilter v-if="innerTab !== 'track'" v-model="topDate" />
      </div>
      <div class="inner-tabs">
        <button class="it-btn" :class="{ on: innerTab === 'track' }" @click="innerTab = 'track'">标签跟踪</button>
        <button class="it-btn" :class="{ on: innerTab === 'classify' }" @click="innerTab = 'classify'">自由分析</button>
      </div>
    </div>
    <TagTrackView v-if="innerTab === 'track'" v-model:global-date="globalDate" />
    <template v-else>
    <div v-if="fromTagDetail" class="back-bar">
<button class="back-btn" @click="backToTagDetail"><Icon name="back" :size="16" />返回标签明细</button>
    </div>

    <div v-if="isTicketFlow" class="flow-tip">
      <Icon name="ticket" :size="16" />
      <span>提需流程进行中：加载标签后开启选择模式勾选素材，再点击「发起提需」</span>
    </div>
    <div class="card tag-bar rise">
      <label>选择标签：</label>
      <div class="ti-box">
        <Icon name="tagcount" :size="16" />
        <input v-model="tagInput" placeholder="请输入或选择标签 ID / 标签名" list="taglist" @keyup.enter="loadTag" />
        <datalist id="taglist">
          <option v-for="t in TAGS" :key="t.id" :value="`${t.id}`">{{ t.name }}</option>
        </datalist>
      </div>
      <button class="btn btn-primary btn-sm" @click="loadTag"><Icon name="search" :size="15" />一键加载</button>
      <!-- 上传数据入口 -->
      <div class="upload-bar">
        <input ref="uploadInputRef" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="handleFileUpload" />
        <button class="btn btn-soft btn-sm upload-btn" :disabled="uploading" @click="triggerUpload">
          <Icon name="upload" :size="15" />
          <span>{{ uploading ? '上传中...' : '上传数据' }}</span>
        </button>
        <!-- 仅在上次上传有失败批次时显示重试按钮 -->
        <button v-if="hasRetryContext" class="btn btn-warn btn-sm upload-retry-btn" :disabled="uploading" @click="retryFailedUpload">
          <Icon name="refresh" :size="15" />
          <span>重试失败批次</span>
        </button>
        <button class="btn btn-ghost btn-sm hist-btn" @click="toggleUploadHistory">
          <Icon name="history" :size="15" />
          <span>上传历史</span>
          <span v-if="uploadHistory.length" class="hist-badge">{{ uploadHistory.length }}</span>
        </button>
        <button v-if="uploadHistory.length" class="btn btn-ghost btn-sm clear-btn" @click="clearAllUploads">
          <Icon name="trash" :size="14" />
          <span>清空上传数据</span>
        </button>
      </div>
      <!-- 数据源切换：平台数据 / 上传数据 -->
      <div class="ds-switch" v-if="loadedTag && !loadedTag.__manual">
        <button class="ds-btn" :class="{ active: dataSource === 'platform' }" @click="switchDataSource('platform')">
          <Icon name="database" :size="14" />平台数据
        </button>
        <button class="ds-btn" :class="{ active: dataSource === 'upload' }" @click="switchDataSource('upload')">
          <Icon name="upload" :size="14" />上传数据
          <span v-if="uploadedTagIds.has(loadedTag.id)" class="ds-dot"></span>
        </button>
      </div>
      <span class="tb-tip" v-if="!loadedTag">可先上传数据，自动解析出标签后再选择；或手动选择标签后一键加载</span>
      <span class="tb-tip loaded" v-else><Icon name="check" :size="14" />已加载「{{ loadedTag.name }} #{{ loadedTag.id }}」· 去重后 {{ samples.length }} 条{{ dataSource === 'upload' ? '上传' : 'FP' }}素材<template v-if="samples.rawTotal && samples.rawTotal > samples.length">（真实总样本 {{ samples.rawTotal }} 条）</template></span>
      <!-- 分享快照：打开旧链接时只读查看；分享模式下可另存为副本继续分析 -->
      <div class="share-bar" v-if="loadedTag && shareMode">
        <button class="btn btn-primary btn-sm fork-btn" @click="forkShareToMine">
          <Icon name="copy" :size="15" />
          <span>另存为我的副本</span>
        </button>
        <span v-if="shareMeta" class="share-meta">只读分享 · 来自 {{ shareMeta.owner || '同事' }} · {{ shareMeta.expireDays === 0 ? '永不过期' : shareMeta.expireDays + '天有效' }}</span>
      </div>
    </div>

    <!-- 上传历史面板 -->
    <transition name="hist-fold">
      <div v-show="showUploadHistory" class="card upload-history-card rise">
        <div class="uh-header">
          <span class="uh-title"><Icon name="history" :size="16" />上传历史</span>
          <button class="btn btn-ghost btn-sm" @click="showUploadHistory = false"><Icon name="close" :size="14" />关闭</button>
        </div>
        <div v-if="!uploadHistory.length" class="uh-empty">暂无上传记录</div>
        <table v-else class="uh-table">
          <thead>
            <tr>
              <th>上传时间</th>
              <th>标签</th>
              <th>文件名</th>
              <th>数据条数</th>
              <th>分类数</th>
              <th>上传人</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in uploadHistory" :key="h.id">
              <td>{{ h.uploadedAt }}</td>
              <td>{{ h.tagName }} #{{ h.tagId }}</td>
              <td class="uh-fname">{{ h.fileName }}</td>
              <td>{{ h.sampleCount }}</td>
              <td>{{ h.classCount }}</td>
              <td>{{ h.uploadedBy }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </transition>

    <!-- 上传后标签选择弹窗：从文件内容解析出全部标签，交由用户选择 -->
    <transition name="ts-fade">
      <div v-if="showTagSelect" class="ts-mask" @click.self="showTagSelect = false">
        <div class="ts-modal">
          <div class="ts-hd">
            <span class="ts-title"><Icon name="tagcount" :size="16" />请选择本次上传的标签</span>
            <button class="ts-close" @click="showTagSelect = false"><Icon name="close" :size="15" /></button>
          </div>
          <p class="ts-desc">
            已从文件中解析出 {{ parsedTags.length }} 个标签，共覆盖 {{ pendingUpload ? pendingUpload.uploadSamples.length : 0 }} 条数据。
            请选择本次要上传到的标签（默认已勾选出现最多的标签）：
          </p>
          <div class="ts-list">
            <label
              v-for="tg in parsedTags"
              :key="tg.id"
              class="ts-item"
              :class="{ active: selectedTagId === tg.id }"
            >
              <input type="radio" :value="tg.id" v-model="selectedTagId" />
              <span class="ts-name">{{ tg.name }}</span>
              <span class="ts-id">#{{ tg.id }}</span>
              <span class="ts-count">{{ tg.count }} 条</span>
              <span v-if="tg.system" class="ts-sys">系统内标签</span>
              <span v-else class="ts-sys unknown">未在标签库</span>
            </label>
          </div>
          <div class="ts-actions">
            <button class="btn btn-ghost btn-sm" @click="showTagSelect = false">取消</button>
            <button class="btn btn-primary btn-sm" @click="confirmTagAndUpload">确认并上传</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 素材 URL 手动粘贴：未加载标签、或处于手动预览模式时显示 -->
    <div v-if="!loadedTag || loadedTag.__manual" class="card url-card rise" :class="{ collapsed: urlCollapsed }">
      <div class="url-hd" @click="urlCollapsed = !urlCollapsed">
        <span class="url-hd-text">素材 URL</span>
        <button class="url-fold-btn" @click.stop="urlCollapsed = !urlCollapsed">
          <Icon :name="urlCollapsed ? 'chevronDown' : 'chevronUp'" :size="16" />
          <span>{{ urlCollapsed ? '展开' : '收起' }}</span>
        </button>
      </div>
      <transition name="url-fold">
        <div v-show="!urlCollapsed" class="url-body">
          <textarea
            v-model="urlText"
            class="url-ta"
            rows="6"
            placeholder="每行粘贴一个素材URL，支持图片和视频链接...&#10;&#10;示例：&#10;http://cdn.example.com/ads_svp_video__xxx.f20.mp4&#10;https://example.com/image.jpg"
          ></textarea>
          <div class="url-actions">
            <button class="btn btn-primary btn-sm" @click="loadUrls"><Icon name="download" :size="15" />加载素材</button>
            <button class="btn btn-ghost btn-sm" @click="clearUrls"><Icon name="close" :size="14" />清空</button>
            <div class="expire-box">
              <select v-model="expireOpt" class="expire-sel">
                <option value="7">7天后过期</option>
                <option value="30">30天后过期</option>
                <option value="90">90天后过期</option>
                <option value="0">永不过期</option>
              </select>
            </div>
            <button class="btn btn-snap btn-sm" @click="copySnapshot"><Icon name="doc" :size="14" />复制快照</button>
          </div>
          <p class="url-tip">支持 .mp4 / .mov / .avi / .webm 视频和 .jpg / .png / .gif / .webp 图片；无法从后缀判断类型时会自动探测</p>
        </div>
      </transition>
    </div>
    <PreviewAnnotate ref="previewRef" :samples="samples" :loaded-tag="loadedTag" :data-source="dataSource" :share-mode="shareMode" @update:share-mode="shareMode = $event" />
    </template>
  </div>
</template>

<style scoped>
.top-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.top-date { display: inline-flex; align-items: center; padding: 5px 8px; background: #fff; border: 1px solid var(--border-strong); border-radius: 11px; box-shadow: 0 2px 8px rgba(20,30,60,.04); }
.top-date :deep(.drf) { gap: 8px; }
.top-date :deep(.drf-btn) { padding: 4px 10px; font-size: 11px; }
.top-date :deep(.drf-custom input[type="date"]) { height: 26px; font-size: 12px; }
.inner-tabs { display: inline-flex; align-items: center; gap: 4px; padding: 4px; background: #f0f2f6; border-radius: 12px; }
.it-btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 28px; border: none; border-radius: 11px; font-size: 17px; font-weight: 700; color: var(--text-2); background: transparent; cursor: pointer; transition: all .18s; }
.it-btn:hover { color: var(--text-1); }
.it-btn.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); }
.ph { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; gap: 16px; flex-wrap: wrap; }
.ph-left { display: flex; flex-direction: column; gap: 12px; }
.back-bar { position: sticky; top: 112px; z-index: 90; margin: 0 0 10px 0; padding: 2px 0; }
.back-btn { display: inline-flex; align-items: center; gap: 7px; color: var(--brand); font-size: 14px; font-weight: 600; padding: 8px 18px; border-radius: 10px; border: 1px solid var(--brand); background: var(--brand-soft); transition: all .18s; box-shadow: 0 1px 6px rgba(79,124,255,.1); }
.back-btn:hover { background: var(--brand); color: #fff; border-color: var(--brand); box-shadow: 0 3px 12px rgba(79,124,255,.25); transform: translateX(-2px); }

.tag-bar { display: flex; align-items: center; gap: 12px; padding: 11px 16px; margin-bottom: 16px; flex-wrap: wrap; }
.flow-tip { display: flex; align-items: center; gap: 9px; margin-bottom: 16px; padding: 12px 16px; background: linear-gradient(90deg, var(--brand-soft), #eef2ff); border: 1px solid #d6e0ff; border-radius: 12px; font-size: 13px; color: var(--text-2); }
.flow-tip svg { color: var(--brand); flex-shrink: 0; }
.tag-bar > label { font-size: 13px; font-weight: 600; color: var(--text-2); }
.ti-box { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 9px; color: var(--text-3); min-width: 260px; transition: all .18s; }
.ti-box:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.ti-box input { flex: 1; font-size: 13px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }
.tb-tip { font-size: 12px; color: var(--text-4); }
.tb-tip.loaded { display: flex; align-items: center; gap: 5px; color: var(--green); font-weight: 500; }

/* 数据源切换 */
.ds-switch { display: inline-flex; align-items: center; gap: 0; border: 1px solid var(--border-strong); border-radius: 9px; overflow: hidden; height: 34px; }
.ds-btn { display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; height: 100%; font-size: 13px; font-weight: 600; color: var(--text-3); background: #fff; border: none; cursor: pointer; transition: all .18s; position: relative; white-space: nowrap; }
.ds-btn:not(:last-child) { border-right: 1px solid var(--border-strong); }
.ds-btn:hover { background: var(--brand-soft); color: var(--brand); }
.ds-btn.active { background: var(--brand); color: #fff; }
.ds-btn.active:hover { background: var(--brand); color: #fff; }
.ds-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #16a34a; flex-shrink: 0; }
.ds-btn.active .ds-dot { background: #fff; }

/* 上传数据入口 */
.upload-bar { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.upload-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 9px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.upload-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.hist-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 9px; font-size: 13px; position: relative; }
.hist-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--brand); color: #fff; font-size: 11px; font-weight: 700; }
.clear-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 9px; font-size: 13px; color: #e74c3c; }
.clear-btn:hover { background: #fef0ee; border-color: #f5c6cb; }

/* 上传历史面板 */
.upload-history-card { padding: 0; margin-bottom: 16px; overflow: hidden; }
.uh-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.uh-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: var(--text-2); }
.uh-empty { padding: 30px; text-align: center; color: var(--text-4); font-size: 13px; }
.uh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.uh-table thead th { padding: 10px 16px; text-align: left; font-weight: 600; color: var(--text-3); background: #f7f9fc; border-bottom: 1px solid var(--border); white-space: nowrap; }
.uh-table tbody td { padding: 10px 16px; border-bottom: 1px solid var(--border-light); color: var(--text-2); }
.uh-table tbody tr:hover { background: #f9fbff; }
.uh-fname { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-fold-enter-active, .hist-fold-leave-active { transition: all .25s ease; overflow: hidden; }
.hist-fold-enter-from, .hist-fold-leave-to { opacity: 0; max-height: 0; margin-bottom: 0; }
.hist-fold-enter-to, .hist-fold-leave-from { opacity: 1; max-height: 500px; }

/* 素材 URL 手动粘贴卡片 */
.url-card { padding: 0; margin-bottom: 16px; overflow: hidden; transition: all .25s ease; }
.url-card.collapsed { padding: 0; }
.url-hd { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; cursor: pointer; user-select: none; transition: background .15s; }
.url-hd:hover { background: #f7f9fc; }
.url-hd-text { font-size: 13px; font-weight: 700; color: var(--text-2); }
.url-fold-btn { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-3); background: none; border: none; cursor: pointer; padding: 4px 10px; border-radius: 7px; transition: all .15s; }
.url-fold-btn:hover { background: var(--brand-soft); color: var(--brand); }
.url-body { padding: 0 20px 18px; }
.url-ta { width: 100%; box-sizing: border-box; border: 1px solid var(--border-strong); border-radius: 12px; padding: 14px 16px; font-size: 13px; line-height: 1.7; color: var(--text-1); background: #fbfcfe; resize: vertical; font-family: 'SFMono-Regular', Consolas, Menlo, monospace; transition: all .18s; }
.url-ta::placeholder { color: var(--text-4); font-family: inherit; }
.url-ta:focus { outline: none; border-color: var(--brand); background: #fff; box-shadow: 0 0 0 3px rgba(79,124,255,.14); }
.url-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.expire-box { position: relative; }
.expire-sel { height: 34px; padding: 0 30px 0 12px; border: 1px solid var(--border-strong); border-radius: 9px; font-size: 13px; color: var(--text-2); background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237a8296' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center; -webkit-appearance: none; appearance: none; cursor: pointer; transition: all .15s; }
.expire-sel:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.btn-snap { background: var(--green, #16a34a); color: #fff; border: 1px solid transparent; }
.btn-snap:hover { background: #15803d; }
.url-tip { margin: 12px 0 0; font-size: 12px; color: var(--text-4); }

/* 折叠过渡动画 */
.url-fold-enter-active, .url-fold-leave-active { transition: all .25s ease; overflow: hidden; }
.url-fold-enter-from, .url-fold-leave-to { opacity: 0; max-height: 0; }
.url-fold-enter-to, .url-fold-leave-from { opacity: 1; max-height: 500px; }

.ph-title { display: flex; flex-direction: column; gap: 4px; }
.ph-title .page-sub { margin: 0; }
.ph-title .fp-sub { font-size: 12px; color: var(--text-4); font-weight: 500; margin-top: 0; }

/* 上传后标签选择弹窗 */
.ts-mask { position: fixed; inset: 0; background: rgba(20,28,46,.45); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.ts-modal { width: 480px; max-width: 100%; max-height: 80vh; background: #fff; border-radius: 16px; box-shadow: 0 20px 60px rgba(20,28,46,.28); display: flex; flex-direction: column; overflow: hidden; }
.ts-hd { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border, #eef1f6); }
.ts-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; color: var(--text-2, #2a3142); }
.ts-close { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: none; background: none; color: var(--text-3, #7a8296); cursor: pointer; transition: all .15s; }
.ts-close:hover { background: #f0f2f6; color: var(--text-2, #2a3142); }
.ts-desc { padding: 14px 20px 6px; margin: 0; font-size: 13px; color: var(--text-3, #7a8296); line-height: 1.6; }
.ts-list { padding: 8px 20px; overflow-y: auto; flex: 1; }
.ts-item { display: flex; align-items: center; gap: 10px; padding: 11px 14px; margin-bottom: 8px; border: 1px solid var(--border-strong, #d8deea); border-radius: 10px; cursor: pointer; transition: all .15s; }
.ts-item:hover { border-color: var(--brand, #4f7cff); background: var(--brand-soft, #eef2ff); }
.ts-item.active { border-color: var(--brand, #4f7cff); background: var(--brand-soft, #eef2ff); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.ts-item input { accent-color: var(--brand, #4f7cff); margin: 0; }
.ts-name { font-size: 14px; font-weight: 600; color: var(--text-1, #1a1f2e); }
.ts-id { font-size: 12px; color: var(--text-4, #9aa2b1); font-family: monospace; }
.ts-count { font-size: 12px; color: var(--brand, #4f7cff); background: var(--brand-soft, #eef2ff); padding: 2px 8px; border-radius: 10px; }
.ts-sys { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #e7f7ee; color: #16a34a; margin-left: auto; }
.ts-sys.unknown { background: #fef3e7; color: #d97706; }
.ts-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--border, #eef1f6); }
.ts-fade-enter-active, .ts-fade-leave-active { transition: opacity .2s ease; }
.ts-fade-enter-from, .ts-fade-leave-to { opacity: 0; }

/* 分享快照按钮区 */
.share-bar { display: flex; align-items: center; gap: 10px; margin-left: auto; padding-left: 8px; border-left: 1px dashed var(--border-strong, #d8deea); }
.btn-snap { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 9px; font-size: 13px; font-weight: 600; white-space: nowrap; color: #7c3aed; border: 1px solid #c4b5fd; background: #f5f3ff; transition: all .18s; }
.btn-snap:hover { background: #7c3aed; color: #fff; border-color: #7c3aed; box-shadow: 0 3px 12px rgba(124,58,237,.25); }
.btn-snap:disabled { opacity: .6; cursor: not-allowed; }
.fork-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 9px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.share-meta { font-size: 12px; color: var(--text-3, #7a8296); background: #f5f3ff; border: 1px solid #e9e2ff; padding: 4px 10px; border-radius: 20px; white-space: nowrap; }
</style>