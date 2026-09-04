// 统一 API 封装层：所有请求带上当前用户身份头（外网 Demo 模式默认 admin）
import { dataMode } from '../utils/env.js'

const BASE = '/api'

function authHeaders() {
  let u = null
  try { u = JSON.parse(localStorage.getItem('fp_user') || 'null') } catch { u = null }
  const h = {}
  if (u?.eng) {
    h['x-user-eng'] = u.eng
    h['x-user-name'] = encodeURIComponent(u.name || '')
    h['x-user-team'] = encodeURIComponent(u.team || '')
  }
  // 数据模式：With 平台预览域名走草稿表，线上正式域名走正式表
  h['x-data-mode'] = dataMode()
  return h
}

async function request(method, path, body) {
  // 强制缓存破坏：每个请求追加唯一时间戳，绕过企业代理/浏览器/CDN 的任何层级缓存
  let url = BASE + path
  if (method === 'GET') {
    url += (path.includes('?') ? '&' : '?') + '_t=' + Date.now()
  }
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const resp = await fetch(url, opts)
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败 ${resp.status}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
}

// 把 {start,end} 等对象转为 ?a=b 查询串（忽略空值）
function qs(obj) {
  if (!obj) return ''
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// ===== 业务接口封装 =====
export const authApi = {
  me: () => api.get('/auth/me'),
  myRequests: () => api.get('/auth/my-requests'),
}
export const ticketApi = {
  list: () => api.get('/tickets'),
  detail: (id) => api.get(`/tickets/${id}`),
  create: (data) => api.post('/tickets', data),
  accept: (id) => api.post(`/tickets/${id}/accept`),
  conclude: (id, data) => api.post(`/tickets/${id}/conclude`, data),
  adopt: (id, data) => api.post(`/tickets/${id}/adopt`, data),
  reject: (id, data) => api.post(`/tickets/${id}/reject`),
  reopen: (id) => api.post(`/tickets/${id}/reopen`),
  remove: (id) => api.del(`/tickets/${id}`),
  notifySuggests: (q) => api.get(`/tickets/notify-suggests${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  search: (q) => api.get(`/tickets/search${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  similarSearch: (id, data) => api.post(`/tickets/${id}/similar-search`, data),
  similarLibrary: (id) => api.get(`/tickets/${id}/similar-library`),
  clearSimilarLibrary: (id) => api.del(`/tickets/${id}/similar-library`),
  selectSimilarSamples: (id, data) => api.post(`/tickets/${id}/similar-library/select`, data),
  exportExcel: (id) => downloadBlob(`/tickets/${id}/export`, {}, `ticket-${id}.xlsx`),
  listDrafts: () => api.get('/tickets/drafts'),
  saveDraft: (data) => api.post('/tickets/drafts', data),
  getDraft: (id) => api.get(`/tickets/drafts/${id}`),
  deleteDraft: (id) => api.del(`/tickets/drafts/${id}`),
}
export const sedimentApi = {
  list: () => api.get('/sediments'),
  detail: (id) => api.get(`/sediments/${id}`),
  create: (data) => api.post('/sediments', data),
  edit: (id, data) => api.put(`/sediments/${id}`, data),
  toTicket: (id) => api.post(`/sediments/${id}/to-ticket`),
  update: (id, data) => api.post(`/sediments/${id}/update`, data),
  kpi: () => api.get('/sediments/stat/kpi'),
  distribution: () => api.get('/sediments/stat/distribution'),
  remove: (id) => api.del(`/sediments/${id}`),
  search: (params) => api.get(`/sediments/search${qs(params)}`),
  tags: () => api.get('/sediments/tags'),
}
export const tagApi = {
  list: (q) => api.get(`/tags${qs(q)}`),
  detail: (id) => api.get(`/tags/${id}`),
  overview: (q) => api.get(`/tags/overview${qs(q)}`),
  samples: (id, q) => api.get(`/tags/${id}/samples${qs(q)}`),
  trend: (id, q) => api.get(`/tags/${id}/trend${qs(q)}`),
  elementPrecision: (q) => api.get(`/tags/element-precision${qs(q)}`),
  exportExcel: (id, data) => downloadBlob(`/tags/${id}/export/excel`, data, `tag-${id}-fp-export.xlsx`),
}
export const overviewApi = {
  kpi: (q) => api.get(`/overview/kpi${qs(q)}`),
  trends: (q) => api.get(`/overview/trends${qs(q)}`),
  ranking: (q) => api.get(`/overview/ranking${qs(q)}`),
  industryDetail: (industry) => api.get(`/overview/industry-detail${qs({ industry })}`),
  elementDetail: (element) => api.get(`/overview/element-detail${qs({ element })}`),
crossAnalysis: (params) => api.get(`/overview/cross-analysis`, { params }),
  crossDetail: (industry, element, advertiser) => api.get(`/overview/cross-detail${qs({ industry, element, advertiser })}`),
  clusters: (q) => api.get(`/overview/clusters${qs(q)}`),
  clusterQuad: (q) => api.get(`/overview/cluster-quad${qs(q)}`),
  clusterElements: (q) => api.get(`/overview/cluster-elements${qs(q)}`),
  tagClusterCards: (q) => api.get(`/overview/tag-cluster-cards${qs(q)}`),
}
export const manageApi = {
  users: () => api.get('/manage/users'),
  updateUser: (id, data) => api.put(`/manage/users/${id}`, data),
  requests: () => api.get('/manage/requests'),
  applyRequest: (data) => api.post('/manage/requests', data),
  decideRequest: (id, decision) => api.put(`/manage/requests/${id}`, { decision }),
}
export const feedbackApi = {
  submit: (data) => api.post('/feedback', data),
  list: () => api.get('/feedback'),
  update: (id, data) => api.put(`/feedback/${id}`, data),
}
// 素材预分类：分类 / 归类 / 结论 / 导出
async function downloadBlob(path, body, filename) {
  const resp = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body || {}),
  })
  if (!resp.ok) {
    let msg = `导出失败 ${resp.status}`
    try { const j = await resp.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
export const materialApi = {
  categories: (tagId) => api.get(`/materials/${tagId}/categories`),
  addCategory: (tagId, data) => api.post(`/materials/${tagId}/categories`, data),
  updateCategory: (tagId, catId, data) => api.put(`/materials/${tagId}/categories/${catId}`, data),
  removeCategory: (tagId, catId) => api.del(`/materials/${tagId}/categories/${catId}`),
  assign: (tagId, items) => api.post(`/materials/${tagId}/assign`, { items }),
  getConclusion: (tagId) => api.get(`/materials/${tagId}/conclusion`),
  saveConclusion: (tagId, data) => api.post(`/materials/${tagId}/conclusion`, data),
  exportWord: (tagId, data) => downloadBlob(`/materials/${tagId}/export/word`, data, `material-classify-${tagId}.docx`),
  exportPdf: (tagId, data) => downloadBlob(`/materials/${tagId}/export/pdf`, data, `material-classify-${tagId}.pdf`),
  // 素材标注：每次标注追加一条（记录时间/标注人），全员可见、全部保留
  annotations: (tagId, sampleIds) => api.get(`/materials/${tagId}/annotations?sampleIds=${encodeURIComponent(Array.isArray(sampleIds) ? sampleIds.join(',') : sampleIds)}`),
  addAnnotation: (tagId, data) => api.post(`/materials/${tagId}/annotations`, data),
}
export const shareApi = {
  // 保存分享快照 -> { ok, shareId, expireDays }
  // data: { module, route, uiState, snapshot?, title?, expireDays? } 或兼容旧的 classify 结构
  create: (data) => api.post('/shares', data),
  // 拉取分享快照 -> { ok, shareId, owner, createdAt, expireDays, tagId, tagName, module, route, uiState, snapshot, title }
  get: (id) => api.get(`/shares/${id}`),
}
// 用户 UI 状态（跨设备延续）：服务端镜像前端各模块的操作状态
export const uiStateApi = {
  // 拉取全部 -> { ok, state: { key: value } }
  getAll: () => api.get('/ui-state'),
  // 批量写入 -> { ok, updated }
  putAll: (state) => api.put('/ui-state', { state }),
  // 删除单个 key
  remove: (key) => api.del(`/ui-state/${encodeURIComponent(key)}`),
}
export const auditApi = { list: () => api.get('/audit') }
export const notificationApi = {
  get: () => api.get('/notifications'),
  markRead: (type) => api.post('/notifications/read', { type }),
}
export const dashboardApi = { get: () => api.get('/dashboard') }
export const dataMetaApi = {
  get: () => api.get('/data-meta'),
  set: (data) => api.post('/data-meta', data),
  upload: (data) => api.post('/data-meta/upload', data),
  history: () => api.get('/data-meta/history'),
  // 分批上传（解决 413 请求体过大问题）
  uploadInit: (data) => api.post('/data-meta/upload-init', data),   // { tags, fileName, meta } -> { uploadId }
  uploadBatch: (data) => api.post('/data-meta/upload-batch', data), // { uploadId, samples } -> { uploaded }
  uploadFinalize: (data) => api.post('/data-meta/upload-finalize', data), // { uploadId } -> { tagCount, sampleCount }
  uploadAbort: (data) => api.post('/data-meta/upload-abort', data), // { uploadId }
  // AI评测分析表（策略_标签）数据集
  uploadPrecision: (data) => api.post('/data-meta/upload-precision', data), // { tags, samples?, fileName } -> { tagCount, sampleCount }
  // 合并上传（文件直传，根治前端 OOM）：前端直接发送文件二进制流，后端解析+合并
  // 大文件自动分片上传（≤2MB/片），绕过预览网关/nginx 的 body size 限制（413）
  // 小文件（≤2MB）仍走单次直传以减少网络往返
  uploadFile: async (file, { dataset, fileName, onProgress } = {}) => {
    const CHUNK_SIZE = 2 * 1024 * 1024 // 2MB per chunk
    const hdrs = authHeaders()
    const actualFileName = fileName || file.name

    // 小文件直传（≤ CHUNK_SIZE）
    if (file.size <= CHUNK_SIZE) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const qs = new URLSearchParams({ dataset: dataset || 'ai-eval', fileName: encodeURIComponent(actualFileName) })
        xhr.open('POST', `/api/data-meta/upload-file?${qs.toString()}`)
        xhr.responseType = 'json'
        Object.entries(hdrs).forEach(([k, v]) => xhr.setRequestHeader(k, v))
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        if (typeof onProgress === 'function') {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response && xhr.response.ok ? xhr.response : { ok: true, raw: xhr.response })
          } else {
            let msg = '上传失败'
            let diag = null
            try {
              msg = (xhr.response && xhr.response.error) || `HTTP ${xhr.status}`
              diag = (xhr.response && xhr.response.diag) || null
            } catch { msg = `HTTP ${xhr.status}` }
            const err = new Error(msg)
            if (diag) err.diag = diag
            reject(err)
          }
        }
        xhr.onerror = () => reject(new Error('网络错误，上传失败'))
        xhr.send(file)
      })
    }

    // 大文件分片上传
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    if (typeof onProgress === 'function') onProgress(0)

    // 1. 初始化
    const initQs = new URLSearchParams({ dataset: dataset || 'ai-eval', fileName: encodeURIComponent(actualFileName) })
    const initResp = await fetch(`/api/data-meta/upload-chunk-init?${initQs.toString()}`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!initResp.ok) throw new Error(`分片初始化失败: HTTP ${initResp.status}`)
    const { uploadId } = await initResp.json()
    if (!uploadId) throw new Error('分片初始化失败: 未获取到 uploadId')

    // 2. 逐片上传
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const chunk = file.slice(start, end)
      const chunkResp = await fetch(`/api/data-meta/upload-chunk?uploadId=${uploadId}`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/octet-stream' },
        body: chunk,
      })
      if (!chunkResp.ok) {
        const errBody = await chunkResp.json().catch(() => null)
        throw new Error(errBody?.error || `分片上传失败: HTTP ${chunkResp.status}`)
      }
      if (typeof onProgress === 'function') {
        // 上传进度 0~90%，最后 10% 留给 finalize 处理
        onProgress(Math.round(((i + 1) / totalChunks) * 90))
      }
    }

    // 3. 完成
    if (typeof onProgress === 'function') onProgress(90)
    const finalQs = new URLSearchParams({ uploadId })
    const finalResp = await fetch(`/api/data-meta/upload-chunk-finalize?${finalQs.toString()}`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const result = await finalResp.json().catch(() => null)
    if (!finalResp.ok || (result && !result.ok && result.error)) {
      const err = new Error(result?.error || `HTTP ${finalResp.status}`)
      if (result?.diag) err.diag = result.diag
      throw err
    }
    if (typeof onProgress === 'function') onProgress(100)
    return result
  },
  getPrecisionTags: () => api.get('/data-meta/precision-tags'), // -> tags[]
  getPrecisionSamples: (id) => api.get(`/data-meta/precision-tags/${id}/samples`), // -> samples[]
  // 删除已上传数据（可选 type: 'ai-eval' | 'tag-precision' | 'all'，默认 'all'）
  deleteData: (type) => api.del(`/data-meta${type ? `?type=${type}` : ''}`), // -> { ok, message }
  // 草稿区状态
  getDraftStatus: () => api.get('/data-meta/draft-status'), // -> { aiEval, tagPrecision }
  // 发布当前线上数据（登记版本快照，供回滚）
  publish: () => api.post('/data-meta/publish'), // -> { ok, versionId, message }
  // 回滚到上一版
  rollback: (versionId) => api.post('/data-meta/publish/rollback', versionId ? { versionId } : {}), // -> { ok, versionId, message }
  // 发布历史
  publishHistory: () => api.get('/data-meta/publish-history'), // -> [{ id, version, operator, publishedAt, source, note }]
  // 字段关联状态持久化（按数据集独立存储）
  getFieldStatus: (dataset) => api.get(`/data-meta/field-status${dataset ? `?dataset=${dataset}` : ''}`), // -> { fieldStatus: { fieldName: true/false } }
  saveFieldStatus: (data) => api.post('/data-meta/field-status', data), // { fieldStatus, dataset } -> { ok }
}

