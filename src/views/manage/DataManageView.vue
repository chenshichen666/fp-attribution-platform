<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useToastStore } from '../../stores/toast'
import { useAuthStore } from '../../stores/auth'
import * as XLSX from 'xlsx'
import { dataMetaApi } from '../../api/index'
import { useAnalysisStore } from '../../stores/analysis'
import { tagStatus } from '../../data/mock'
import Icon from '../../components/Icon.vue'

const toast = useToastStore()
const auth = useAuthStore()
const analysisStore = useAnalysisStore()

// ============ 标签页 ============
const activeTab = ref('upload')
const tabs = [
  { key: 'upload', label: '上传文件', icon: 'upload' },
  { key: 'fields', label: '字段说明', icon: 'doc' },
  { key: 'history', label: '导入历史', icon: 'clock' },
]

// ============ 数据集选择 ============
const datasets = [
  { id: 'ai-eval', name: 'AI评测明细数据' },
  { id: 'tag-precision', name: 'AI评测分析表（策略_标签）' },
]
const selectedDataset = ref('ai-eval')

// ============ 数据元信息（按数据集独立存储）============
const datasetMeta = ref({
  'ai-eval': { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 },
  'tag-precision': { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 },
})
// 当前选中数据集的元信息（便捷访问）
const dataMeta = computed(() => datasetMeta.value[selectedDataset.value] || { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 })
// 持久化的字段关联状态（按数据集独立存储，从后端加载）
const persistedFieldStatus = ref({
  'ai-eval': {},
  'tag-precision': {},
})

