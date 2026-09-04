/**
 * TRAG 本地检索引擎（外网 Demo 模式的真实实现）
 *
 * 背景：原 TRAG 检索依赖内网 IDC 向量集群（trag SDK + ElementHub + 商数视觉嵌入），
 *      外网环境必然不可达。为了让「点击素材 → 相似样本检索」这条链路真正可用，
 *      这里用纯 Node 实现一个零依赖的本地检索，直接跑在 SQLite 业务数据上。
 *
 * 设计原则：这是「真检索」，不是 mock。同样的 query 稳定返回同样的近邻，
 *          相似度分数有明确数学含义，过滤条件真实生效。
 *
 * 算法：
 *   1. 文本类任务 —— 字符 bigram(2-gram) + TF-IDF 加权余弦相似度
 *      中文没有空格分词，字符 bigram 是无监督条件下最实用的语义近似方案，
 *      对 OCR/ASR 这类短文本的重叠片段尤其有效。
 *   2. 视觉类任务 —— 外网无视觉模型，退化为「结构化近邻」：
 *      同聚类(class_id) + 同标签 + 同行业 + 同广告主 + 同素材类型 加权打分，
 *      视频指纹任务额外用 fingerprint 的 Dice 系数做字面近邻。
 *      这是「内容相似」的合理近似，不是随机返回。
 *
 * 检索源：real_data_samples（主源）+ ai_evaluate_detail（补充源）
 */

import { query } from '../db/pool.js'

// ===== 任务 → 检索字段映射 =====
// text_field: 参与文本相似度计算的字段
// kind: text(文本近邻) | visual(结构化近邻) | fingerprint(指纹近邻)
const TASK_PROFILE = {
  text_text:            { kind: 'text',        fields: ['ocr_content', 'asr_content'] },
  image_ocr:            { kind: 'text',        fields: ['ocr_content'] },
  video_ocr:            { kind: 'text',        fields: ['ocr_content'] },
  video_asr:            { kind: 'text',        fields: ['asr_content'] },
  video_patch_asr:      { kind: 'text',        fields: ['asr_content', 'ocr_content'] },
  image_image_shangshu: { kind: 'visual',      fields: [] },
  video_frame:          { kind: 'visual',      fields: [] },
  video_video:          { kind: 'fingerprint', fields: [] },
}

// ===== 文本处理 =====