// BadCase分析：上传数据 API
export const classifyUploadApi = {
  // 上传数据 { tagId, tagName, fileName, samples, categories, supplements } -> { ok, sampleCount, classCount, samples, partialFailure?, failedBatches? }
  upload: (data) => api.post('/classify-upload/upload', data),
  // 重试失败批次 { tagId, tagName, fileName, failedSamples, categories?, supplements? } -> { ok, sampleCount, partialFailure?, failedBatches? }
  retryFailed: (data) => api.post('/classify-upload/retry-failed', data),
  // 分批上传单批数据 { tagId, samples } -> { ok, uploaded }
  uploadBatch: (data) => api.post('/classify-upload/batch', data),
  // 查询标签上传数据状态 -> { hasUploadedData, count, latestUpload }
  getStatus: (tagId) => api.get(`/classify-upload/${tagId}/status`),
  // 查询标签上传的样本数据 -> samples[]
  getSamples: (tagId) => api.get(`/classify-upload/${tagId}/samples`),
  // 查询上传历史（可选 tagId 过滤） -> history[]
  getHistory: (tagId) => api.get(`/classify-upload/history${tagId ? `?tagId=${tagId}` : ''}`),
  // 一键清空所有上传数据 -> { ok, message }
  clearAll: () => api.del('/classify-upload/all'),
  // 清空指定标签的上传数据 -> { ok, message }
  clearTag: (tagId) => api.del(`/classify-upload/${tagId}`),
  // 导出选中上传数据为 Excel -> Excel 文件流
  exportExcel: (tagId, data) => downloadBlob(`/classify-upload/${tagId}/export/excel`, data, `upload-tag-${tagId}-export.xlsx`),
}