// ============ 预解析结果 ============
const previewTags = ref([])
const rawRows = ref([]) // 存储文件原始数据行，用于预览展示
const previewMeta = reactive({ total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
const hasPreview = computed(() => rawRows.value.length > 0)
// 从原始数据行提取列名，用于预览表格
const rawCols = computed(() => {
  if (!rawRows.value.length) return []
  return Object.keys(rawRows.value[0])
})

// 字段关联状态：检测上传文件中每个字段是否有数据（任意一行该字段非空即为已关联）
// 优先使用实时解析的 rawRows；上传成功后 rawRows 被清空，回退到持久化的 persistedFieldStatus
const fieldLinkStatus = computed(() => {
  const defs = currentFieldDefs.value
  // 有预览数据时实时计算
  if (rawRows.value.length) {
    const actualCols = rawCols.value.map(c => String(c).trim().toLowerCase())
  // 构建 字段名 -> 别名集合 的映射
  const aliasMap = {}
  if (selectedDataset.value === 'tag-precision') {
    Object.entries(PRECISION_COL_ALIAS).forEach(([key, aliases]) => {
      aliasMap[key] = aliases.map(a => a.toLowerCase())
    })
  } else {
    Object.entries(COL_ALIAS).forEach(([key, aliases]) => {
      aliasMap[key] = aliases.map(a => a.toLowerCase())
    })
  }
  // 字段def.name -> aliasMap key 的对应关系
  const nameToAliasKey = {
    'first_level_industry_name': 'industryL1',
    'second_level_industry_name': 'industryL2',
    'industry_l1': 'industryL1',
    'industry_l2': 'industryL2',
    'element_type_name': 'elementTypeName',
    'element_type': 'elementType',
    'policy_ids': 'machine',
    'ai_evaluate_policy_ids': 'human',
    'element_value': 'mediaUrl',
    'ocr_text': 'ocrContent',
    'asr_text': 'asrContent',
    'ops_advertiser_name': 'advertiser',
    'arrive_time': 'arriveTime',
    'ds': 'ds',
    'tag_id': 'id',
    'tag_name': 'name',
    'total': 'total',
    'fp': 'fp',
    'precision': 'precision',
    'sample_count': 'sampleCount',
    'model_version': 'modelVersion',
    'element_fingerprint': 'elementFingerprint',
    'fp_reason': 'fpReason',
    'remark': 'remark',
    'dc_id': 'dc_id',
    'uid': 'uid',
    'agency_uid': 'agency_uid',
    'agency_name': 'agency_name',
    'ai_evaluate_reviewer_name': 'ai_evaluate_reviewer_name',
    'class_num': 'classNum',
    'class_id': 'classId',
    'review_model_precision_prime': 'reviewModelPrecisionPrime',
  }

  // 找到字段对应的实际列名（精确匹配 / 中文名匹配 / 别名匹配 / 归一化匹配）
  function findActualCol(fieldDef) {
    const fieldName = typeof fieldDef === 'string' ? fieldDef : fieldDef.name
    const fn = fieldName.toLowerCase()
    // 1) 精确列名匹配（字段名）
    if (actualCols.includes(fn)) return fn
    // 2) 字段的 names 备选拼写匹配（如 ocr_text / ocr_test）
    if (fieldDef && fieldDef.names) {
      const hitName = fieldDef.names.map(n => n.toLowerCase()).find(n => actualCols.includes(n))
      if (hitName) return hitName
    }
    // 3) 中文名匹配（cn 可能含 "/" 分隔的多个名称）
    if (fieldDef && fieldDef.cn) {
      const cnList = String(fieldDef.cn).split('/').map(c => c.trim().toLowerCase()).filter(Boolean)
      const hitCn = cnList.find(c => actualCols.includes(c))
      if (hitCn) return hitCn
    }
    // 4) 别名匹配（含中英文别名）
    const aliasKey = nameToAliasKey[fieldName]
    if (aliasKey && aliasMap[aliasKey]) {
      const hit = aliasMap[aliasKey].find(a => actualCols.includes(a))
      if (hit) return hit
      // 4.1) 归一化匹配兜底：全角括号/空格/大小写差异
      const norm = function(s) { return String(s).toLowerCase().replace(/[（）]/g, function(c) { return c === '（' ? '(' : ')'; }).replace(/\s+/g, '') }
      const normedActual = actualCols.map(function(c) { return { raw: c, norm: norm(c) } })
      const hitNorm = aliasMap[aliasKey].map(norm).find(function(na) {
        return normedActual.some(function(ca) { return ca.norm === na })
      })
      if (hitNorm) {
        const match = normedActual.find(function(ca) { return ca.norm === hitNorm })
        if (match) return match.raw
      }
    }
    return null
  }

  // 检查某列是否有非空数据
  function colHasData(colName) {
    if (!colName) return false
    // rawRows 的 key 可能大小写不一致，构建查找函数
    const sample = rawRows.value[0]
    const realKey = Object.keys(sample).find(k => String(k).trim().toLowerCase() === colName)
    if (!realKey) return false
    return rawRows.value.some(r => {
      const v = r[realKey]
      return v !== null && v !== undefined && String(v).trim() !== ''
    })
  }

  return defs.map(f => {
    const colName = findActualCol(f)
    const linked = colName ? colHasData(colName) : false
    return { ...f, linked }
  })
  }
  // 无预览数据（上传成功后/页面刷新后）：使用持久化的关联状态
  const persisted = persistedFieldStatus.value[selectedDataset.value] || {}
  const hasPersisted = Object.keys(persisted).length > 0
  return defs.map(f => {
    const linked = hasPersisted ? !!persisted[f.name] : false
    return { ...f, linked }
  })
})

// 关联统计
const fieldLinkSummary = computed(() => {
  const list = fieldLinkStatus.value
  if (!list.length) return { total: 0, linked: 0, unlinked: 0 }
  const linked = list.filter(f => f.linked).length
  return { total: list.length, linked, unlinked: list.length - linked }
})

// ============ 上传配置 ============
const MAX_SIZE = 1024 * 1024 * 1024
const MAX_ROWS = 300000
const ACCEPT = '.xlsx,.xls,.csv,.tsv,.json,.txt'
const fileInput = ref(null)
const dragOver = ref(false)
const parsing = ref(false)
const uploading = ref(false)

// ============ 字段说明数据 ============
const fieldDefs = [
  { name: 'first_level_industry_name', cn: 'AMS一级开户行业ID(短id)', type: 'VARCHAR', required: true, desc: 'AMS一级开户行业ID' },
  { name: 'second_level_industry_name', cn: 'AMS二级开户行业ID(长id)', type: 'VARCHAR', required: true, desc: 'AMS二级开户行业ID' },
  { name: 'element_type', cn: '审核元素类型', type: 'VARCHAR', required: true, desc: '物料元素类型代码（image/video/text等）' },
  { name: 'element_type_name', cn: '审核元素类型/审核元素类型(翻译后)', type: 'VARCHAR', required: true, desc: '元素类型中文名（图片/视频/文本/音频等）' },
  { name: 'class_num', cn: '聚类类型', type: 'INT', required: false, desc: '聚类类型编号（数值）' },
  { name: 'class_id', cn: '聚类ID', type: 'VARCHAR', required: false, desc: '聚类簇ID（如c1表示聚类簇1，noise表示噪点）' },
  { name: 'policy_ids', cn: '审核标签ID', type: 'VARCHAR', required: true, desc: '机审命中策略标签ID列表，JSON数组格式如 [1001,1002]' },
  { name: 'ai_evaluate_policy_ids', cn: 'AI评测人审标签', type: 'VARCHAR', required: true, desc: '人审评测策略标签ID列表，JSON数组格式如 [1001]' },
  { name: 'element_value', cn: '审核元素值', type: 'TEXT', required: true, desc: '审核物料元素值（图片URL/视频URL/文本内容）' },
  { name: 'ocr_text', cn: 'OCR内容', type: 'TEXT', required: false, desc: '图片/视频OCR文字识别内容', names: ['ocr_text', 'ocr_test'] },
  { name: 'asr_text', cn: 'ASR内容', type: 'TEXT', required: false, desc: '视频/音频语音识别内容', names: ['asr_text', 'asr_test'] },
  { name: 'dc_id', cn: '创意ID(DCID)', type: 'VARCHAR', required: false, desc: '创意ID(DCID)' },
  { name: 'uid', cn: '广告主ID', type: 'VARCHAR', required: false, desc: '广告主ID' },
  { name: 'ops_advertiser_name', cn: '客户主体名称(OPS)', type: 'VARCHAR', required: false, desc: '客户主体名称(OPS)' },
  { name: 'agency_uid', cn: '代理商ID', type: 'VARCHAR', required: false, desc: '代理商ID' },
  { name: 'agency_name', cn: '代理商名称', type: 'VARCHAR', required: false, desc: '代理商名称' },
  { name: 'model_version', cn: '模型版本', type: 'VARCHAR', required: false, desc: '机审模型版本号' },
  { name: 'ai_evaluate_reviewer_name', cn: '审核人', type: 'VARCHAR', required: false, desc: '人审审核人员姓名' },
  { name: 'element_fingerprint', cn: '审核物理指纹（md5）', type: 'VARCHAR', required: false, desc: '审核物理指纹（md5）' },
  { name: 'arrive_time', cn: '到达时间', type: 'DATE', required: true, desc: '物料到达时间（YYYY-MM-DD）' },
  { name: 'ds', cn: '日期分区', type: 'VARCHAR', required: true, desc: '数据日期分区（YYYY-MM-DD）' },
]

// ============ AI评测分析表（策略_标签）字段说明 ============
const precisionFieldDefs = [
  // 核心标识字段
  { name: 'tag_id', cn: '标签ID', type: 'INT', required: true, desc: '策略标签ID' },
  { name: 'policy_name', cn: '审核标签名/审核标签ID(翻译后)', type: 'VARCHAR', required: false, desc: '策略标签名称（图表中标签ID括号内/下方显示的名称）', names: ['policy_name', 'tag_name'] },
  // 精度统计字段
  { name: 'total', cn: '样本总数', type: 'INT', required: true, desc: '该标签下的总样本数' },
  { name: 'fp', cn: '误杀数', type: 'INT', required: true, desc: '该标签下的误杀样本数' },
  { name: 'precision', cn: '精度(%)', type: 'DECIMAL', required: false, desc: '精度值（百分比，如95.0表示95%），不填则从 total/fp 自动计算' },
  { name: 'review_model_precision_prime', cn: '绝对精度', type: 'DECIMAL', required: false, desc: '绝对模型精确度（绝对精度）：与模型精度并列的独立字段，部分数据集单独提供，表示不依赖相对口径的绝对精度值' },
  { name: 'tp', cn: 'TP', type: 'INT', required: false, desc: '真阳性（True Positive）：预测为正且实际为正的数量' },
  { name: 'fp_conf', cn: 'FP', type: 'INT', required: false, desc: '假阳性（False Positive）：预测为正但实际为负的数量' },
  { name: 'tn', cn: 'TN', type: 'INT', required: false, desc: '真阴性（True Negative）：预测为负且实际为负的数量' },
  { name: 'fn', cn: 'FN', type: 'INT', required: false, desc: '假阴性（False Negative）：预测为负但实际为正的数量' },
  { name: 'sample_count', cn: '明细样本数', type: 'INT', required: false, desc: '有明细数据的样本数量（可选）' },
  // 行业维度
  { name: 'industry_l1', cn: 'AMS一级行业', type: 'VARCHAR', required: false, desc: 'AMS一级行业名称（开户行业）' },
  { name: 'industry_l2', cn: 'AMS二级行业', type: 'VARCHAR', required: false, desc: 'AMS二级行业名称（开户行业）' },
  // 元素类型
  { name: 'element_type', cn: '审核元素类型', type: 'VARCHAR', required: false, desc: '物料元素类型代码（image/video/text/audio等）' },
  { name: 'element_type_name', cn: '元素类型名称', type: 'VARCHAR', required: true, desc: '物料元素类型中文名（图片/视频/文本/音频等）' },
  // 时间信息
  { name: 'arrive_time', cn: '到达时间', type: 'DATE', required: false, desc: '物料到达时间（YYYY-MM-DD）' },
  { name: 'ds', cn: '日期分区', type: 'VARCHAR', required: false, desc: '数据日期分区（YYYY-MM-DD）' },
  // 模型与指纹
  { name: 'model_version', cn: '模型版本', type: 'VARCHAR', required: false, desc: '机审模型版本号' },
  { name: 'element_fingerprint', cn: '审核物理指纹（md5）', type: 'VARCHAR', required: false, desc: '审核物理指纹（md5），用于物料去重' },
  // 备注
  { name: 'fp_reason', cn: '误杀原因', type: 'VARCHAR', required: false, desc: '误杀原因说明' },
  { name: 'remark', cn: '备注', type: 'VARCHAR', required: false, desc: '备注说明' },
]

// 当前显示的字段说明（根据数据集类型切换）
const currentFieldDefs = computed(() => {
  return selectedDataset.value === 'tag-precision' ? precisionFieldDefs : fieldDefs
})

// ============ 导入历史 ============
const historyList = ref([])
const loadingHistory = ref(false)

// ============ 字段别名映射 ============
const COL_ALIAS = {
  id: ['标签id', '标签ID', 'tagid', 'tag_id', 'id', '标签编号', 'policy_id', 'policyid'],
  name: ['标签名', '标签名称', 'name', 'tagname', 'tag_name', '名称', 'policy_name', 'policyname'],
  machine: ['policy_ids', '审核标签ID', '审核标签id', '机审标签ID', '机审标签id', '机审标签', '机器标签', '机审', 'machine', '机审policy', 'policyids', '机审id'],
  human: ['ai_evaluate_policy_ids', 'AI评测人审标签', 'ai评测人审标签', '评测人审标签', '人审标签ID', '人审标签id', '人审标签', 'ai_evaluate_policy_id', '人审', 'human', '复审标签', 'ai_policy_ids', 'aipolicy', '人审id'],
  industryL1: ['first_level_industry_name', 'ams一级行业', '一级行业', 'industry_l1', 'industryl1', 'ams_l1', '一级行业(ams)', '行业一级', 'AMS一级开户行业ID(短id)', 'AMS一级开户行业ID（短id）', 'AMS一级行业名称(开户行业)', 'AMS一级行业名称（开户行业）', 'AMS一级行业名称', 'AMS一级行业', 'ams一级行业名称', 'ams一级行业名称(开户行业)'],
  industryL2: ['second_level_industry_name', 'ams二级行业', '二级行业', 'industry_l2', 'industryl2', 'ams_l2', '二级行业(ams)', '行业二级', 'AMS二级开户行业ID(长id)', 'AMS二级开户行业ID（长id）', 'AMS二级行业名称(开户行业)', 'AMS二级行业名称（开户行业）', 'AMS二级行业名称', 'AMS二级行业', 'ams二级行业名称', 'ams二级行业名称(开户行业)'],
  elementType: ['element_type', '审核元素类型', '素材类型', '物料类型', '内容类型', '类型', 'elementtype'],
  elementTypeName: ['element_type_name', '元素类型名称', '审核元素类型（翻译后）', '审核元素类型(翻译后)', '审核元素类型翻译后', 'elementtypename', '元素类型', '审核元素类型/审核元素类型(翻译后)'],
  classNum: ['class_num', '聚类类型', 'classnum', '聚类', '聚类编号', 'cluster'],
  classId: ['class_id', 'classid', '聚类ID', '聚类id', 'cluster_id', 'clusterid'],
  mediaUrl: ['element_value', '审核元素值', '元素值', '媒体链接', '素材链接', 'media_url', 'mediaurl', '素材url', 'url', '链接'],
  ocrContent: ['ocr_text', 'ocr_test', 'ocr内容', 'ocr', 'ocr_content', 'ocrcontent', 'ocrtext', 'ocrtest', '文字内容', '文本内容'],
  asrContent: ['asr_text', 'asr_test', 'ars_text', 'ars_test', 'asr内容', 'asr', 'asr_content', 'asrcontent', 'asrtext', 'asrtest', 'ars', 'arscontent', '语音内容', '音频内容'],
  advertiser: ['ops_advertiser_name', '广告主', 'advertiser', 'ad_name', '广告主名称', '客户主体名称', '客户主体名称(ops)', '客户主体名称(OPS)'],
  arriveTime: ['arrive_time', '到达时间', 'arrivetime', '入库时间', '时间', '评测时间', '数据时间', '统计时间', '采样时间', '审核时间'],
  ds: ['ds', '日期分区', '日期', 'date', '数据日期', '统计日期', 'partition_date', 'partitiondate', '分区日期', '业务日期'],
  dc_id: ['dc_id', '创意id', '创意ID', 'dcid', '创意编号', '创意ID(DCID)'],
  uid: ['uid', '广告主id', '广告主ID', '广告主编号', '广告主uid'],
  agency_uid: ['agency_uid', '代理商id', '代理商ID', '代理商编号', 'agencyuid'],
  agency_name: ['agency_name', '代理商名称', '代理商', 'agencyname'],
  modelVersion: ['model_version', '模型版本', '机审版本', '版本号', 'modelversion'],
  ai_evaluate_reviewer_name: ['ai_evaluate_reviewer_name', '审核人', '评测人', '人审人员', '审核人员'],
  elementFingerprint: ['element_fingerprint', '审核物理指纹', '物理指纹', '指纹', 'md5', '素材指纹', 'elementfingerprint', '审核物理指纹（md5）', '审核物理指纹(md5)'],
}

// ============ AI评测分析表（策略_标签）字段别名映射 ============
// 该数据集直接包含精度数据（total, fp, precision），无需从样本计算
const PRECISION_COL_ALIAS = {
  id: ['标签id', '标签ID', 'tagid', 'tag_id', 'id', '标签编号', 'policy_id', 'policyid', '策略id', '策略ID', '审核标', '审核标签id', '审核标签id(翻译后)', '审核标签id（翻译后）', '审核标签'],
  name: ['标签名', '标签名称', 'name', 'tagname', 'tag_name', '名称', 'policy_name', 'policyname', '策略名', '策略名称', '审核标签名', '审核标签id(翻译后)', '审核标签id（翻译后）'],
  total: ['样本数', '样本总数', 'total', '总数', '样本量', 'sample_count', 'samplecount', '样本数量', '审核元素数量', '元素数量', '总量', '样本总数量', 'count', 'num', '数量', '元素总数', '审核元素数'],
  fp: ['误杀数', '误杀', 'fp', '误报数', '误报', '误杀数量', 'falsenegative', 'fn', '模型打标量', '打标量', '误判数', '错杀数', '错判数', '误杀样本数', '误报样本数', 'false_positive', 'falsepositive', '假阳性数', '假正例数'],
  precision: ['精度', '准确率', 'precision', 'precision_val', '精确率', '准确度', '命中率', '正确率', '模型精度', '模型精度(%)', '模型精度（%）', '精度(%)', '精度（%）', '精度值', '精度(%) ', '精度 (%)'],
  // 绝对模型精确度（绝对精度）：与模型精度并列的独立字段，部分数据集会单独提供
  reviewModelPrecisionPrime: ['绝对模型精确度', '绝对模型精确度（%）', '绝对精度', 'review_model_precision_prime', 'review_model_precision', 'absolute_precision', 'absolute_model_precision', '绝对模型精度'],
  tp: ['tp', 'TP', '真阳性', '真正例', 'true_positive', 'truepositive'],
  fpConf: ['fp', 'FP', '假阳性', '假正例', 'false_positive', 'falsepositive'],
  tn: ['tn', 'TN', '真阴性', '真负例', 'true_negative', 'truenegative'],
  fn: ['fn', 'FN', '假阴性', '假负例', 'false_negative', 'falsenegative'],
  sampleCount: ['样本数', '样本量', 'sample_count', 'samplecount', '明细样本数', '明细数量'],
  industryL1: ['ams一级行业', '一级行业', 'industry_l1', 'industryl1', 'ams_l1', '一级行业(ams)', '行业一级', 'first_level_industry_name', 'AMS一级行业名称（开户行业）', 'AMS一级行业名称(开户行业)', 'AMS一级行业名称', 'AMS一级行业', 'ams一级行业名称', 'ams一级行业名称(开户行业)', 'AMS一级开户行业ID(短id)', 'AMS一级开户行业ID（短id）'],
  industryL2: ['ams二级行业', '二级行业', 'industry_l2', 'industryl2', 'ams_l2', '二级行业(ams)', '行业二级', 'second_level_industry_name', 'AMS二级行业名称（开户行业）', 'AMS二级行业名称(开户行业)', 'AMS二级行业名称', 'AMS二级行业', 'ams二级行业名称', 'ams二级行业名称(开户行业)', 'AMS二级开户行业ID(长id)', 'AMS二级开户行业ID（长id）'],
  elementType: ['element_type', '审核元素类型', '素材类型', '物料类型', '内容类型', '类型', 'elementtype'],
  elementTypeName: ['element_type_name', '元素类型名称', '审核元素类型（翻译后）', '审核元素类型(翻译后)', '审核元素类型翻译后', 'elementtypename', '元素类型'],
  arriveTime: ['到达时间', 'arrive_time', 'arrivetime', '入库时间', '时间', '评测时间', '数据时间', '统计时间', '采样时间', 'date', 'time', '审核时间'],
  ds: ['日期分区', 'ds', '日期', 'date', '数据日期', '统计日期', 'partition_date', 'partitiondate', '分区日期', '业务日期'],
  modelVersion: ['模型版本', 'model_version', 'modelversion', '版本号', '机审版本', 'version', '审核版本', '策略版本'],
  elementFingerprint: ['审核物理指纹', '物理指纹', 'element_fingerprint', 'elementfingerprint', '指纹', 'md5', '素材指纹'],
  fpReason: ['误杀原因', 'fp_reason', 'fpreason', '误杀理由', '误报原因', '失败原因'],
  remark: ['备注', 'remark', '说明', '备注说明'],
}

// 模糊关键词匹配兜底：当精确别名都不命中时，按关键词检测列名
const FUZZY_KEYWORDS = {
  machine: ['policy_ids', '机审', '审核标签', '机器标签', 'machine_tag', 'machine_label'],
  human: ['ai_evaluate', '人审', 'ai评测', '复审', 'human_tag', 'human_label', '评测人审'],
}

function pickCol(row, keys, fuzzyKey) {
  const lower = {}
  for (const k of Object.keys(row)) lower[String(k).trim().toLowerCase()] = row[k]
  // 第一轮：精确匹配别名
  for (const a of keys) { const v = lower[a.toLowerCase()]; if (v !== undefined && v !== '') return v }
  // 第二轮：模糊关键词兜底
  if (fuzzyKey && FUZZY_KEYWORDS[fuzzyKey]) {
    for (const colName of Object.keys(lower)) {
      const cn = colName.toLowerCase()
      for (const kw of FUZZY_KEYWORDS[fuzzyKey]) {
        if (cn.includes(kw.toLowerCase())) { const v = lower[colName]; if (v !== undefined && v !== '') return v }
      }
    }
  }
  return ''
}
function parseIdsLocal(s) {
  const ids = String(s).replace(/["'[\]\s]/g, '').split(/[,，、;；|]/).filter(Boolean).map(Number).filter(n => !Number.isNaN(n))
  return [...new Set(ids)].sort((a, b) => a - b)
}

// 将Excel序列号日期转换为 YYYY-MM-DD 格式
function formatArriveTime(val) {
  if (!val) return ''
  const s = String(val).trim()
  if (!s) return ''
  // 已经是日期格式，直接返回
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return s
  // Excel序列号（纯数字或带小数），转换为日期
  const num = Number(s)
  if (!isNaN(num) && num > 30000 && num < 100000) {
    // 25569 = 1970-01-01 的Excel序列号
    const ms = (num - 25569) * 86400 * 1000
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return s
}

function pickFile() { fileInput.value && fileInput.value.click() }
function onFileChange(e) {
  const f = e.target.files && e.target.files[0]
  if (f) handleFile(f)
  e.target.value = ''
}
function onDrop(e) {
  dragOver.value = false
  const f = e.dataTransfer?.files && e.dataTransfer.files[0]
  if (f) handleFile(f)
}

// 加载 Mock 数据：模拟上传流程，展示完整预览效果
async function loadMockData() {
  const dataset = selectedDataset.value
  let rows = [], fileName = ''

  // 生成最近 6 周的周一日期（ds 字段）和每周内若干天的 arrive_time
  function weekDates(weeksBack) {
    const dates = []
    const now = new Date()
    for (let w = weeksBack; w >= 0; w--) {
      const mon = new Date(now)
      mon.setDate(mon.getDate() - mon.getDay() - 7 * w + 1) // 该周周一
      const p = n => String(n).padStart(2, '0')
      const ds = `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`
      // 每周取 3 天：周一、周三、周五
      const days = [0, 2, 4].map(offset => {
        const d = new Date(mon)
        d.setDate(d.getDate() + offset)
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      })
      dates.push({ ds, days })
    }
    return dates
  }
  const weeks = weekDates(5) // 6 周数据（索引 0~5）

  if (dataset === 'tag-precision') {
    fileName = 'mock_策略标签精度数据.json'
    // 10 个标签基础模板
    const tagTemplates = [
      { id: 15021, name: '违规广告', industry1: '电商', industry2: '美妆个护', elType: '图片', baseFp: 60, baseTotal: 1200 },
      { id: 15022, name: '虚假宣传', industry1: '电商', industry2: '食品饮料', elType: '图片', baseFp: 102, baseTotal: 850 },
      { id: 15023, name: '诱导点击', industry1: '网服', industry2: '社交', elType: '图片', baseFp: 43, baseTotal: 620 },
      { id: 15024, name: '色情低俗', industry1: '网服', industry2: '视频', elType: '视频', baseFp: 25, baseTotal: 1800 },
      { id: 15025, name: '恶意软件', industry1: '网服', industry2: '工具', elType: '图片', baseFp: 5, baseTotal: 350 },
      { id: 15026, name: '侵权盗版', industry1: '文化', industry2: '影视', elType: '视频', baseFp: 33, baseTotal: 420 },
      { id: 15027, name: '赌博博彩', industry1: '网服', industry2: '游戏', elType: '图片', baseFp: 18, baseTotal: 2100 },
      { id: 15028, name: '医疗广告', industry1: '医疗', industry2: '药品', elType: '图片', baseFp: 88, baseTotal: 680 },
      { id: 15029, name: '金融理财', industry1: '金融', industry2: '借贷', elType: '图片', baseFp: 114, baseTotal: 950 },
      { id: 15030, name: '垃圾广告', industry1: '网服', industry2: '资讯', elType: '图片', baseFp: 210, baseTotal: 1500 },
    ]
    rows = []
    for (const wk of weeks) {
      for (const t of tagTemplates) {
        // 每周数据略有波动，模拟真实变化
        const jitter = 0.85 + Math.random() * 0.3 // 0.85~1.15
        const total = Math.round(t.baseTotal * jitter)
        const fp = Math.round(t.baseFp * jitter)
        const tp = total - fp
        const prec = Number(((tp / total) * 100).toFixed(1))
        rows.push({
          '标签ID': t.id, '标签名': t.name,
          '样本数': total, '误杀数': fp, '精度(%)': prec,
          'TP': tp, 'FP_CONF': Math.round(fp * 0.8),
          '明细样本数': total,
          '一级行业(ams)': t.industry1, '二级行业(ams)': t.industry2,
          '元素类型': t.elType, 'ds': wk.ds,
          'arrive_time': wk.days[0],
          '误杀原因': '', '备注': '',
        })
      }
    }
  } else {
    fileName = 'mock_AI评测明细数据.json'
    // 样本模板（6 条/标签基础模板），每周复制并设不同 arrive_time
    const sampleTemplates = [
      { policy_ids: '15021', ai_evaluate_policy_ids: '15021', first_level_industry_name: '电商', second_level_industry_name: '美妆个护', element_type: '图片', element_type_name: '图片', ocr_text: '限时特惠全场5折', asr_text: '', ops_advertiser_name: '美妆旗舰店' },
      { policy_ids: '15021', ai_evaluate_policy_ids: '', first_level_industry_name: '电商', second_level_industry_name: '美妆个护', element_type: '图片', element_type_name: '图片', ocr_text: '买一送一立即抢购', asr_text: '', ops_advertiser_name: '美妆旗舰店' },
      { policy_ids: '15022', ai_evaluate_policy_ids: '15022', first_level_industry_name: '电商', second_level_industry_name: '食品饮料', element_type: '图片', element_type_name: '图片', ocr_text: '纯天然无添加', asr_text: '', ops_advertiser_name: '健康食品' },
      { policy_ids: '15022', ai_evaluate_policy_ids: '', first_level_industry_name: '电商', second_level_industry_name: '食品饮料', element_type: '视频', element_type_name: '视频', ocr_text: '', asr_text: '这款产品真的很好用', ops_advertiser_name: '健康食品' },
      { policy_ids: '15023', ai_evaluate_policy_ids: '15023', first_level_industry_name: '网服', second_level_industry_name: '社交', element_type: '图片', element_type_name: '图片', ocr_text: '点击领取红包', asr_text: '', ops_advertiser_name: '社交App' },
      { policy_ids: '15023', ai_evaluate_policy_ids: '', first_level_industry_name: '网服', second_level_industry_name: '社交', element_type: '图片', element_type_name: '图片', ocr_text: '积分兑换好礼', asr_text: '', ops_advertiser_name: '娱乐平台' },
      { policy_ids: '15024', ai_evaluate_policy_ids: '15024', first_level_industry_name: '网服', second_level_industry_name: '视频', element_type: '视频', element_type_name: '视频', ocr_text: '', asr_text: '欢迎观看本期内容', ops_advertiser_name: '视频平台' },
      { policy_ids: '15024', ai_evaluate_policy_ids: '15024', first_level_industry_name: '网服', second_level_industry_name: '视频', element_type: '视频', element_type_name: '视频', ocr_text: '', asr_text: '点击下方链接了解更多', ops_advertiser_name: '视频平台' },
      { policy_ids: '15025', ai_evaluate_policy_ids: '15025', first_level_industry_name: '网服', second_level_industry_name: '工具', element_type: '图片', element_type_name: '图片', ocr_text: '安全防护已开启', asr_text: '', ops_advertiser_name: '安全软件' },
      { policy_ids: '15026', ai_evaluate_policy_ids: '15026', first_level_industry_name: '文化', second_level_industry_name: '影视', element_type: '视频', element_type_name: '视频', ocr_text: '', asr_text: '新剧上线预告', ops_advertiser_name: '影视平台' },
      { policy_ids: '15026', ai_evaluate_policy_ids: '', first_level_industry_name: '文化', second_level_industry_name: '影视', element_type: '视频', element_type_name: '视频', ocr_text: '', asr_text: '会员抢先观看', ops_advertiser_name: '影视平台' },
      { policy_ids: '15027', ai_evaluate_policy_ids: '15027', first_level_industry_name: '网服', second_level_industry_name: '游戏', element_type: '图片', element_type_name: '图片', ocr_text: '新版本上线', asr_text: '', ops_advertiser_name: '游戏平台' },
      { policy_ids: '15027', ai_evaluate_policy_ids: '', first_level_industry_name: '网服', second_level_industry_name: '游戏', element_type: '图片', element_type_name: '图片', ocr_text: '登录领取新手礼包', asr_text: '', ops_advertiser_name: '游戏平台' },
      { policy_ids: '15028', ai_evaluate_policy_ids: '15028', first_level_industry_name: '医疗', second_level_industry_name: '药品', element_type: '图片', element_type_name: '图片', ocr_text: '在线问诊咨询', asr_text: '', ops_advertiser_name: '健康平台' },
      { policy_ids: '15028', ai_evaluate_policy_ids: '', first_level_industry_name: '医疗', second_level_industry_name: '药品', element_type: '图片', element_type_name: '图片', ocr_text: '体检套餐预约', asr_text: '', ops_advertiser_name: '体检中心' },
      { policy_ids: '15029', ai_evaluate_policy_ids: '15029', first_level_industry_name: '金融', second_level_industry_name: '借贷', element_type: '图片', element_type_name: '图片', ocr_text: '稳健理财产品介绍', asr_text: '', ops_advertiser_name: '持牌金融机构' },
      { policy_ids: '15029', ai_evaluate_policy_ids: '', first_level_industry_name: '金融', second_level_industry_name: '借贷', element_type: '图片', element_type_name: '图片', ocr_text: '费率透明公开', asr_text: '', ops_advertiser_name: '持牌金融机构' },
      { policy_ids: '15030', ai_evaluate_policy_ids: '15030', first_level_industry_name: '网服', second_level_industry_name: '资讯', element_type: '图片', element_type_name: '图片', ocr_text: '行业观察周报', asr_text: '', ops_advertiser_name: '资讯平台' },
      { policy_ids: '15030', ai_evaluate_policy_ids: '', first_level_industry_name: '网服', second_level_industry_name: '资讯', element_type: '图片', element_type_name: '图片', ocr_text: '深度报道订阅', asr_text: '', ops_advertiser_name: '资讯平台' },
      { policy_ids: '15030', ai_evaluate_policy_ids: '15030', first_level_industry_name: '网服', second_level_industry_name: '资讯', element_type: '图片', element_type_name: '图片', ocr_text: '每日要闻推送', asr_text: '', ops_advertiser_name: '资讯平台' },
    ]
    const agencies = ['代理商A','代理商B','代理商C','代理商D','代理商E','代理商F','代理商G','代理商H','代理商I','代理商J']
    const reviewers = ['张三','李四','王五','赵六']
    rows = []
    let seqId = 1
    for (const wk of weeks) {
      for (const day of wk.days) {
        for (const tpl of sampleTemplates) {
          const idx = seqId++
          rows.push({
            ...tpl,
            element_value: `https://example.com/${tpl.element_type === '视频' ? 'vid' : 'img'}/${String(idx).padStart(4, '0')}.${tpl.element_type === '视频' ? 'mp4' : 'jpg'}`,
            arrive_time: day, ds: day,
            uid: String(100000 + (idx % 20)),
            agency_uid: `AG${String((idx % 10) + 1).padStart(3, '0')}`,
            agency_name: agencies[idx % agencies.length],
            dc_id: `DC${day.replace(/-/g, '')}${String(idx).padStart(3, '0')}`,
            class_num: `C${String((idx % 10) + 1).padStart(2, '0')}`,
            class_id: `c${(idx % 18) + 1}`,
            model_version: idx % 2 === 0 ? 'v3.2.1' : 'v3.2.2',
            ai_evaluate_reviewer_name: reviewers[idx % reviewers.length],
            element_fingerprint: `fp${idx.toString(16).padStart(12, '0')}`,
          })
        }
      }
    }
  }

  // 构造一个模拟的 File 对象，让 handleFile 走 JSON 解析路径
  const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' })
  const mockFile = new File([blob], fileName, { type: 'application/json' })
  await handleFile(mockFile)
}

async function handleFile(file) {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase()
  if (!ACCEPT.split(',').includes(ext)) { toast.warn(`不支持的文件格式：${ext}，请上传 ${ACCEPT}`); return }
if (file.size > MAX_SIZE) { toast.warn('文件超过 1GB 上限'); return }
  parsing.value = true
  try {
    let rows = []
    if (ext === '.json') {
      const arr = JSON.parse(await file.text())
      rows = Array.isArray(arr) ? arr : (arr.data || [])
    } else if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
      // CSV/TSV/TXT 文件需要处理编码问题：Excel 导出的 CSV 默认是 GBK 编码
      const buf = await file.arrayBuffer()
      const text = decodeBuffer(buf)
      rows = parseDelimitedText(text, ext)
    } else {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      rows = extractFirstNonEmptySheetRows(wb)
      if (!rows.length && wb.SheetNames.length) {
        const preview = []
        try {
          const firstWs = wb.Sheets[wb.SheetNames[0]]
          const grid = XLSX.utils.sheet_to_json(firstWs, { header: 1, defval: '', blankrows: false })
          grid.slice(0, 5).forEach((r, i) => preview.push(`第${i + 1}行: ${JSON.stringify((r || []).slice(0, 12))}`))
        } catch (_) { /* 取样失败不影响主提示 */ }
        console.warn('[上传] Excel 解析为空，文件前几行：', preview)
        toast.warn(
          `Excel 未解析到有效数据行（工作表：${wb.SheetNames.join('、')}）` +
          (preview.length ? `\n文件开头内容：\n${preview.join('\n')}` : '') +
          '\n请确认首行是列名、且下面有数据行',
          { duration: 12000 }
        )
        return
      }
    }
    if (!rows.length) { toast.warn('未解析到有效数据行'); return }
    if (rows.length > MAX_ROWS) { toast.warn(`数据 ${rows.length} 条，超过 ${MAX_ROWS.toLocaleString()} 条上限`); return }
    // 转换到达时间列的Excel序列号为日期格式（覆盖所有别名变体）
    if (rows.length) {
      const arriveAliases = ['到达时间', 'arrive_time', 'arrivetime', '入库时间', '时间', '评测时间', '数据时间', '统计时间', '采样时间', '审核时间']
      const arriveCol = Object.keys(rows[0]).find(k => {
        const lk = String(k).trim().toLowerCase()
        return arriveAliases.some(a => a.toLowerCase() === lk)
      })
      if (arriveCol) {
        rows.forEach(r => { if (r[arriveCol] != null && r[arriveCol] !== '') r[arriveCol] = formatArriveTime(r[arriveCol]) })
      }
    }
    // 根据数据集类型选择不同解析逻辑
    if (selectedDataset.value === 'tag-precision') {
      await aggregatePrecisionRows(rows, file.name)
    } else {
      // AI评测明细：记录原始文件，若文件过大则改走后端直传合并（前端不再展开巨量对象，根治 OOM）
      pendingFile.value = file
      if (rows.length > DIRECT_UPLOAD_THRESHOLD) {
        rawRows.value = []
        _sampleList = []
        previewTags.value = []
        Object.assign(previewMeta, { total: rows.length, hit: 0, fpCount: 0, tagCount: 0, fileName: file.name, precision: 0, fpRate: 0 })
        toast.success(`文件较大（${rows.length.toLocaleString()} 行），将直传后端合并，无需等待前端解析`)
      } else {
        await aggregateRows(rows, file.name)
      }
    }
  } catch (err) {
    const msg = err.message || ''
    toast.error('文件解析失败：' + (msg || '格式不正确') + '。请确认文件为有效的分隔符文本（CSV/TSV/TXT），表头列名与数据行对齐')
  } finally {
    parsing.value = false
  }
}

// 编码检测：自动识别 UTF-8 或 GBK 编码
// Excel 在 Windows 上导出的 CSV 默认使用 GBK(GB2312) 编码，
// 直接用 UTF-8 解码会导致中文列名变成乱码
function decodeBuffer(buf) {
  const bytes = new Uint8Array(buf)
  // 检查 UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  // 检查 UTF-16 LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  // 先尝试 UTF-8 解码
  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  // 如果没有出现替换字符（U+FFFD），说明是合法 UTF-8
  if (!utf8Text.includes('\uFFFD')) return utf8Text
  // UTF-8 解码出现乱码，回退到 GBK 解码
  try {
    const gbkText = new TextDecoder('gbk').decode(bytes)
    if (!gbkText.includes('\uFFFD')) return gbkText
    // GBK 也失败，尝试 GB18030（GB18030 是 GBK 的超集，兼容性更好）
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch {
      return gbkText
    }
  } catch {
    // TextDecoder 不支持 gbk，返回 UTF-8 结果
    return utf8Text
  }
}

// Excel 可能把真实数据放在非首个工作表（首个 sheet 常为封面/说明，解析为空表 → 误报"未解析到有效数据行"）
// 这里自动遍历所有工作表，取第一个含有效数据行的 sheet
function extractFirstNonEmptySheetRows(wb) {
  if (!wb || !wb.SheetNames || !wb.SheetNames.length) return []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    // 先取二维数组，自动跳过顶部标题行/空行，避免"首行是大标题"导致解析 0 行
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false })
    const probe = pickHeaderRow(grid)
    if (!probe) continue
    const rows = XLSX.utils.sheet_to_json(ws, {
      defval: '',
      header: probe.header,
      range: probe.headerIndex,
    })
    if (Array.isArray(rows) && rows.length) return rows
  }
  return []
}

// 自动探测真正的表头行：跳过文件顶部的标题行/说明行/空行
function pickHeaderRow(grid) {
  if (!Array.isArray(grid) || !grid.length) return null
  const nonEmptyCount = (arr) => (Array.isArray(arr) ? arr.filter(v => v !== '' && v != null).length : 0)
  let best = null
  const limit = Math.min(grid.length, 30)
  for (let i = 0; i < limit; i++) {
    const vals = grid[i]
    const n = nonEmptyCount(vals)
    if (n < 2) continue
    const hasData = grid.slice(i + 1).some(r => nonEmptyCount(r) >= 2)
    if (!hasData) continue
    if (!best || n > best.count) best = { headerIndex: i, count: n, header: (vals || []).map(v => (v == null ? '' : String(v).trim())) }
  }
  return best
}

// 健壮的分隔符文本解析器（CSV/TSV/TXT 通用）
// 正确处理：①引号包裹字段 ②引号内转义的双引号("") ③字段内逗号/分隔符 ④字段内换行
// ⑤以第一行出现频率最高的候选符自动推断分隔符（逗号/制表符/分号/竖线）
function parseDelimitedText(text, ext) {
  if (!text || !text.length) return []
  const lines = splitLines(text)
  if (!lines.length) return []

  // 候选分隔符优先级：TSV 优先制表符，其余按出现频率推断
  const candidates = ext === '.tsv' ? ['\t', ',', ';', '|'] : [',', '\t', ';', '|']
  const delimiter = detectDelimiter(lines.slice(0, Math.min(20, lines.length)), candidates)

  const header = parseLine(lines[0], delimiter).map(h => (h || '').trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim().length) continue // 跳过空行
    const cells = parseLine(raw, delimiter)
    const obj = {}
    header.forEach((h, idx) => {
      let v = cells[idx] != null ? cells[idx] : ''
      // 去掉整字段两端的引号并还原转义双引号
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
        v = v.slice(1, -1).replace(/""/g, '"')
      }
      obj[h] = v
    })
    rows.push(obj)
  }
  return rows
}

