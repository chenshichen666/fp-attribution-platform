/**
 * TRAG 正式检索服务客户端（方案 A）
 *
 * 直接转发到独立的 TRAG 精标数据检索 HTTP API（独立集群 / 独立模型），
 * 不再依赖本地 Python 微服务（脆弱的 trag SDK + ElementHub 链路）。
 *
 * API 基址走环境变量 TRAG_API_BASE（默认 fine.data.retrieval.api.polaris:8080），
 * 部署到 IDC（可访问该集群）开箱即用；DevCloud 等不可达环境优雅提示。
 *
 * 接口契约见 .agent/resources/release.html（2026-07-30 v1.0）。
 */

import crypto from 'node:crypto'

const TRAG_API_BASE = (process.env.TRAG_API_BASE || 'http://fine.data.retrieval.api.polaris:8080').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.TRAG_TIMEOUT_MS || '60000')

// igate 网关鉴权（可选）：若 TRAG 服务前置 igate 且要求调用方签名，
// 配置 TRAG_IGATE_KEY / TRAG_IGATE_SECRET 后，每个请求自动附带
// with-timestamp + with-signature 头。密钥由 TRAG 服务方（igate 调用方注册）提供，
// 非本项目可生成；签名算法需与 TRAG 团队 igate 配置一致（默认 HMAC-SHA256，base64）。
// 注意：当前 DevCloud 环境 403 是 igate 网络 ACL 拦截（acl_denied），与签名无关，
// 需先在 igate 开通源 IP 访问权限（https://wiki.example.com/p/00000000）或将后端部署到 IDC。
const TRAG_IGATE_KEY = process.env.TRAG_IGATE_KEY || ''
const TRAG_IGATE_SECRET = process.env.TRAG_IGATE_SECRET || ''
const TRAG_IGATE_SIGN_ALGO = (process.env.TRAG_IGATE_SIGN_ALGO || 'sha256').toLowerCase()

// 生成 igate 网关签名头；无密钥时返回空对象（保持明文直调，兼容契约文档用法）
function _igateHeaders(method, path, bodyStr = '') {
  if (!TRAG_IGATE_SECRET) return {}
  const ts = String(Math.floor(Date.now() / 1000))
  // 标准 igate 签名：HMAC(secret, timestamp + METHOD + path + body) → base64
  const raw = `${ts}${String(method).toUpperCase()}${path}${bodyStr || ''}`
  const sig = crypto.createHmac(TRAG_IGATE_SIGN_ALGO, TRAG_IGATE_SECRET).update(raw).digest('base64')
  const h = { 'with-timestamp': ts, 'with-signature': sig }
  if (TRAG_IGATE_KEY) h['with-key'] = TRAG_IGATE_KEY
  return h
}

// 是否启用本地 Python 微服务兜底（默认 false，仅 TRAG_MODE=local 时启用）
export function isLocalMode() {
  return (process.env.TRAG_MODE || 'upstream').toLowerCase() === 'local'
}

// 8 种任务类型（与正式 API GET /api/tasks 保持一致；服务可达时运行时覆盖）
const TASK_TYPES = [
  { task: 'text_text',            label: '文本→文本',         input_type: 'text',    desc: '用文本查询文本 collection' },
  { task: 'image_image_shangshu', label: '图片→图片（商数）', input_type: 'shangshu', desc: '用图片 URL 经商数 API 转为向量后检索图片 collection' },
  { task: 'image_ocr',            label: '图片OCR→文本',      input_type: 'text',    desc: '用文本查询图片 OCR collection' },
  { task: 'video_video',          label: '视频→视频',         input_type: 'fingerprint', desc: '输入视频指纹或 base64 向量检索视频 collection' },
  { task: 'video_ocr',            label: '视频OCR→文本',      input_type: 'text',    desc: '用文本查询视频 OCR collection' },
  { task: 'video_asr',            label: '视频ASR→文本',      input_type: 'text',    desc: '用文本查询视频 ASR collection' },
  { task: 'video_patch_asr',      label: '视频ASR片段→文本',  input_type: 'text',    desc: '用文本查询视频 ASR 片段（patch）collection' },
  { task: 'video_frame',          label: '图片→视频风险帧',   input_type: 'url',     desc: '用风险帧 URL 查询视频风险帧 collection' },
]

let _lastHealth = null // 上次成功调用时间，用于 /api/health 上报