// TRAG 相似素材检索 API
export const tragApi = {
  // 获取任务类型列表 -> [{task, label, input_type, desc}]
  tasks: () => api.get('/trag/tasks'),
  // 检索 { task, query, limit?, filter_expr?, tags?, first_industries?, second_industries?, group_by_video?, threshold? } -> { results, total, task, cached }
  search: (data) => api.post('/trag/search', data),
  // 导出 CSV { task, query, results } -> Blob 下载
  exportCsv: (data) => downloadBlob('/trag/export_csv', data, `trag_${data.task}_${Date.now()}.csv`),
  // 上传本地图片，返回可被 TRAG 回拉的 URL（契约 3.5 节）
  // 入参：FormData（字段名 file）或 { dataUrl, filename }
  uploadImage: (payload) => {
    if (payload instanceof FormData) {
      return api.post('/trag/upload_image', payload, { headers: { 'Content-Type': 'multipart/form-data' } })
    }
    return api.post('/trag/upload_image', payload)
  },
}

// 样本库精标数据 API（sample_library_fine_label 表）
export const badcaseApi = {
  hasData: () => api.get('/badcase/has-data'),
  stats: (labelId) => api.get(`/badcase/stats?labelId=${encodeURIComponent(labelId)}`),
  clusters: (labelId, sort) => api.get(`/badcase/clusters?labelId=${encodeURIComponent(labelId)}&sort=${sort || 'ratio'}`),
  histogram: (labelId) => api.get(`/badcase/histogram?labelId=${encodeURIComponent(labelId)}`),
  labels: () => api.get('/badcase/labels'),
  clusterElements: (clusterId, labelId) => api.get(`/badcase/clusters/${encodeURIComponent(clusterId)}/elements?labelId=${encodeURIComponent(labelId || '')}`),
  dataInsight: (tagId, params) => api.get(`/badcase/data-insight?tagId=${encodeURIComponent(tagId)}${qs(params)}`),
  // 聚类簇特征总结（标签下钻页）：读取 / 保存（可编辑套路）
  getClusterFeatures: (tagId) => api.get(`/badcase/cluster-features?tagId=${encodeURIComponent(tagId)}`),
  saveClusterFeature: (data) => api.post('/badcase/cluster-features', data),
}