// 按 \r\n 或 \n 切分，丢弃纯 \r
function splitLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

// 推断分隔符：统计每个候选符在采样行中的出现次数，取最大值
function detectDelimiter(sampleLines, candidates) {
  const counts = candidates.map(sep => {
    let c = 0
    for (const line of sampleLines) {
      // 仅统计引号外的分隔符，避免字段内逗号干扰推断
      c += countOutsideQuotes(line, sep)
    }
    return { sep, c }
  })
  counts.sort((a, b) => b.c - a.c)
  return counts[0] && counts[0].c > 0 ? counts[0].sep : candidates[0]
}

function countOutsideQuotes(line, sep) {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // 双引号转义（""）不切换引号状态
      if (inQuotes && line[i + 1] === '"') { i++; continue }
      inQuotes = !inQuotes
    } else if (ch === sep && !inQuotes) {
      count++
    }
  }
  return count
}

// 逐字符解析单行，支持字段内换行（被引号包裹且内部换行视为同一字段）
function parseLine(line, delimiter) {
  const fields = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue } // 转义双引号
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && ch === delimiter) {
      fields.push(cur); cur = ''
      continue
    }
    cur += ch
  }
  fields.push(cur)
  return fields
}

// 本地聚合预览
let _sampleList = []
async function aggregateRows(rows, fileName) {
  const groups = new Map()
  _sampleList = []
  let total = 0, hit = 0, sampleSeq = 0
  const tagOrder = []  // 记录标签首次出现顺序，用于分配序号
  for (const r of rows) {
    const m = parseIdsLocal(pickCol(r, COL_ALIAS.machine, 'machine'))
    const h = parseIdsLocal(pickCol(r, COL_ALIAS.human, 'human'))
    if (!m.length && !h.length) continue
    const name = String(pickCol(r, COL_ALIAS.name) || '').trim()
    const type = String(pickCol(r, COL_ALIAS.elementType) || '未知').trim()
    const industryL1 = String(pickCol(r, COL_ALIAS.industryL1) || '未知').trim()
    const industryL2 = String(pickCol(r, COL_ALIAS.industryL2) || '未知').trim()
    const mediaUrl = String(pickCol(r, COL_ALIAS.mediaUrl) || '').trim()
    const ocrContent = String(pickCol(r, COL_ALIAS.ocrContent) || '').trim()
    const asrContent = String(pickCol(r, COL_ALIAS.asrContent) || '').trim()
    const classNum = String(pickCol(r, COL_ALIAS.classNum) || '').trim()
    const classId = String(pickCol(r, COL_ALIAS.classId) || '').trim()
    const advertiser = String(pickCol(r, COL_ALIAS.advertiser) || '').trim()
    // 新增3个字段：创意ID/客户主体名称(OPS)/审核人，从xlsx解析后随sample传给后端
    const dcId = String(pickCol(r, COL_ALIAS.dc_id) || '').trim()
    const opsAdvertiserName = String(pickCol(r, COL_ALIAS.advertiser) || '').trim() || advertiser
    const reviewerName = String(pickCol(r, COL_ALIAS.ai_evaluate_reviewer_name) || '').trim()
    // 审核物理指纹（md5）：随 sample 传给后端写 real_data_samples.element_fingerprint
    const elementFingerprint = String(pickCol(r, COL_ALIAS.elementFingerprint) || '').trim()
    // arrive_time：按 Excel 实际值解析，缺失则留空（不再兜底当前日期，避免污染 MAX(arrive_time) 口径）
    let arriveTime = String(pickCol(r, COL_ALIAS.arriveTime) || '').trim()
    arriveTime = arriveTime ? formatArriveTime(arriveTime) : ''
    let ds = String(pickCol(r, COL_ALIAS.ds) || '').trim()
    if (!ds) {
      ds = arriveTime.replace(/[/]/g, '-').slice(0, 10)
    }
    const mStr = m.join(',')
    const hStr = h.join(',')

    // 仅遍历机审标签：机审打了此标签但人审没打 → FP（误杀）
    const tagIds = m
    for (const tagId of tagIds) {
      const ok = h.includes(tagId)
      total++; if (ok) hit++
      const g = groups.get(tagId) || { id: tagId, name, total: 0, hit: 0 }
      g.total++; if (ok) g.hit++
      if (name && !g.name) g.name = name
      groups.set(tagId, g)

      // 为标签分配序号（首次出现时分配，1-based）
      let tagSeq = tagOrder.indexOf(tagId)
      if (tagSeq === -1) { tagOrder.push(tagId); tagSeq = tagOrder.length }
      else tagSeq += 1  // indexOf 返回 0-based 索引，+1 转为 1-based 序号

      _sampleList.push({
        id: `RL${tagSeq}-${tagId}-${sampleSeq++}`,
        tagId, tagName: name, type, isVideo: type === '视频',
        machineTag: mStr, humanTag: hStr,
        industryL1, industryL2, mediaUrl, ocrContent, asrContent,
        classNum, classId,
        advertiser, dcId, opsAdvertiserName, reviewerName,
        elementFingerprint,
        arriveTime, ds,
        isFp: !ok, fpReason: '', remark: '',
      })
    }
  }
  if (!total) {
    const actualCols = rows.length ? Object.keys(rows[0]).join(', ') : ''
    toast.warn(`未识别到审核标签ID/AI评测人审标签列，请检查列名。文件实际列名：${actualCols}`)
    return
  }
  const list = [...groups.values()].map(g => ({
    id: g.id, name: g.name, total: g.total, fp: g.total - g.hit,
    precision: Number((g.hit / g.total * 100).toFixed(1)), remark: '', fpReason: '',
  })).sort((a, b) => (b.precision - a.precision) || (a.fp - b.fp))
    .map((t, i) => ({ ...t, rank: i + 1 }))

  previewTags.value = list
  rawRows.value = rows
  Object.assign(previewMeta, {
    total: rows.length, hit, fpCount: total - hit,
    tagCount: list.length, fileName,
    precision: Number((hit / total * 100).toFixed(1)),
    fpRate: Number(((total - hit) / total * 100).toFixed(1)),
  })
  toast.success(`已解析「${fileName}」· 共 ${rows.length} 条样本，${list.length} 个标签`)
}