// 归一化：小写、剔除非文字数字（保留中英文数字），中文按字切
function normalize(text) {
  if (!text) return ''
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// 字符 bigram：中文按字，英文数字连续段内部再切 bigram
function toBigrams(text) {
  const s = normalize(text)
  if (!s) return []
  const grams = []
  // 中文：逐字滑窗
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || []
  for (const seg of cjk) {
    if (seg.length === 1) { grams.push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
  }
  // 英数：按连续段滑窗
  const an = s.match(/[a-z0-9]+/g) || []
  for (const seg of an) {
    if (seg.length === 1) { grams.push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
  }
  return grams
}

// 词频向量
function termFreq(grams) {
  const tf = new Map()
  for (const g of grams) tf.set(g, (tf.get(g) || 0) + 1)
  return tf
}

// 余弦相似度（基于共用词表，TF-IDF 加权）
function cosineSim(tfA, tfB, idf) {
  if (!tfA.size || !tfB.size) return 0
  let dot = 0, normA = 0, normB = 0
  for (const [g, wa] of tfA) {
    const w = wa * (idf.get(g) || 1)
    normA += w * w
  }
  for (const [g, wb] of tfB) {
    const w = wb * (idf.get(g) || 1)
    normB += w * w
  }
  // 只在 A 的词表上算点积（B 中不存在的词贡献 0）
  for (const [g, wa] of tfA) {
    const wb = tfB.get(g)
    if (wb === undefined) continue
    dot += wa * (idf.get(g) || 1) * wb * (idf.get(g) || 1)
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Dice 系数：两个集合的重叠度，用于指纹字面近邻
function diceCoef(setA, setB) {
  if (!setA.size || !setB.size) return 0
  let inter = 0
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  for (const v of small) if (large.has(v)) inter++
  return (2 * inter) / (setA.size + setB.size)
}

// ===== 结构化近邻打分（视觉类任务） =====
const STRUCT_WEIGHT = {
  classId: 0.34,      // 同一聚类簇 —— 最强信号
  tagId: 0.20,        // 同一审核标签
  industryL1: 0.14,   // 一级行业
  industryL2: 0.12,   // 二级行业
  elementType: 0.10,  // 素材类型（图片/视频/文本）
  advertiser: 0.10,   // 同一广告主
}

function structScore(source, target) {
  let s = 0
  if (source.class_id && target.class_id && String(source.class_id) === String(target.class_id)) s += STRUCT_WEIGHT.classId
  if (source.tag_id && target.tag_id && String(source.tag_id) === String(target.tag_id)) s += STRUCT_WEIGHT.tagId
  if (source.first_level_industry_name && source.first_level_industry_name === target.first_level_industry_name) s += STRUCT_WEIGHT.industryL1
  if (source.second_level_industry_name && source.second_level_industry_name === target.second_level_industry_name) s += STRUCT_WEIGHT.industryL2
  if (source.element_type && source.element_type === target.element_type) s += STRUCT_WEIGHT.elementType
  if (source.ops_advertiser_name && source.ops_advertiser_name === target.ops_advertiser_name) s += STRUCT_WEIGHT.advertiser
  return s
}

// ===== 语料加载 =====

// 加载检索语料：real_data_samples 为主，ai_evaluate_detail 补充
// 返回统一结构的候选集
async function loadCorpus() {
  const items = []
  const seenFp = new Set()

  // 主源：真实样本表
  let rows = []
  try {
    rows = await query(`
      SELECT id, tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video,
             policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name,
             media_url, ocr_content, asr_content, class_num, class_id, uid,
             ops_advertiser_name, ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason
      FROM real_data_samples
    `)
  } catch { rows = [] }

  for (const r of rows) {
    const fp = r.element_fingerprint || ''
    if (fp) seenFp.add(fp)
    items.push({
      _src: 'samples',
      id: r.id,
      element_fingerprint: fp,
      element_value: r.media_url || '',
      media_url: r.media_url || '',
      ocr_content: r.ocr_content || '',
      asr_content: r.asr_content || '',
      patch_asr_text: '',
      element_type: r.element_type || '',
      v6_level_name_1: r.first_level_industry_name || '',
      v6_level_name_2: r.second_level_industry_name || '',
      ops_advertiser_name: r.ops_advertiser_name || '',
      dc_id: r.dc_id || '',
      tag_id: r.tag_id,
      tag_name: r.tag_name || '',
      class_id: r.class_id || '',
      class_num: r.class_num || '',
      policy_ids: r.policy_ids || '',
      ai_evaluate_policy_ids: r.ai_evaluate_policy_ids || '',
      is_fp: r.is_fp,
      fp_reason: r.fp_reason || '',
      arrive_time: r.arrive_time || '',
      ds: r.ds || '',
      _raw: r,
    })
  }

  // 补充源：AI 评测明细（含未进入样本表的素材）
  let aide = []
  try {
    aide = await query(`
      SELECT id, evaluation_target_type_name, first_level_industry_name, second_level_industry_name,
             element_type, element_type_name, policy_ids, ai_evaluate_policy_ids, element_value,
             ocr_content, asr_content, class_num, class_id, dc_id, uid, uid_name,
             ops_advertiser_name, model_version, ai_evaluate_reviewer_name, element_fingerprint,
             arrive_time, ds
      FROM ai_evaluate_detail
    `)
  } catch { aide = [] }

  for (const r of aide) {
    const fp = r.element_fingerprint || ''
    // 与样本表重复的跳过（样本表优先）
    if (fp && seenFp.has(fp)) continue
    items.push({
      _src: 'ai_detail',
      id: r.id,
      element_fingerprint: fp,
      element_value: r.element_value || '',
      media_url: r.element_value || '',
      ocr_content: r.ocr_content || '',
      asr_content: r.asr_content || '',
      patch_asr_text: '',
      element_type: r.element_type || r.element_type_name || '',
      v6_level_name_1: r.first_level_industry_name || '',
      v6_level_name_2: r.second_level_industry_name || '',
      ops_advertiser_name: r.ops_advertiser_name || '',
      dc_id: r.dc_id || '',
      tag_id: null,
      tag_name: '',
      class_id: r.class_id || '',
      class_num: r.class_num || '',
      policy_ids: r.policy_ids || '',
      ai_evaluate_policy_ids: r.ai_evaluate_policy_ids || '',
      is_fp: null,
      fp_reason: '',
      arrive_time: r.arrive_time || '',
      ds: r.ds || '',
      _raw: r,
    })
  }

  return items
}

// ===== IDF 计算 =====
function buildIdf(docs) {
  const df = new Map()
  for (const grams of docs) {
    for (const g of new Set(grams)) df.set(g, (df.get(g) || 0) + 1)
  }
  const N = docs.length || 1
  const idf = new Map()
  for (const [g, c] of df) {
    // 平滑 IDF，避免除零
    idf.set(g, Math.log((N + 1) / (c + 1)) + 1)
  }
  return idf
}

// ===== 过滤条件 =====
function applyFilters(items, { tags, firstIndustries, secondIndustries }) {
  let out = items
  if (tags && tags.length) {
    const set = new Set(tags.map(String))
    out = out.filter((it) => it.tag_id != null && set.has(String(it.tag_id)))
  }
  if (firstIndustries && firstIndustries.length) {
    const set = new Set(firstIndustries)
    out = out.filter((it) => set.has(it.v6_level_name_1))
  }
  if (secondIndustries && secondIndustries.length) {
    const set = new Set(secondIndustries)
    out = out.filter((it) => set.has(it.v6_level_name_2))
  }
  return out
}

// ===== 主入口 =====
/**
 * 本地相似检索
 * @param {object} params { task, query, limit, threshold, tags, first_industries, second_industries }
 * @returns {Promise<{results: Array, total: number, task: string, engine: string}>}
 */
export async function localSearch(params) {
  const {
    task, query: queryText, limit = 10, threshold = 0,
    tags = [], first_industries = [], second_industries = [],
  } = params

  const profile = TASK_PROFILE[task] || TASK_PROFILE.text_text
  let corpus = await loadCorpus()
  corpus = applyFilters(corpus, {
    tags, firstIndustries: first_industries, secondIndustries: second_industries,
  })

  if (!corpus.length) {
    return { results: [], total: 0, task, engine: 'local' }
  }

  let scored = []

  if (profile.kind === 'text') {
    scored = textSearch(corpus, queryText, profile.fields, threshold)
  } else if (profile.kind === 'fingerprint') {
    scored = fingerprintSearch(corpus, queryText, threshold)
  } else {
    scored = visualSearch(corpus, queryText, threshold)
  }

  // 排序 + 截断
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Number(limit) || 10)

  // 脱去内部字段，输出前端契约结构
  const results = top.map((it) => {
    const { _src, _raw, score, ...rest } = it
    return {
      ...rest,
      score: Number(score.toFixed(4)),
      // 前端优先读 element_value，media_url 作为兜底
      element_value: rest.element_value || rest.media_url || '',
      // 机审标签：从 policy_ids 解析（enrichResultsWithTags 会再次增强）
      policy_list: parsePolicyIds(rest.policy_ids),
    }
  })

  return {
    results,
    total: results.length,
    task,
    engine: 'local',
    // 供 UI 提示：这条结果由本地引擎产出，非 IDC 向量集群
    engineNote: profile.kind === 'text'
      ? '本地文本近邻（bigram + TF-IDF 余弦）'
      : (profile.kind === 'fingerprint' ? '本地指纹近邻（Dice 系数 + 结构化加权）' : '本地结构化近邻（聚类/标签/行业/广告主加权）'),
  }
}

// ===== 文本检索 =====
function textSearch(corpus, queryText, fields, threshold) {
  // 语料向量化
  const docs = corpus.map((it) => {
    const text = fields.map((f) => it[f] || '').join(' ')
    return toBigrams(text)
  })
  const idf = buildIdf(docs)
  const qGrams = toBigrams(queryText)
  const qTf = termFreq(qGrams)

  const out = []
  for (let i = 0; i < corpus.length; i++) {
    const grams = docs[i]
    if (!grams.length) continue
    const tf = termFreq(grams)
    const s = cosineSim(qTf, tf, idf)
    if (s <= 0 || s < threshold) continue
    out.push({ ...corpus[i], score: s })
  }
  return out
}

// ===== 指纹检索（video_video） =====
// 思路：先用指纹定位「锚点素材」，再以锚点做结构化近邻。
// 直接对所有素材算指纹 Dice 会让随机指纹也有 0.6+ 的基线分（公共子串如 fp_/数字），
// 召回结果退化成随机，因此改为「定位优先、近邻其次」。
function fingerprintSearch(corpus, fpQuery, threshold) {
  const q = String(fpQuery || '').trim()
  if (!q) return []

  // 1. 精确命中源素材
  const source = corpus.find((it) => it.element_fingerprint === q) || null

  // 2. 找锚点：精确命中优先，否则取 Dice 最高且超过可信基线的那条
  let anchor = source
  if (!anchor) {
    const qSet = new Set(toBigrams(q))
    let best = 0
    for (const it of corpus) {
      if (!it.element_fingerprint) continue
      const dice = diceCoef(qSet, new Set(toBigrams(it.element_fingerprint)))
      if (dice > best) { best = dice; anchor = it }
    }
    // Dice 基线约 0.6（随机指纹的公共子串所致），低于 0.75 视为未命中，
    // 此时不返回近邻，避免给出误导性的「相似」结果
    if (!anchor || best < 0.75) return []
  }

  // 3. 以锚点为基准算近邻：指纹相似度 + 结构化相似度
  const qSet = new Set(toBigrams(q))
  const anchorText = `${anchor.ocr_content || ''} ${anchor.asr_content || ''}`.trim()
  const out = []
  for (const it of corpus) {
    if (it === source) continue // 排除查询素材自身
    const dice = it.element_fingerprint
      ? diceCoef(qSet, new Set(toBigrams(it.element_fingerprint)))
      : 0
    const struct = structScore(anchor, it)
    // 文本近邻作为补充（同批素材的 OCR/ASR 通常相近）
    const itText = `${it.ocr_content || ''} ${it.asr_content || ''}`.trim()
    const textSim = (anchorText && itText)
      ? diceCoef(new Set(toBigrams(anchorText)), new Set(toBigrams(itText)))
      : 0

    // 指纹 0.55 + 结构 0.30 + 文本 0.15
    const s = dice * 0.55 + struct * 0.30 + textSim * 0.15
    if (s <= 0 || s < threshold) continue

    const item = { ...it, score: s }
    // 与查询指纹完全相同 → 置顶
    if (it.element_fingerprint === q) item.score = 0.999
    out.push(item)
  }
  return out
}

// ===== 视觉检索（图片→图片 / 图片→风险帧） =====
// query 是素材 URL（或任意文本）。外网无视觉模型，
// 用「URL 定位源素材 → 结构化近邻」实现，语义上等价于「找同类型的相似素材」
function visualSearch(corpus, queryText, threshold) {
  // 1. 尝试用 query 定位源素材（media_url 命中，或指纹命中）
  const q = String(queryText || '').trim()
  let source = corpus.find((it) => it.media_url && it.media_url === q)
    || corpus.find((it) => it.element_value && it.element_value === q)
    || corpus.find((it) => it.element_fingerprint && it.element_fingerprint === q)
    || null

  // 2. 若 URL 带 query 参数，去掉参数再试一次
  if (!source && q.includes('?')) {
    const bare = q.split('?')[0]
    source = corpus.find((it) => it.media_url && it.media_url.split('?')[0] === bare)
  }

  const out = []
  if (source) {
    // 找到源素材：以它为锚点算结构化近邻
    for (const it of corpus) {
      if (it === source) continue // 排除自身
      let s = structScore(source, it)
      // 同一聚类簇是强信号，额外加成（structScore 已计一次，这里再强化区分度）
      if (source.class_id && it.class_id && String(it.class_id) === String(source.class_id)) {
        s += 0.12
      }
      // OCR/ASR 文本相似作为补充信号
      const txtA = `${source.ocr_content || ''} ${source.asr_content || ''}`.trim()
      const txtB = `${it.ocr_content || ''} ${it.asr_content || ''}`.trim()
      if (txtA && txtB) {
        const dice = diceCoef(new Set(toBigrams(txtA)), new Set(toBigrams(txtB)))
        s += dice * 0.18
      }
      if (s <= 0 || s < threshold) continue
      out.push({ ...it, score: s })
    }
  } else {
    // 未定位到源素材：把 query 当文本，在 OCR/ASR 上做近邻，
    // 再与结构化信号融合 —— 保证任何输入都有合理返回
    const docs = corpus.map((it) => toBigrams(`${it.ocr_content || ''} ${it.asr_content || ''}`))
    const idf = buildIdf(docs)
    const qTf = termFreq(toBigrams(q))
    for (let i = 0; i < corpus.length; i++) {
      const tf = termFreq(docs[i])
      const textSim = cosineSim(qTf, tf, idf)
      const s = textSim * 0.7 + structScore({}, corpus[i]) * 0.3
      if (s <= 0 || s < threshold) continue
      out.push({ ...corpus[i], score: s })
    }
  }
  return out
}

// ===== 工具 =====
function parsePolicyIds(raw) {
  if (!raw) return []
  try {
    // 支持 "[1,2]" 或 "1,2" 或 JSON 数组
    if (Array.isArray(raw)) return raw
    const s = String(raw).trim()
    if (!s || s === '[]') return []
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return String(raw).replace(/[\[\]"'\s]/g, '').split(',').filter(Boolean)
  }
}

// ===== 本地 CSV 导出 =====
// CSV 导出只是把已有的检索结果序列化，不依赖任何外部服务，
// 因此在本地引擎中实现即可，保证「检索 → 导出」链路完整可用。
const CSV_COLUMNS = [
  ['score', '相似度'],
  ['element_fingerprint', '元素指纹'],
  ['element_value', '素材地址'],
  ['element_type', '素材类型'],
  ['v6_level_name_1', '一级行业'],
  ['v6_level_name_2', '二级行业'],
  ['ops_advertiser_name', '客户主体'],
  ['tag_name', '审核标签'],
  ['class_id', '聚类簇'],
  ['ocr_content', 'OCR文本'],
  ['asr_content', 'ASR文本'],
  ['policy_ids', '机审标签'],
  ['ai_evaluate_policy_ids', '人审标签'],
  ['dc_id', 'DCID'],
  ['ds', '日期'],
]

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v)
  // 含逗号、引号、换行时用双引号包裹，内部引号转义
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function localExportCsv({ task, query: queryText, results }) {
  const rows = Array.isArray(results) ? results : []
  const lines = []

  // 表头
  lines.push(CSV_COLUMNS.map((c) => c[1]).join(','))

  for (const r of rows) {
    lines.push(CSV_COLUMNS.map(([key]) => csvEscape(r?.[key])).join(','))
  }

  // BOM：保证 Excel 正确识别 UTF-8 中文
  const csv = '\uFEFF' + lines.join('\r\n')
  const safeTask = String(task || 'search').replace(/[^\w-]/g, '')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

  return {
    buffer: Buffer.from(csv, 'utf8'),
    contentType: 'text/csv; charset=utf-8',
    filename: `trag_${safeTask}_${stamp}.csv`,
  }
}

// ===== 本地图片上传 =====
// 上游把图片存到商数 API 换取可回拉的 URL。外网无此服务，
// 这里改为落盘到 server/public/uploads/ 并返回同域可访问 URL，
// 使「上传图片 → 以图搜图」链路可跑通（检索由本地引擎承接）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../public/uploads')
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB

export function localUploadImage({ filename, dataUrl, fileBuffer, mimeType }) {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  }

  let buf = fileBuffer
  let ext = path.extname(filename || '').toLowerCase() || '.png'

  // 优先用 data_url（前端统一以这种方式上传）
  if (!buf && dataUrl && typeof dataUrl === 'string') {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s)
    if (!m) {
      const e = new Error('data_url 格式不正确，需为 data:<mime>;base64,<内容>')
      e.status = 400
      throw e
    }
    const mime = m[1]
    buf = Buffer.from(m[2], 'base64')
    const extMap = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
    }
    ext = extMap[mime] || ext
  }

  if (!buf || !buf.length) {
    const e = new Error('缺少图片内容（data_url 或 file）')
    e.status = 400
    throw e
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    const e = new Error(`图片超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`)
    e.status = 413
    throw e
  }

  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf)

  return {
    url: `/uploads/${name}`,
    filename: name,
    size: buf.length,
    engine: 'local',
    engineNote: '图片已存至本地（外网 Demo 模式，未上传商数 API）',
  }
}

export default { localSearch, localExportCsv, localUploadImage }