async function _request(path, { method = 'GET', body, timeout } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout || TIMEOUT_MS)
  const bodyStr = body ? JSON.stringify(body) : ''
  try {
    const r = await fetch(`${TRAG_API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ..._igateHeaders(method, path, bodyStr) },
      body: body ? bodyStr : undefined,
      signal: ctrl.signal,
    })
    return r
  } finally {
    clearTimeout(t)
  }
}

export function baseUrl() {
  return TRAG_API_BASE
}

export function lastHealth() {
  return _lastHealth
}

// 获取任务类型元信息（优先运行时从服务拉取，失败回退静态列表）
export async function getTasks() {
  // 安全闸门：上游未放行时不发起任何内网请求，直接用静态任务列表
  if (!upstreamAllowed()) return null
  try {
    const r = await _request('/api/tasks', { timeout: 5000 })
    if (!r.ok) return null
    const data = await r.json()
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.tasks)) return data.tasks
    return null
  } catch {
    return null
  }
}

// 获取筛选选项（标签 + 行业）
export async function getFilterOptions() {
  try {
    const r = await _request('/api/filter_options', { timeout: 5000 })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// 是否允许访问上游内网集群（安全开关）
//
// 重要：上游 TRAG 集群位于内网（fine.data.retrieval.api.polaris），返回的是**真实业务数据**
//      （真实 policy_id、真实审核员、真实素材）。若把本平台部署到公网且部署机恰好能连通内网，
//      外网访客就能透过本应用间接拉取内网真实数据 —— 属于严重的数据泄露。
//
// 因此默认**禁用**上游，检索走本地引擎（脱敏后的 SQLite 数据）。
// 只有内网自用、且明确知晓风险时，才在 server/.env 中设置 TRAG_ALLOW_UPSTREAM=true 开启。
export function upstreamAllowed() {
  return String(process.env.TRAG_ALLOW_UPSTREAM || 'false').toLowerCase() === 'true'
}

// 执行检索
export async function search(params) {
  // 安全闸门：上游未显式放行时，直接拒绝，由调用方回退到本地引擎
  if (!upstreamAllowed()) {
    const e = new Error('上游内网检索已禁用（TRAG_ALLOW_UPSTREAM 未开启），请改用本地检索引擎')
    e.status = 503
    e.upstreamDisabled = true
    throw e
  }

  const {
    task,
    query,
    limit = 10,
    filter_expr = null,
    tags = [],
    first_industries = [],
    second_industries = [],
    group_by_video = false,
    threshold = 0,
  } = params

  if (!task || !query) {
    const e = new Error('task 和 query 为必填参数')
    e.status = 400
    throw e
  }

  const payload = {
    task,
    query,
    limit: Number(limit) || 10,
    filter_expr: filter_expr || null,
    tags: Array.isArray(tags) ? tags : [],
    first_industries: Array.isArray(first_industries) ? first_industries : [],
    second_industries: Array.isArray(second_industries) ? second_industries : [],
    group_by_video: !!group_by_video,
  }

  let r
  try {
    r = await _request('/api/search', { method: 'POST', body: payload })
  } catch (fetchErr) {
    // DNS / 连接不可达：DevCloud 等环境访问不到 IDC 集群
    const e = new Error(
      `TRAG 检索服务暂不可达（${TRAG_API_BASE}），请确认当前环境能否访问正式检索集群（IDC 环境需 igate 权限）`
    )
    e.status = 503
    e.cause = fetchErr?.message
    throw e
  }

  _lastHealth = Date.now()

  if (!r.ok) {
    let detail = `TRAG检索失败 (${r.status})`
    let bodyText = ''
    try {
      bodyText = await r.text()
    } catch { /* ignore */ }
    try {
      const j = JSON.parse(bodyText)
      detail = j.error || j.detail || j.message || detail
    } catch { /* 非 JSON，尝试从文本体提取可读信息 */ }
    // 网关 ACL 拦截（DevCloud 访问 IDC 需 igate 权限）：给出可操作的提示
    if (r.status === 403 && /acl|igate|denied|权限|IDC/i.test(bodyText || '')) {
      if (TRAG_IGATE_SECRET) {
        detail = 'TRAG 检索被 igate 网关拒绝（ACL/签名校验失败），请核对 TRAG_IGATE_KEY/TRAG_IGATE_SECRET 与签名算法，或在 igate 开通访问权限'
      } else {
        detail = 'TRAG 检索服务当前环境无访问权限（igate ACL 拦截）：DevCloud 访问 IDC 需先在 igate 开通源 IP 权限（https://wiki.example.com/p/00000000），或将后端部署到 IDC 内网'
      }
    } else if (bodyText && !detail.includes('TRAG检索失败')) {
      detail = bodyText.slice(0, 200)
    }
    const e = new Error(detail)
    // 403/网络不可达 → 503（可用性/权限问题，前端走友好降级）；400 → 400；其余 → 502
    e.status = r.status === 400 ? 400 : (r.status === 403 || r.status === 502 ? 503 : 502)
    throw e
  }

  const data = await r.json()
  let results = Array.isArray(data.results) ? data.results : []
  const thr = Number(threshold) || 0
  if (thr > 0) {
    results = results.filter((x) => (Number(x?.score) || 0) >= thr)
  }
  return {
    results,
    total: results.length,
    task,
    query: data.query ?? query,
    filter_expr: data.filter_expr ?? null,
  }
}

// 将检索结果导出为 CSV（服务返回文件流）
export async function exportCsv({ task, query, results }) {
  if (!upstreamAllowed()) {
    const e = new Error('上游内网服务已禁用（TRAG_ALLOW_UPSTREAM 未开启）')
    e.status = 503
    e.upstreamDisabled = true
    throw e
  }
  const payload = {
    task,
    query: query || '',
    results: Array.isArray(results) ? results : [],
  }
  let r
  try {
    r = await _request('/api/export_csv', { method: 'POST', body: payload, timeout: 60000 })
  } catch (fetchErr) {
    // 注意：此 catch 仅捕获"连接不可达"；403 ACL 由下方 r.ok 分支处理
    if (fetchErr.status) throw fetchErr
    const e = new Error(`TRAG CSV 导出服务暂不可达（${TRAG_API_BASE}）`)
    e.status = 503
    e.cause = fetchErr?.message
    throw e
  }
  if (!r.ok) {
    let detail = `CSV 导出失败 (${r.status})`
    try {
      const j = await r.json()
      detail = j.error || j.detail || j.message || detail
    } catch { /* ignore */ }
    const e = new Error(detail)
    e.status = r.status === 400 ? 400 : 502
    throw e
  }
  const buf = Buffer.from(await r.arrayBuffer())
  const cd = r.headers.get('content-disposition') || ''
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)
  const filename = m ? m[1] : `trag_${task}_${Date.now()}.csv`
  return { buffer: buf, filename, contentType: r.headers.get('content-type') || 'text/csv; charset=utf-8' }
}

export async function health() {
  try {
    const r = await _request('/api/health', { timeout: 5000 })
    return r.ok
  } catch {
    return false
  }
}

// 上传本地图片，返回可被 TRAG 回拉的 URL（契约 3.5 节 POST /api/upload_image）
// 支持两种方式（与契约一致）：
//   1. multipart/form-data，字段名 file
//   2. application/json + data_url（{ filename, data_url }）
export async function uploadImage({ file, filename, dataUrl }) {
  if (!upstreamAllowed()) {
    const e = new Error('上游内网服务已禁用（TRAG_ALLOW_UPSTREAM 未开启）')
    e.status = 503
    e.upstreamDisabled = true
    throw e
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    let r
    if (file) {
      // 浏览器/Node 侧以 multipart 上传（FormData + Blob）
      const fd = new FormData()
      const blob = file instanceof Blob ? file : new Blob([file], { type: file.type || 'application/octet-stream' })
      fd.append('file', blob, filename || 'upload.png')
      r = await fetch(`${TRAG_API_BASE}/api/upload_image`, {
        method: 'POST',
        headers: { ..._igateHeaders('POST', '/api/upload_image') },
        body: fd,
        signal: ctrl.signal,
      })
    } else if (dataUrl) {
      const uploadBody = JSON.stringify({ filename: filename || 'upload.png', data_url: dataUrl })
      r = await fetch(`${TRAG_API_BASE}/api/upload_image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._igateHeaders('POST', '/api/upload_image', uploadBody) },
        body: uploadBody,
        signal: ctrl.signal,
      })
    } else {
      const e = new Error('uploadImage 需要 file 或 data_url 参数')
      e.status = 400
      throw e
    }

    if (!r.ok) {
      let detail = `图片上传失败 (${r.status})`
      try {
        const j = await r.json()
        detail = j.error || j.detail || j.message || detail
      } catch {
        try { detail = (await r.text()).slice(0, 200) || detail } catch { /* ignore */ }
      }
      const e = new Error(detail)
      e.status = r.status === 400 ? 400 : (r.status === 403 ? 503 : 502)
      throw e
    }
    const data = await r.json()
    _lastHealth = Date.now()
    return { url: data.url, filename: data.filename, size: data.size }
  } catch (fetchErr) {
    if (fetchErr.status) throw fetchErr
    const e = new Error(
      `TRAG 图片上传服务暂不可达（${TRAG_API_BASE}），请确认当前环境能否访问正式检索集群（IDC 环境需 igate 权限）`
    )
    e.status = 503
    e.cause = fetchErr?.message
    throw e
  } finally {
    clearTimeout(t)
  }
}

export { TASK_TYPES }