// ============ AI评测分析表（策略_标签）解析逻辑 ============
// 该数据集直接包含精度数据（total, fp, precision），无需从样本计算
function pickPrecisionCol(row, keys) {
  const lower = {}
  for (const k of Object.keys(row)) lower[String(k).trim().toLowerCase()] = row[k]
  // 第一轮：精确匹配别名
  for (const a of keys) {
    const v = lower[a.toLowerCase()]
    if (v !== undefined && v !== '') return v
  }
  // 第二轮：包含式模糊兜底。为规避"审核标签ID环比对比值"等衍生列，
  // 在所有包含别名子串的列中，取列名最短的那个（最贴近原始字段）。
  const cols = Object.keys(lower)
  let best = null, bestLen = Infinity
  for (const a of keys) {
    const al = a.toLowerCase()
    for (const c of cols) {
      if (c.includes(al) && lower[c] !== undefined && lower[c] !== '' && c.length < bestLen) {
        best = c; bestLen = c.length
      }
    }
  }
  return best !== null ? lower[best] : ''
}

function parseNum(v) {
  const s = String(v).replace(/[%\s,，]/g, '').trim()
  const n = Number(s)
  return Number.isNaN(n) ? 0 : n
}

async function aggregatePrecisionRows(rows, fileName) {
  const list = []
  let totalSamples = 0, totalFp = 0, totalPrecision = 0, tagCount = 0

  for (const r of rows) {
    const id = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.id))
    if (!id) continue
    const name = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.name) || '').trim()
    let total = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.total))
    let fp = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.fp))
    let tp = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.tp))
    const fpConf = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.fpConf))
    const tn = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.tn))
    const fn = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.fn))
    // 优先使用文件中自带的精度值，若没有则从 TP/(TP+FP) 计算
    let precision = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.precision))

    // === 字段兜底逻辑：当文件未提供某些列时，通过其他字段反推，避免全为0/空 ===
    // 1) tp 兜底：若 tp 为0但有 total 和 fp，则 tp = total - fp
    if (!tp && total > 0 && fp >= 0) {
      tp = Math.max(0, total - fp)
    }
    // 2) precision 兜底：从 TP/(TP+FP) 计算
    if (!precision) {
      const denom = tp + fp
      if (denom > 0) precision = Number((tp / denom * 100).toFixed(1))
    }
    // 3) fp 兜底：若 fp 为0但有 precision 和 total，从精度反推
    if (!fp && precision > 0 && total > 0) {
      fp = Math.round(total * (1 - precision / 100))
      // 反推后重新校正 tp
      tp = Math.max(0, total - fp)
    }
    // 4) total 兜底：若 total 为0但有 tp 和 fp，则 total = tp + fp
    if (!total && (tp > 0 || fp > 0)) {
      total = tp + fp
    }
    // 5) precision 最终兜底：若仍为0但 total > 0，从 tp/total 计算
    if (!precision && total > 0) {
      precision = Number((tp / total * 100).toFixed(1))
    }

    let fpFinal = fp

    const sampleCount = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.sampleCount))
    const industryL1 = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.industryL1) || '').trim()
    const industryL2 = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.industryL2) || '').trim()
    const elementType = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.elementType) || '').trim()
    const elementTypeName = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.elementTypeName) || '').trim()
    // arrive_time：按 Excel 实际值解析，缺失则留空（不再兜底当前日期，避免污染 MAX(arrive_time) 口径）
    let arriveTime = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.arriveTime) || '').trim()
    arriveTime = arriveTime ? formatArriveTime(arriveTime) : ''
    let ds = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.ds) || '').trim()
    if (!ds) {
      // ds 默认从 arriveTime 提取日期部分（YYYY-MM-DD）
      ds = arriveTime.replace(/[/]/g, '-').slice(0, 10)
    }
    const modelVersion = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.modelVersion) || '').trim()
    const elementFingerprint = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.elementFingerprint) || '').trim()
    const fpReason = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.fpReason) || '').trim()
    const remark = String(pickPrecisionCol(r, PRECISION_COL_ALIAS.remark) || '').trim()
    // 绝对模型精确度（绝对精度）：与模型精度并列的独立字段，缺失则为空（不强制兜底）
    const reviewModelPrecisionPrime = parseNum(pickPrecisionCol(r, PRECISION_COL_ALIAS.reviewModelPrecisionPrime))

    totalSamples += total
    totalFp += fpFinal
    tagCount++

    list.push({
      id, name, total, fp: fpFinal, precision,
      tp, fpConf, tn, fn,
      sampleCount, industryL1, industryL2, elementType,
      elementTypeName, arriveTime, ds, modelVersion, elementFingerprint,
      fpReason, remark, reviewModelPrecisionPrime,
    })
  }

  if (!list.length) {
    const actualCols = rows.length ? Object.keys(rows[0]).join(', ') : ''
    // 即使解析失败，也设置 rawRows 以便字段关联面板能显示检测结果
    rawRows.value = rows
    toast.warn(`未识别到标签ID列，请检查列名。文件实际列名：${actualCols}`)
    return
  }

  // 按精度降序排列
  const sorted = list.sort((a, b) => (b.precision - a.precision) || (a.fp - b.fp))
    .map((t, i) => ({ ...t, rank: i + 1 }))

  previewTags.value = sorted
  rawRows.value = rows
  const tpTotal = totalSamples - totalFp
  const overallPrecision = (tpTotal + totalFp) > 0 ? Number((tpTotal / (tpTotal + totalFp) * 100).toFixed(1)) : 0
  Object.assign(previewMeta, {
    total: totalSamples, hit: totalSamples - totalFp, fpCount: totalFp,
    tagCount: list.length, fileName,
    precision: overallPrecision,
    fpRate: Number((totalFp / totalSamples * 100).toFixed(1)),
  })
  toast.success(`已解析「${fileName}」· 共 ${list.length} 个标签，${totalSamples} 条样本，精度数据直接可用`)
}



// 导入结果（成功/失败持久展示，替代仅靠 toast 一闪而过）
const importResult = ref(null) // { ok, tagCount, sampleCount, fileName, message, time }

// 分批上传进度
const uploadProgress = reactive({ active: false, phase: '', done: 0, total: 0, percent: 0 })
const BATCH_SIZE = 2000 // 每批发送 2000 条样本，与后端 SQL 批次对齐，降低单批内存压力

// 原始文件引用：AI评测明细数据集在确认导入时直传后端解析合并（根治前端 OOM）
const pendingFile = ref(null)
// 直传模式阈值：文件超过该估算行数时，跳过前端聚合，直接走后端直传合并
const DIRECT_UPLOAD_THRESHOLD = 50000
// 后端直传解析诊断（列名/跳过行数等），用于定位「0/0」问题
const importDiag = ref(null)

// 确认导入（分批上传，解决 413 请求体过大问题）
async function confirmImport() {
  if (!hasPreview.value) return
  uploading.value = true
  importResult.value = null
  importDiag.value = null
  const snapshotTagCount = previewTags.value.length
  const snapshotSampleCount = previewMeta.total
  const snapshotFileName = previewMeta.fileName
  const isPrecision = selectedDataset.value === 'tag-precision'
  let uploadId = null

  // 策略标签数据集：直接上传精度数据（单次提交，数据量小）
  if (isPrecision) {
    try {
      Object.assign(uploadProgress, { active: true, phase: '上传精度数据…', done: 0, total: snapshotTagCount, percent: 0 })
      const resp = await dataMetaApi.uploadPrecision({
        tags: previewTags.value,
        fileName: snapshotFileName,
      })
      uploadProgress.percent = 100
      await loadMetaAndDraft()
      importResult.value = {
        ok: true, tagCount: snapshotTagCount, sampleCount: resp.sampleCount || 0,
        fileName: snapshotFileName, message: '草稿已保存，请发布后生效',
        time: new Date().toLocaleString(),
      }
      // 持久化字段关联状态（按数据集存储）
      const statusMap = {}
      fieldLinkStatus.value.forEach(f => { statusMap[f.name] = f.linked })
      persistedFieldStatus.value['tag-precision'] = statusMap
      try { await dataMetaApi.saveFieldStatus({ fieldStatus: statusMap, dataset: 'tag-precision' }) } catch { /* 非关键路径 */ }
      previewTags.value = []
      rawRows.value = []
      _sampleList = []
      Object.assign(previewMeta, { total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
      toast.success('策略标签精度数据导入成功')
      loadHistory()
    } catch (e) {
      importResult.value = {
        ok: false, tagCount: snapshotTagCount, sampleCount: snapshotSampleCount,
        fileName: snapshotFileName, message: e.message || '未知错误',
        time: new Date().toLocaleString(),
      }
      toast.error('上传失败：' + (e.message || '未知错误'))
    } finally {
      uploading.value = false
      Object.assign(uploadProgress, { active: false, phase: '', done: 0, total: 0, percent: 0 })
    }
    return
  }

  // AI评测明细数据：优先后端直传合并（根治前端 OOM）；仅当无原始文件（理论上不会）才走分批
  Object.assign(uploadProgress, { active: true, phase: '合并上传', done: 0, total: snapshotSampleCount, percent: 0 })

  try {
    // 后端直传合并：文件流直接发往服务端解析+与正式表合并（增量追加，旧数据保留，重复行跳过）
    if (pendingFile.value) {
      uploadProgress.phase = '上传文件中（后端合并）…'
      const resp = await dataMetaApi.uploadFile(pendingFile.value, {
        dataset: 'ai-eval',
        fileName: snapshotFileName,
        onProgress: (p) => { uploadProgress.percent = p; uploadProgress.done = Math.round(snapshotSampleCount * p / 100) },
      })
      uploadProgress.percent = 100
      await loadMetaAndDraft()
      importResult.value = {
        ok: true, tagCount: resp.newTagCount || 0, sampleCount: resp.insertedSamples || 0,
        fileName: snapshotFileName,
        message: `合并完成：新增 ${resp.insertedSamples || 0} 条，跳过重复 ${resp.skippedSamples || 0} 条，旧数据已保留`,
        time: new Date().toLocaleString(),
      }
      // 后端诊断仅在失败时展示，成功即清理
      if (resp.diag && resp.diag.skippedNoTag) importDiag.value = resp.diag
      else importDiag.value = null
      // 清空预览与原始文件引用
      previewTags.value = []
      rawRows.value = []
      _sampleList = []
      pendingFile.value = null
      Object.assign(previewMeta, { total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
      toast.success(`合并上传成功：新增 ${resp.insertedSamples || 0} 条样本，旧数据已保留`)
      loadHistory()
      return
    }

    // 兜底：无原始文件时仍走分批（兼容历史逻辑）
    uploadProgress.phase = '写入标签数据…'
    const initResp = await dataMetaApi.uploadInit({
      tags: previewTags.value,
      fileName: snapshotFileName,
      meta: { total: previewMeta.total, hit: previewMeta.hit, fpCount: previewMeta.fpCount },
    })
    uploadId = initResp.uploadId

    // 步骤2：分批发送样本
    uploadProgress.phase = '上传样本数据…'
    for (let i = 0; i < _sampleList.length; i += BATCH_SIZE) {
      const batch = _sampleList.slice(i, i + BATCH_SIZE)
      await dataMetaApi.uploadBatch({ uploadId, samples: batch })
      uploadProgress.done = Math.min(i + batch.length, snapshotSampleCount)
      uploadProgress.percent = Math.round(uploadProgress.done / snapshotSampleCount * 100)
    }

    // 步骤3：提交事务
    uploadProgress.phase = '提交事务…'
    uploadProgress.percent = 100
    const finalResp = await dataMetaApi.uploadFinalize({ uploadId })
    uploadId = null // 已提交，无需 abort

    await loadMetaAndDraft()
    importResult.value = {
      ok: true, tagCount: snapshotTagCount, sampleCount: finalResp.sampleCount || snapshotSampleCount,
      fileName: snapshotFileName, message: '草稿已保存，请发布后生效',
      time: new Date().toLocaleString(),
    }
    // 清空预览前，先持久化字段关联状态（供页面刷新后恢复）
    const statusMap = {}
    fieldLinkStatus.value.forEach(f => { statusMap[f.name] = f.linked })
    persistedFieldStatus.value['ai-eval'] = statusMap
    try { await dataMetaApi.saveFieldStatus({ fieldStatus: statusMap, dataset: 'ai-eval' }) } catch { /* 非关键路径，静默失败 */ }
    // 清空预览（成功后清空，失败时保留以便重试）
    previewTags.value = []
    rawRows.value = []
    _sampleList = []
    Object.assign(previewMeta, { total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
    toast.success('数据导入成功，所有账号已同步')
    // 刷新历史
    loadHistory()
  } catch (e) {
    // 主动回滚未完成的会话
    if (uploadId) { try { await dataMetaApi.uploadAbort({ uploadId }) } catch {} }
    const diag = e && e.diag ? e.diag : null
    let detailMsg = e.message || '未知错误'
    if (diag) {
      const cols = Array.isArray(diag.columns) ? diag.columns : []
      detailMsg += `\n\n解析行数：${diag.parsedRows ?? 0}`
      if (diag.machineCol || diag.humanCol) {
        detailMsg += `\n识别到的列：机审=${diag.machineCol || '未识别'}，人审=${diag.humanCol || '未识别'}`
      }
      if (diag.skippedNoTag) detailMsg += `\n因标签为空跳过：${diag.skippedNoTag} 行`
      if (cols.length) detailMsg += `\n文件表头：${cols.join(' | ')}`
    }
    importResult.value = {
      ok: false, tagCount: snapshotTagCount, sampleCount: snapshotSampleCount,
      fileName: snapshotFileName, message: detailMsg,
      time: new Date().toLocaleString(),
    }
    if (diag) importDiag.value = diag
    toast.error('数据上传后端失败：' + (e.message || '未知错误'))
  } finally {
    uploading.value = false
    Object.assign(uploadProgress, { active: false, phase: '', done: 0, total: 0, percent: 0 })
  }
}

function cancelPreview() {
  previewTags.value = []
  rawRows.value = []
  _sampleList = []
  Object.assign(previewMeta, { total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
}

// 下载模板
function downloadTemplate() {
  const hasData = rawRows.value.length > 0
  if (selectedDataset.value === 'tag-precision') {
    if (hasData) {
      // 有预览数据时，根据上传文件的列名动态生成模板
      const cols = rawCols.value
      // 取前几行作为示例数据
      const sampleRows = rawRows.value.slice(0, 5)
      const ws = XLSX.utils.json_to_sheet(sampleRows)
      // 自动调整列宽
      const colWidths = cols.map(c => ({
        wch: Math.max(String(c).length * 2, 12)
      }))
      ws['!cols'] = colWidths
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '策略标签精度模板')
      XLSX.writeFile(wb, '策略标签精度模板.xlsx')
      toast.success(`已根据上传数据生成模板（${cols.length} 列，${sampleRows.length} 行示例）`)
    } else {
      const tmpl = [{
        '标签ID': 15021, '标签名': '违规广告', '样本数': 1200, '误杀数': 60, '精度(%)': 95.0,
        '明细样本数': 1200, '一级行业(ams)': '电商', '二级行业(ams)': '美妆个护', '元素类型': '图片',
        '误杀原因': '', '备注': '',
      }]
      const ws = XLSX.utils.json_to_sheet(tmpl)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '策略标签精度模板')
      XLSX.writeFile(wb, '策略标签精度模板.xlsx')
    }
  } else {
    if (hasData) {
      // 有预览数据时，根据上传文件的列名动态生成模板
      const cols = rawCols.value
      const sampleRows = rawRows.value.slice(0, 5)
      const ws = XLSX.utils.json_to_sheet(sampleRows)
      const colWidths = cols.map(c => ({
        wch: Math.max(String(c).length * 2, 12)
      }))
      ws['!cols'] = colWidths
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '评测数据模板')
      XLSX.writeFile(wb, '评测数据模板.xlsx')
      toast.success(`已根据上传数据生成模板（${cols.length} 列，${sampleRows.length} 行示例）`)
    } else {
      const tmpl = [{
        'policy_ids': '[14776]', 'ai_evaluate_policy_ids': '[]',
        'first_level_industry_name': '网服', 'second_level_industry_name': '社交', 'element_type': '图片',
        'element_type_name': '图片', 'class_num': 1,
        'element_value': 'https://example.com/img.jpg', 'ocr_text': '示例文字', 'asr_text': '',
        'ops_advertiser_name': '示例广告主', 'arrive_time': '2026-06-01', 'ds': '2026-06-01',
      }]
      const ws = XLSX.utils.json_to_sheet(tmpl)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '评测数据模板')
      XLSX.writeFile(wb, '评测数据模板.xlsx')
    }
  }
}

// 加载导入历史
async function loadHistory() {
  loadingHistory.value = true
  try {
    const data = await dataMetaApi.history()
    historyList.value = Array.isArray(data) ? data : []
  } catch (e) {
    historyList.value = []
  } finally {
    loadingHistory.value = false
  }
}

// 加载数据元信息（两个数据集独立加载）
onMounted(async () => {
  await loadMetaAndDraft()
  // 加载两个数据集的持久化字段关联状态
  try {
    const [fsAi, fsTp] = await Promise.all([
      dataMetaApi.getFieldStatus('ai-eval').catch(() => ({ fieldStatus: {} })),
      dataMetaApi.getFieldStatus('tag-precision').catch(() => ({ fieldStatus: {} })),
    ])
    if (fsAi && fsAi.fieldStatus) persistedFieldStatus.value['ai-eval'] = fsAi.fieldStatus
    if (fsTp && fsTp.fieldStatus) persistedFieldStatus.value['tag-precision'] = fsTp.fieldStatus
  } catch { /* 静默失败 */ }
})

async function loadMetaAndDraft() {
  try {
    const meta = await dataMetaApi.get().catch(() => null)
    if (meta) {
      // 兼容旧格式（单对象）和新格式（{ aiEval, tagPrecision, cluster, sediment }）
        if (meta.aiEval || meta.tagPrecision) {
          datasetMeta.value['ai-eval'] = meta.aiEval || { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
          datasetMeta.value['tag-precision'] = meta.tagPrecision || { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
        } else if (meta.updatedAt) {
        datasetMeta.value['ai-eval'] = { ...meta, isDraft: false, draftCount: 0 }
      }
    }
  } catch { /* 静默失败 */ }
}

// 删除数据确认弹窗
const showDeleteConfirm = ref(false)
const deleting = ref(false)
// 删除选择：'all' | 'ai-eval' | 'tag-precision'
const deleteType = ref('all')

const deleteOptions = [
  { id: 'all', label: '全部数据', desc: '清空所有已上传数据' },
  { id: 'ai-eval', label: '仅 AI评测明细数据', desc: '清空标签聚合 + 样本明细' },
  { id: 'tag-precision', label: '仅 AI评测分析表（策略_标签）', desc: '清空标签精度数据' },
]

const deleteTypeLabel = computed(() => {
  const opt = deleteOptions.find(o => o.id === deleteType.value)
  return opt ? opt.label : '全部数据'
})

async function handleDeleteData() {
  deleting.value = true
  try {
    await dataMetaApi.deleteData(deleteType.value)
    // 按删除类型清除对应数据集的本地状态
    if (deleteType.value === 'all' || deleteType.value === 'ai-eval') {
      // 明细数据被删除，清空预览和 store
      previewTags.value = []
      rawRows.value = []
      _sampleList = []
      Object.assign(previewMeta, { total: 0, hit: 0, fpCount: 0, tagCount: 0, fileName: '', precision: 0, fpRate: 0 })
      importResult.value = null
      // 清空 analysisStore，确保分析页不再显示旧数据
      analysisStore.clear()
      datasetMeta.value['ai-eval'] = { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
      persistedFieldStatus.value['ai-eval'] = {}
    }
    if (deleteType.value === 'all' || deleteType.value === 'tag-precision') {
      analysisStore.clear()
      datasetMeta.value['tag-precision'] = { updatedAt: '', updatedBy: '', fileName: '', isDraft: false, draftCount: 0 }
      persistedFieldStatus.value['tag-precision'] = {}
    }
    await loadMetaAndDraft()
    showDeleteConfirm.value = false
    toast.success(`${deleteTypeLabel.value}已清空`)
    loadHistory()
  } catch (e) {
    toast.error('删除失败：' + (e.message || '未知错误'))
  } finally {
    deleting.value = false
  }
}

// 低标签/高标签
const lowTagCount = computed(() => previewTags.value.filter(t => tagStatus(t.precision).cls === 'red').length)
const highTagCount = computed(() => previewTags.value.filter(t => tagStatus(t.precision).cls === 'green').length)

// 各数据集是否已上传数据（用于卡片状态标识）
const aiEvalReady = computed(() => !!(datasetMeta.value['ai-eval']?.updatedAt))
const tagPrecisionReady = computed(() => !!(datasetMeta.value['tag-precision']?.updatedAt))
const anyDataReady = computed(() => aiEvalReady.value || tagPrecisionReady.value)

// 根据数据集id获取就绪状态
function datasetReady(id) {
  if (id === 'ai-eval') return aiEvalReady.value
  if (id === 'tag-precision') return tagPrecisionReady.value
  return false
}

// 是否有数据已发布（草稿表机制已下线，发布仅登记版本快照，可回滚）
const hasAnyDraft = computed(() => aiEvalReady.value || tagPrecisionReady.value)

// 发布/回滚状态
const publishing = ref(false)
const rollingBack = ref(false)
const showPublishConfirm = ref(false)
const showRollbackConfirm = ref(false)

async function handlePublish() {
  publishing.value = true
  try {
    const res = await dataMetaApi.publish()
    await loadMetaAndDraft()
    toast.success(res.message || '已登记发布版本')
    showPublishConfirm.value = false
  } catch (e) {
    toast.error('发布失败：' + (e.message || '未知错误'))
  } finally {
    publishing.value = false
  }
}

async function handleRollback() {
  rollingBack.value = true
  try {
    const res = await dataMetaApi.rollback()
    await loadMetaAndDraft()
    toast.success(res.message || '已回滚到上一版')
    showRollbackConfirm.value = false
    analysisStore.clear()
  } catch (e) {
    toast.error('回滚失败：' + (e.message || '未知错误'))
  } finally {
    rollingBack.value = false
  }
}

// 切换到历史标签时自动加载
function onTabChange(key) {
  if (key === 'history' && !historyList.value.length) loadHistory()
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="database" :size="22" />数据管理</h1>
      <p class="page-sub">管理 AI 评测数据导入 · 查看字段说明 · 查询导入历史</p>
    </div>

    <!-- 数据状态卡片（两个数据集独立展示） -->
    <div class="status-cards">
      <!-- AI评测明细数据 -->
      <div class="status-card" :class="{ ready: aiEvalReady }">
        <div class="sc-left">
          <span class="sc-icon"><Icon :name="aiEvalReady ? 'checkCircle' : 'database'" :size="24" /></span>
          <div class="sc-info">
            <div class="sc-title-row">
              <strong>AI评测明细数据</strong>
              <span class="sc-status-dot" :class="aiEvalReady ? 'dot-on' : 'dot-off'"></span>
              <span class="sc-status-text" :class="aiEvalReady ? 'text-on' : 'text-off'">{{ aiEvalReady ? '已发布' : '未上传' }}</span>
            </div>
            <em v-if="aiEvalReady">
              文件：{{ datasetMeta['ai-eval']?.fileName || '—' }} · 上传人：{{ datasetMeta['ai-eval']?.updatedBy || '—' }} · 更新时间：{{ datasetMeta['ai-eval']?.updatedAt || '—' }}
            </em>
            <em v-else>请上传评测数据文件</em>
          </div>
        </div>
      </div>

      <!-- AI评测分析表（策略_标签） -->
      <div class="status-card" :class="{ ready: tagPrecisionReady }">
        <div class="sc-left">
          <span class="sc-icon"><Icon :name="tagPrecisionReady ? 'checkCircle' : 'database'" :size="24" /></span>
          <div class="sc-info">
            <div class="sc-title-row">
              <strong>AI评测分析表（策略_标签）</strong>
              <span class="sc-status-dot" :class="tagPrecisionReady ? 'dot-on' : 'dot-off'"></span>
              <span class="sc-status-text" :class="tagPrecisionReady ? 'text-on' : 'text-off'">{{ tagPrecisionReady ? '已发布' : '未上传' }}</span>
            </div>
            <em v-if="tagPrecisionReady">
              文件：{{ datasetMeta['tag-precision']?.fileName || '—' }} · 上传人：{{ datasetMeta['tag-precision']?.updatedBy || '—' }} · 更新时间：{{ datasetMeta['tag-precision']?.updatedAt || '—' }}
            </em>
            <em v-else>请上传策略标签精度数据</em>
          </div>
        </div>
      </div>

      <div class="sc-actions">
        <button v-if="hasAnyDraft" class="btn btn-primary btn-sm" :disabled="publishing" @click="showPublishConfirm = true">
          <Icon name="send" :size="15" />{{ publishing ? '发布中…' : '发布' }}
        </button>
        <button v-if="anyDataReady" class="btn btn-warning-outline btn-sm" :disabled="rollingBack" @click="showRollbackConfirm = true">
          <Icon name="back" :size="15" />{{ rollingBack ? '回滚中…' : '回滚上一版' }}
        </button>
        <button v-if="anyDataReady" class="btn btn-danger-outline btn-sm" @click="showDeleteConfirm = true">
          <Icon name="trash" :size="15" />删除数据
        </button>
      </div>
    </div>

    <!-- 数据集选择器（卡片式，带上传状态标识） -->
    <div class="dataset-cards">
      <div v-for="ds in datasets" :key="ds.id"
        class="ds-card" :class="{
          active: selectedDataset === ds.id,
          ready: datasetReady(ds.id),
        }"
        @click="selectedDataset = ds.id">
        <div class="dsc-header">
          <span class="dsc-icon"><Icon name="database" :size="18" /></span>
          <span class="dsc-name">{{ ds.name }}</span>
        </div>
        <div class="dsc-status">
          <span class="dsc-dot" :class="datasetReady(ds.id) ? 'dot-on' : 'dot-off'"></span>
          <span class="dsc-status-text" :class="datasetReady(ds.id) ? 'text-on' : 'text-off'">
            {{ datasetReady(ds.id) ? '已上传' : '未上传' }}
          </span>
        </div>
      </div>
    </div>

    <!-- 标签页 -->
    <div class="tabs-bar">
      <button v-for="t in tabs" :key="t.key"
        class="tab-btn" :class="{ active: activeTab === t.key }"
        @click="activeTab = t.key; onTabChange(t.key)">
        <Icon :name="t.icon" :size="16" />
        <span>{{ t.label }}</span>
      </button>
    </div>

    <!-- ===== 上传文件标签页 ===== -->
    <div v-show="activeTab === 'upload'" class="tab-panel">
      <input ref="fileInput" type="file" :accept="ACCEPT" hidden @change="onFileChange" />

      <!-- 导入结果持久展示（成功/失败），避免只依赖 toast 一闪而过 -->
      <div v-if="importResult" class="import-result" :class="{ ok: importResult.ok, fail: !importResult.ok }">
        <Icon :name="importResult.ok ? 'checkCircle' : 'alert'" :size="20" />
        <div class="ir-body">
          <div class="ir-title">{{ importResult.ok ? '导入成功' : '导入失败' }} · {{ importResult.fileName }}</div>
          <div class="ir-detail">
            标签 {{ importResult.tagCount }} 个 · 样本 {{ importResult.sampleCount.toLocaleString() }} 条 · {{ importResult.time }}
            <template v-if="!importResult.ok">· 原因：{{ importResult.message }}</template>
          </div>

          <!-- 后端解析诊断：直传模式下「0/0」时展示真实列名与跳过行数 -->
          <div v-if="importDiag" class="ir-diag">
            <div class="diag-title">后端解析诊断</div>
            <div class="diag-grid">
              <span>解析行数</span><b>{{ importDiag.parsedRows ?? 0 }}</b>
              <span>因标签为空跳过</span><b class="warn">{{ importDiag.skippedNoTag ?? 0 }} 行</b>
              <span>机审标签列</span><b :class="importDiag.machineCol ? 'ok-text' : 'warn'">{{ importDiag.machineCol || '未识别' }}</b>
              <span>人审标签列</span><b :class="importDiag.humanCol ? 'ok-text' : 'warn'">{{ importDiag.humanCol || '未识别' }}</b>
              <span>工作表</span><b>{{ importDiag.sheetName || '-' }}</b>
            </div>
            <div v-if="importDiag.firstSkippedRow" class="diag-sample">
              首个被跳过行样例：机审列「{{ importDiag.firstSkippedRow.machineCol || '无' }}」值 =
              <code>{{ importDiag.firstSkippedRow.machineVal || '空' }}</code>
              ；人审列「{{ importDiag.firstSkippedRow.humanCol || '无' }}」值 =
              <code>{{ importDiag.firstSkippedRow.humanVal || '空' }}</code>
            </div>
            <div v-if="importDiag.columns && importDiag.columns.length" class="diag-cols">
              <div class="diag-cols-title">文件实际表头（{{ importDiag.columns.length }} 列）</div>
              <div class="diag-cols-body">{{ importDiag.columns.join(' | ') }}</div>
            </div>
          </div>
        </div>
        <button class="ir-close" @click="importResult = null"><Icon name="close" :size="14" /></button>
        <button v-if="!importResult.ok && hasPreview" class="ir-retry" @click="confirmImport">
          <Icon name="refresh" :size="15" />重新导入
        </button>
      </div>

      <!-- 拖拽上传区 -->
      <div v-if="!hasPreview" class="upload-zone" :class="{ drag: dragOver }"
           @click="pickFile" @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop.prevent="onDrop">
        <div class="uz-icon"><Icon name="upload" :size="40" /></div>
        <h3>{{ parsing ? '解析中…' : '点击或拖拽文件上传' }}</h3>
<p>支持 Excel(.xlsx/.xls)、CSV、TSV、JSON、TXT 格式，文件 ≤ 1GB，行数 ≤ 30 万</p>
        <div class="uz-actions">
          <button class="btn btn-primary" :disabled="parsing" @click.stop="pickFile">
            <Icon name="upload" :size="16" />{{ parsing ? '解析中…' : '选择文件' }}
          </button>
          <button class="btn btn-ghost" @click.stop="downloadTemplate">
            <Icon name="doc" :size="16" />下载模板
          </button>
          <button class="btn btn-primary-outline" :disabled="parsing" @click.stop="loadMockData">
            <Icon name="sparkle" :size="16" />{{ parsing ? '解析中…' : 'Mock 数据' }}
          </button>
        </div>
      </div>

      <!-- 解析预览 -->
      <template v-if="hasPreview">
        <!-- 预览概览条 -->
        <div class="preview-summary">
          <div class="ps-info">
            <span class="ps-file"><Icon name="doc" :size="16" />{{ previewMeta.fileName }}</span>
            <span class="ps-stat">样本 {{ previewMeta.total.toLocaleString() }} 条</span>
            <span class="ps-stat">标签 {{ previewMeta.tagCount }} 个</span>
          </div>
          <div class="ps-actions">
            <button class="btn btn-ghost btn-sm" @click="cancelPreview"><Icon name="back" :size="15" />取消</button>
            <button class="btn btn-primary btn-sm" :disabled="uploading" @click="confirmImport">
              <Icon name="checkCircle" :size="15" />{{ uploading ? '导入中…' : '确认导入' }}
            </button>
          </div>
        </div>

        <!-- 分批上传进度条 -->
        <div v-if="uploadProgress.active" class="upload-progress">
          <div class="up-header">
            <span class="up-icon"><Icon name="upload" :size="16" /></span>
            <span class="up-phase">{{ uploadProgress.phase }}</span>
            <span class="up-count">{{ uploadProgress.done.toLocaleString() }} / {{ uploadProgress.total.toLocaleString() }}</span>
            <span class="up-percent">{{ uploadProgress.percent }}%</span>
          </div>
          <div class="up-bar">
            <i :style="{ width: uploadProgress.percent + '%' }"></i>
          </div>
        </div>

        <!-- 字段关联状态面板 -->
        <div v-if="currentFieldDefs.length" class="card rise" style="padding: 20px 24px; margin-bottom: 16px;">
          <div class="fls-header">
            <h3 class="sec-title"><Icon name="link" :size="16" />字段关联状态</h3>
            <span class="fls-summary">
              <span class="fls-pill fls-ok">{{ fieldLinkSummary.linked }} 已关联</span>
              <span class="fls-pill fls-no">{{ fieldLinkSummary.unlinked }} 未关联</span>
              <span class="fls-pill fls-total">共 {{ fieldLinkSummary.total }} 字段</span>
            </span>
          </div>
          <div class="fls-grid">
            <div v-for="f in fieldLinkStatus" :key="f.name" class="fls-item" :class="f.linked ? 'linked' : 'unlinked'">
              <span class="fls-dot" :class="f.linked ? 'dot-on' : 'dot-off'"></span>
              <span class="fls-name"><code>{{ f.name }}</code></span>
              <span class="fls-cn">{{ f.cn }}</span>
              <span class="fls-badge" :class="f.linked ? 'badge-on' : 'badge-off'">
                <Icon :name="f.linked ? 'check' : 'close'" :size="12" />{{ f.linked ? '已关联' : '未关联' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 原始数据预览（展示文件原数据，不展示聚合结果） -->
        <div class="card rise" style="padding: 20px 24px;">
          <h3 class="sec-title"><Icon name="doc" :size="16" />文件数据预览（共 {{ rawRows.length }} 行）</h3>
          <div class="raw-table-wrap">
            <div class="raw-table">
              <div class="rt-head">
                <span class="rt-idx">#</span>
                <span v-for="col in rawCols" :key="col" class="rt-col">{{ col }}</span>
              </div>
              <div v-for="(row, i) in rawRows.slice(0, 100)" :key="i" class="rt-row">
                <span class="rt-idx">{{ i + 1 }}</span>
                <span v-for="col in rawCols" :key="col" class="rt-col" :title="String(row[col] ?? '')">{{ String(row[col] ?? '') }}</span>
              </div>
            </div>
          </div>
          <p v-if="rawRows.length > 100" class="pt-more">仅展示前 100 行，共 {{ rawRows.length }} 行</p>
        </div>
      </template>

    </div>

    <!-- ===== 字段说明标签页 ===== -->
    <div v-show="activeTab === 'fields'" class="tab-panel">
      <div class="card rise" style="padding: 24px;">
        <div class="fields-header">
          <h3 class="sec-title"><Icon name="doc" :size="16" />{{ selectedDataset === 'tag-precision' ? 'AI评测分析表（策略_标签）' : 'AI评测明细数据' }} · 字段说明</h3>
          <span class="fields-count">共 {{ currentFieldDefs.length }} 个字段</span>
        </div>
        <div class="fields-table">
          <div class="ft-head">
            <span class="ft-idx">#</span>
            <span class="ft-name">字段名称</span>
            <span class="ft-cn">中文名</span>
            <span class="ft-type">类型</span>
            <span class="ft-req">必填</span>
            <span class="ft-link">关联状态</span>
            <span class="ft-desc">说明</span>
          </div>
          <div v-for="(f, i) in currentFieldDefs" :key="f.name" class="ft-row">
            <span class="ft-idx">{{ i + 1 }}</span>
            <span class="ft-name">
              <template v-if="f.names && f.names.length">
                <template v-for="(nm, ni) in f.names" :key="nm"><code>{{ nm }}</code><span v-if="ni < f.names.length - 1" class="ft-name-sep"> / </span></template>
              </template>
              <code v-else>{{ f.name }}</code>
            </span>
            <span class="ft-cn">{{ f.cn }}</span>
            <span class="ft-type"><span class="type-tag" :class="f.type === 'INT' ? 't-int' : f.type === 'DECIMAL' ? 't-int' : f.type === 'DATE' ? 't-date' : 't-str'">{{ f.type }}</span></span>
            <span class="ft-req">
              <span v-if="f.required" class="req-yes">是</span>
              <span v-else class="req-no">否</span>
            </span>
            <span class="ft-link">
              <span v-if="!rawRows.length && !Object.keys(persistedFieldStatus[selectedDataset] || {}).length" class="link-na">—</span>
              <span v-else-if="fieldLinkStatus.find(x => x.name === f.name)?.linked" class="link-yes">
                <Icon name="check" :size="12" />已关联
              </span>
              <span v-else class="link-no">
                <Icon name="close" :size="12" />未关联
              </span>
            </span>
            <span class="ft-desc">{{ f.desc }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 导入历史标签页 ===== -->
    <div v-show="activeTab === 'history'" class="tab-panel">
      <div class="card rise" style="padding: 24px;">
        <div class="history-header">
          <h3 class="sec-title"><Icon name="clock" :size="16" />导入历史记录</h3>
          <button class="btn btn-ghost btn-sm" @click="loadHistory" :disabled="loadingHistory">
            <Icon name="refresh" :size="15" />{{ loadingHistory ? '加载中…' : '刷新' }}
          </button>
        </div>

        <div v-if="loadingHistory && !historyList.length" class="history-empty">
          <Icon name="clock" :size="40" />
          <p>加载中…</p>
        </div>

        <div v-else-if="!historyList.length" class="history-empty">
          <Icon name="doc" :size="40" />
          <p>暂无导入记录</p>
        </div>

        <div v-else class="history-table">
          <div class="ht-head">
            <span class="ht-idx">#</span>
            <span class="ht-file">文件名</span>
            <span class="ht-dataset">数据集</span>
            <span class="ht-samples">样本数</span>
            <span class="ht-tags">标签数</span>
            <span class="ht-status">状态</span>
            <span class="ht-by">导入人</span>
            <span class="ht-time">导入时间</span>
          </div>
          <div v-for="(h, i) in historyList" :key="h.id" class="ht-row">
            <span class="ht-idx">{{ i + 1 }}</span>
            <span class="ht-file"><Icon name="doc" :size="14" />{{ h.fileName || '—' }}</span>
            <span class="ht-dataset">{{ h.datasetName || '—' }}</span>
            <span class="ht-samples">{{ h.sampleCount?.toLocaleString() || 0 }}</span>
            <span class="ht-tags">{{ h.tagCount || 0 }}</span>
            <span class="ht-status">
              <span class="badge" :class="h.status === 'success' ? 'badge-green' : 'badge-red'">{{ h.status === 'success' ? '成功' : '失败' }}</span>
              <span v-if="h.status !== 'success' && h.errorMessage" class="ht-err">· {{ h.errorMessage }}</span>
            </span>
            <span class="ht-by">{{ h.importedBy || '—' }}</span>
            <span class="ht-time">{{ h.importedAt || '—' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 删除数据确认弹窗 ===== -->
    <Teleport to="body">
      <div v-if="showDeleteConfirm" class="modal-overlay" @click.self="showDeleteConfirm = false">
        <div class="modal-card delete-modal">
          <div class="modal-header">
            <h3><Icon name="alert" :size="18" />删除已上传数据</h3>
            <button class="modal-close" @click="showDeleteConfirm = false"><Icon name="close" :size="16" /></button>
          </div>
          <div class="modal-body">
            <div class="delete-warn-icon"><Icon name="trash" :size="36" /></div>
            <p class="delete-warn-title">请选择要删除的数据集</p>
            <p class="delete-warn-desc">此操作不可恢复，请谨慎选择。</p>

            <!-- 数据集选择 -->
            <div class="delete-type-list">
              <label v-for="opt in deleteOptions" :key="opt.id"
                class="delete-type-item" :class="{ active: deleteType === opt.id }"
                @click="deleteType = opt.id">
                <span class="dti-radio">
                  <span v-if="deleteType === opt.id" class="dti-dot"></span>
                </span>
                <span class="dti-body">
                  <span class="dti-label">{{ opt.label }}</span>
                  <span class="dti-desc">{{ opt.desc }}</span>
                </span>
              </label>
            </div>

            <p class="delete-warn-hint">删除后不可恢复，请谨慎操作。</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="showDeleteConfirm = false" :disabled="deleting">取消</button>
            <button class="btn btn-danger" :disabled="deleting" @click="handleDeleteData">
              <Icon name="trash" :size="16" />{{ deleting ? '删除中…' : `确认删除${deleteType === 'all' ? '' : '所选'}` }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== 发布确认弹窗 ===== -->
    <Teleport to="body">
      <div v-if="showPublishConfirm" class="modal-overlay" @click.self="showPublishConfirm = false">
        <div class="modal-card">
          <div class="modal-header">
          <h3><Icon name="send" :size="18" />发布数据</h3>
            <button class="modal-close" @click="showPublishConfirm = false"><Icon name="close" :size="16" /></button>
          </div>
          <div class="modal-body">
            <p>发布后将执行以下操作：</p>
            <ul class="publish-desc">
              <li>备份当前线上数据到历史版本</li>
              <li>登记本次发布版本快照</li>
            </ul>
            <p class="delete-warn-hint">发布后可通过「回滚上一版」恢复到该版本，是否确认？</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="showPublishConfirm = false" :disabled="publishing">取消</button>
            <button class="btn btn-primary" :disabled="publishing" @click="handlePublish">
              <Icon name="send" :size="16" />{{ publishing ? '发布中…' : '确认发布' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== 回滚确认弹窗 ===== -->
    <Teleport to="body">
      <div v-if="showRollbackConfirm" class="modal-overlay" @click.self="showRollbackConfirm = false">
        <div class="modal-card">
          <div class="modal-header">
            <h3><Icon name="back" :size="18" />回滚到上一版</h3>
            <button class="modal-close" @click="showRollbackConfirm = false"><Icon name="close" :size="16" /></button>
          </div>
          <div class="modal-body">
            <p>回滚将把数据恢复到上一次发布前的版本。</p>
            <p class="delete-warn-hint">当前数据会先被备份，仍可再次回滚，是否确认？</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="showRollbackConfirm = false" :disabled="rollingBack">取消</button>
            <button class="btn btn-warning" :disabled="rollingBack" @click="handleRollback">
              <Icon name="back" :size="16" />{{ rollingBack ? '回滚中…' : '确认回滚' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }

/* 数据状态卡片（双卡片布局） */
.status-cards { display: flex; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; align-items: stretch; }
.status-card { flex: 1; min-width: 280px; display: flex; align-items: center; justify-content: space-between; padding: 18px 22px; background: #fff; border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: 0 2px 12px rgba(20,30,60,.05); transition: all .2s; }
.status-card.ready { border-color: #bbf7d0; background: linear-gradient(135deg, #f0fdf4, #fff); }
.sc-left { display: flex; align-items: center; gap: 14px; }
.sc-icon { width: 48px; height: 48px; border-radius: 12px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; flex-shrink: 0; }
.status-card.ready .sc-icon { background: #dcfce7; color: #16a34a; }
.sc-info { display: flex; flex-direction: column; gap: 4px; }
.sc-title-row { display: flex; align-items: center; gap: 8px; }
.sc-title-row strong { font-size: 15px; font-weight: 700; color: var(--text-1); }
.sc-info em { font-size: 12.5px; font-style: normal; color: var(--text-3); }
.sc-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sc-status-text { font-size: 12px; font-weight: 600; }
.text-on { color: #16a34a; }
.text-off { color: #9ca3af; }
.dot-on { background: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.15); }
.dot-off { background: #d1d5db; }
.sc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status-card.draft { border-color: #fed7aa; background: linear-gradient(135deg, #fff7ed, #fff); }
.status-card.draft .sc-icon { background: #ffedd5; color: #ea580c; }
.publish-desc { margin: 12px 0; padding-left: 18px; color: var(--text-2); font-size: 13.5px; line-height: 1.8; }

/* 数据集选择器（卡片式） */
.dataset-cards { display: flex; gap: 12px; margin-bottom: 18px; }
.ds-card { flex: 1; padding: 16px 20px; background: #fff; border: 2px solid var(--border-strong); border-radius: 14px; cursor: pointer; transition: all .2s; display: flex; flex-direction: column; gap: 10px; }
.ds-card:hover { border-color: var(--brand); background: var(--brand-soft); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(20,30,60,.06); }
.ds-card.active { border-color: var(--brand); background: linear-gradient(135deg, var(--brand-soft), #fff); box-shadow: 0 4px 16px rgba(var(--brand-rgb), .12); }
.ds-card.ready { border-left: 4px solid #16a34a; }
.ds-card.active.ready { border-left: 4px solid var(--brand); }
.dsc-header { display: flex; align-items: center; gap: 8px; }
.dsc-icon { width: 36px; height: 36px; border-radius: 10px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; }
.ds-card.active .dsc-icon { background: var(--brand); color: #fff; }
.dsc-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
.dsc-status { display: flex; align-items: center; gap: 6px; padding-left: 44px; }

/* 标签页 */
.tabs-bar { display: flex; gap: 4px; margin-bottom: 20px; padding: 4px; background: #fff; border: 1px solid var(--border-strong); border-radius: 12px; }
.tab-btn { display: flex; align-items: center; gap: 7px; padding: 10px 20px; border: none; background: transparent; font-size: 14px; font-weight: 500; color: var(--text-3); border-radius: 8px; cursor: pointer; transition: all .2s; }
.tab-btn:hover { background: var(--bg-soft); color: var(--text-1); }
.tab-btn.active { background: var(--brand); color: #fff; box-shadow: 0 2px 8px rgba(var(--brand-rgb), .3); }
.tab-btn.active svg { color: #fff; }

/* 上传区 */
.upload-zone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 56px 40px; border: 2px dashed var(--border-strong); border-radius: 18px; background: #fff; cursor: pointer; transition: all .2s; text-align: center; }
.upload-zone:hover, .upload-zone.drag { border-color: var(--brand); background: var(--brand-soft); }
.uz-icon { width: 80px; height: 80px; border-radius: 20px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; margin-bottom: 6px; }
.upload-zone:hover .uz-icon, .upload-zone.drag .uz-icon { transform: scale(1.05); transition: transform .2s; }
.upload-zone h3 { font-size: 18px; font-weight: 600; color: var(--text-1); }
.upload-zone p { font-size: 13px; color: var(--text-3); max-width: 420px; }
.uz-actions { display: flex; gap: 12px; margin-top: 10px; }

/* 导入结果持久展示卡片 */
.import-result { display: flex; align-items: flex-start; gap: 12px; padding: 14px 18px; border-radius: 12px; margin-bottom: 16px; border: 1px solid; }
.import-result.ok { background: #f0fdf4; border-color: #bbf7d0; color: #15803d; }
.import-result.fail { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.ir-body { flex: 1; min-width: 0; }
.ir-title { font-size: 14px; font-weight: 700; }
.ir-detail { font-size: 12.5px; opacity: .85; margin-top: 3px; word-break: break-all; }
.ir-close { flex-shrink: 0; background: transparent; border: none; cursor: pointer; color: inherit; opacity: .6; padding: 2px; border-radius: 6px; display: grid; place-items: center; }
.ir-close:hover { opacity: 1; background: rgba(0,0,0,.06); }
.ir-retry { flex-shrink: 0; display: flex; align-items: center; gap: 5px; padding: 7px 16px; border-radius: 9px; border: none; background: #ef4444; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; box-shadow: 0 2px 8px rgba(239,68,68,.3); }
.ir-retry:hover { background: #dc2626; transform: translateY(-1px); }
.ir-retry:disabled { opacity: .5; cursor: not-allowed; transform: none; }

/* 后端解析诊断面板（直传 0/0 定位用） */
.ir-diag { margin-top: 10px; padding: 10px 12px; border-radius: 9px; background: rgba(255,255,255,.75); border: 1px dashed currentColor; font-size: 12px; line-height: 1.6; }
.diag-title { font-weight: 700; font-size: 12.5px; margin-bottom: 6px; letter-spacing: .3px; }
.diag-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; align-items: center; }
.diag-grid > span { opacity: .7; }
.diag-grid > b { font-weight: 700; word-break: break-all; }
.diag-grid > b.warn { color: #d97706; }
.diag-grid > b.ok-text { color: #15803d; }
.diag-sample { margin-top: 7px; opacity: .9; word-break: break-all; }
.diag-sample code { background: rgba(0,0,0,.08); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
.diag-cols { margin-top: 8px; }
.diag-cols-title { font-weight: 600; opacity: .8; margin-bottom: 3px; }
.diag-cols-body { max-height: 88px; overflow: auto; word-break: break-all; opacity: .85; background: rgba(0,0,0,.05); padding: 6px 8px; border-radius: 6px; font-size: 11.5px; }

/* 预览概览条 */
.preview-summary { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; background: linear-gradient(135deg, #eef2ff, #f0fdf4); border: 1px solid #d6e0ff; border-radius: 14px; margin-bottom: 18px; flex-wrap: wrap; gap: 14px; }
.ps-info { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ps-file { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; color: var(--text-1); }
.ps-stat { font-size: 13px; color: var(--text-3); padding: 4px 12px; background: rgba(255,255,255,.7); border-radius: 8px; }
.ps-fp { color: var(--orange); font-weight: 600; }
.ps-actions { display: flex; gap: 10px; }

/* 分批上传进度条 */
.upload-progress { margin-bottom: 18px; padding: 18px 24px; background: #fff; border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: 0 2px 12px rgba(20,30,60,.05); }
.up-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.up-icon { width: 32px; height: 32px; border-radius: 8px; background: var(--brand-soft); color: var(--brand); display: grid; place-items: center; }
.up-phase { font-size: 14px; font-weight: 600; color: var(--text-1); flex: 1; }
.up-count { font-size: 13px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.up-percent { font-size: 15px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.up-bar { height: 8px; background: #eef1f6; border-radius: 6px; overflow: hidden; }
.up-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--brand), #6366f1); border-radius: 6px; transition: width .3s ease; }

/* 原始数据预览表格 */
.sec-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 6px; }
.raw-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; }
.raw-table { display: flex; flex-direction: column; min-width: max-content; }
.rt-head, .rt-row { display: flex; }
.rt-head { background: var(--bg-soft); border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--text-3); position: sticky; top: 0; z-index: 1; }
.rt-row { border-bottom: 1px solid var(--border); transition: background .12s; font-size: 12px; }
.rt-row:last-child { border-bottom: none; }
.rt-row:hover { background: #f8faff; }
.rt-idx { flex: 0 0 44px; min-width: 44px; padding: 8px 6px; text-align: center; color: var(--text-4); font-weight: 600; }
.rt-col { flex: 1 1 150px; min-width: 120px; max-width: 280px; padding: 8px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 1px solid var(--border); }
.rt-head .rt-col { white-space: nowrap; overflow: visible; }
.pt-more { text-align: center; padding: 16px 0; font-size: 13px; color: var(--text-4); }

/* 字段说明表格 */
.fields-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.fields-count { font-size: 13px; color: var(--text-3); padding: 4px 12px; background: var(--bg-soft); border-radius: 8px; }
.fields-table { display: flex; flex-direction: column; }
.ft-head, .ft-row { display: grid; grid-template-columns: 0.4fr 2fr 1.2fr 0.8fr 0.6fr 1fr 2.5fr; align-items: center; }
.ft-head { padding: 12px 8px; background: var(--bg-soft); border-radius: 10px; font-size: 13px; font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
.ft-head > span { text-align: center; }
.ft-head .ft-desc { text-align: left; }
.ft-row { padding: 11px 8px; border-bottom: 1px solid var(--border); transition: background .15s; }
.ft-row:hover { background: var(--bg-soft); }
.ft-row > span { display: flex; align-items: center; justify-content: center; font-size: 13px; }
.ft-row .ft-desc { justify-content: flex-start; text-align: left; color: var(--text-3); }
.ft-idx { font-weight: 600; color: var(--text-4); }
.ft-name code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--brand); background: var(--brand-soft); padding: 3px 8px; border-radius: 5px; }
.ft-cn { font-weight: 600; color: var(--text-1); }
.type-tag { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 5px; }
.t-int { background: #dbeafe; color: #2563eb; }
.t-str { background: #f3e8ff; color: #9333ea; }
.t-date { background: #fef3c7; color: #d97706; }
.req-yes { color: #f0454b; font-weight: 600; }
.req-no { color: var(--text-4); }

/* 字段关联状态 - 字段说明表内 */
.link-yes { display: inline-flex; align-items: center; gap: 3px; color: #16a34a; font-weight: 600; font-size: 12px; }
.link-no { display: inline-flex; align-items: center; gap: 3px; color: #9ca3af; font-size: 12px; }
.link-na { color: var(--text-4); font-size: 13px; }

/* 字段关联状态面板 */
.fls-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
.fls-summary { display: flex; gap: 8px; flex-wrap: wrap; }
.fls-pill { display: inline-flex; align-items: center; gap: 4px; padding: 5px 12px; border-radius: 20px; font-size: 12.5px; font-weight: 600; }
.fls-ok { background: #dcfce7; color: #15803d; }
.fls-no { background: #f3f4f6; color: #6b7280; }
.fls-total { background: var(--brand-soft); color: var(--brand); }
.fls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.fls-item { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 10px; border: 1px solid; transition: all .2s; }
.fls-item.linked { background: #f0fdf4; border-color: #bbf7d0; }
.fls-item.unlinked { background: #f9fafb; border-color: #e5e7eb; }
.fls-item:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,.06); }
.fls-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.fls-name { font-size: 12px; font-weight: 600; color: var(--text-1); }
.fls-cn { font-size: 12px; color: var(--text-3); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fls-badge { display: inline-flex; align-items: center; gap: 3px; padding: 3px 9px; border-radius: 6px; font-size: 11.5px; font-weight: 600; flex-shrink: 0; }
.badge-on { background: #16a34a; color: #fff; }
.badge-off { background: #e5e7eb; color: #6b7280; }

/* 导入历史 */
.history-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.history-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 20px; color: var(--text-4); }
.history-empty p { font-size: 14px; }
.history-table { display: flex; flex-direction: column; }
.ht-head, .ht-row { display: grid; grid-template-columns: 0.4fr 1.5fr 1.2fr 0.8fr 0.7fr 0.7fr 0.8fr 1.2fr; align-items: center; }
.ht-head { padding: 12px 6px; background: var(--bg-soft); border-radius: 10px; font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 4px; }
.ht-head > span { text-align: center; }
.ht-row { padding: 12px 6px; border-bottom: 1px solid var(--border); transition: background .15s; }
.ht-row:hover { background: var(--bg-soft); }
.ht-row > span { display: flex; align-items: center; justify-content: center; font-size: 12px; gap: 4px; }
.ht-idx { font-weight: 600; color: var(--text-4); }
.ht-file { font-weight: 600; color: var(--text-1); }
.ht-by, .ht-time { color: var(--text-3); }

/* 状态卡片操作按钮 */
.sc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.status-card.draft { border-color: #fed7aa; background: linear-gradient(135deg, #fff7ed, #fff); }
.status-card.draft .sc-icon { background: #ffedd5; color: #ea580c; }
.publish-desc { margin: 12px 0; padding-left: 18px; color: var(--text-2); font-size: 13.5px; line-height: 1.8; text-align: left; }
.btn-danger-outline { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border: 1px solid #fecaca; background: #fff; color: #dc2626; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-danger-outline:hover { background: #fef2f2; border-color: #fca5a5; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(220,38,38,.12); }
.btn-danger-outline:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn-warning-outline { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border: 1px solid #fde68a; background: #fffbeb; color: #d97706; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-warning-outline:hover { background: #fef3c7; border-color: #fcd34d; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(217,119,6,.12); }
.btn-warning-outline:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn-warning { display: inline-flex; align-items: center; gap: 6px; padding: 10px 24px; border: none; background: #f59e0b; color: #fff; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all .18s; box-shadow: 0 2px 10px rgba(245,158,11,.3); }
.btn-warning:hover { background: #d97706; transform: translateY(-1px); }
.btn-warning:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn-primary-outline { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border: 1px solid var(--brand); background: #fff; color: var(--brand); border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; }
.btn-primary-outline:hover { background: var(--brand-soft); border-color: var(--brand); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(79,124,255,.12); }
.btn-primary-outline:disabled { opacity: .5; cursor: not-allowed; transform: none; }

/* 删除确认弹窗 */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); backdrop-filter: blur(4px); display: grid; place-items: center; z-index: 9999; animation: fadeIn .15s ease; }
@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
.modal-card { background: #fff; border-radius: 20px; width: 92%; max-width: 480px; box-shadow: 0 20px 60px rgba(0,0,0,.2); animation: slideUp .2s ease; }
@keyframes slideUp { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 0; }
.modal-header h3 { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; color: var(--text-1); }
.modal-header h3 svg { color: #dc2626; }
.modal-close { width: 32px; height: 32px; border-radius: 8px; border: none; background: transparent; color: var(--text-4); cursor: pointer; display: grid; place-items: center; transition: all .15s; }
.modal-close:hover { background: var(--bg-soft); color: var(--text-1); }
.modal-body { padding: 20px 24px; text-align: center; }
.delete-warn-icon { width: 72px; height: 72px; border-radius: 20px; background: #fef2f2; color: #dc2626; display: grid; place-items: center; margin: 0 auto 16px; }
.delete-warn-title { font-size: 16px; font-weight: 700; color: var(--text-1); margin-bottom: 8px; }
.delete-warn-desc { font-size: 14px; color: var(--text-3); margin-bottom: 12px; }
.delete-warn-list { text-align: left; display: inline-block; margin: 0 auto 12px; padding: 0; list-style: none; }
.delete-warn-list li { position: relative; padding: 6px 0 6px 20px; font-size: 13px; color: var(--text-2); }
.delete-warn-list li::before { content: ''; position: absolute; left: 0; top: 13px; width: 6px; height: 6px; border-radius: 50%; background: #dc2626; }
.delete-warn-hint { font-size: 13px; color: #dc2626; font-weight: 600; }

/* 删除数据集选择 */
.delete-type-list { display: flex; flex-direction: column; gap: 10px; margin: 16px 0; text-align: left; }
.delete-type-item { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1.5px solid var(--border-strong); border-radius: 12px; cursor: pointer; transition: all .18s; }
.delete-type-item:hover { border-color: var(--brand); background: var(--brand-soft); }
.delete-type-item.active { border-color: #dc2626; background: #fef2f2; }
.dti-radio { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--border-strong); flex-shrink: 0; display: grid; place-items: center; margin-top: 2px; transition: all .18s; }
.delete-type-item.active .dti-radio { border-color: #dc2626; }
.dti-dot { width: 10px; height: 10px; border-radius: 50%; background: #dc2626; }
.dti-body { display: flex; flex-direction: column; gap: 3px; }
.dti-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
.dti-desc { font-size: 12px; color: var(--text-3); }
.modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 0 24px 20px; }
.btn-danger { display: inline-flex; align-items: center; gap: 6px; padding: 10px 24px; border: none; background: #dc2626; color: #fff; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all .18s; box-shadow: 0 2px 10px rgba(220,38,38,.3); }
.btn-danger:hover { background: #b91c1c; transform: translateY(-1px); }
.btn-danger:disabled { opacity: .5; cursor: not-allowed; transform: none; }

/* 导入历史失败原因 */
.ht-err { font-size: 12px; color: #dc2626; word-break: break-all; }
.badge-red { background: #fef2f2; color: #dc2626; }

@media (max-width: 900px) {
  .raw-table-wrap { overflow-x: auto; }
  .ft-head { display: none; }
  .ft-row { grid-template-columns: 1fr 1fr; gap: 8px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; }
  .ht-head { display: none; }
  .ht-row { grid-template-columns: 1fr 1fr; gap: 8px; padding: 14px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; }
  .fls-grid { grid-template-columns: 1fr; }
  .status-cards { flex-direction: column; }
  .dataset-cards { flex-direction: column; }
}
</style>