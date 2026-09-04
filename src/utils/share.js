import { shareApi } from '../api'

// 通用分享工具：把「当前页面的样子」复制成链接，对方打开即还原到同一模块同一操作位置。
// 收集哪些 UI 状态参与分享，由调用方（各模块）通过 getUiState() 提供。

// 模块路由映射：模块名 → 路由 name / 打开该模块的基础 path
const MODULE_ROUTE = {
  analysis: '/analysis',
  classify: '/classify',
  tickets: '/tickets',
  sediment: '/sediment',
}

// 生成分享链接：把当前模块 + 路由 + UI 状态快照存到服务端，复制 URL。
// @param {Object} opts
//   module: 'analysis'|'classify'|'tickets'|'sediment'
//   uiState: { [key]: value } 当前模块的操作状态快照（筛选/时间窗口/打开的弹窗 id 等）
//   snapshot?: 自包含数据快照（如 classify 旧结构：素材+分类+标注）
//   title?: 分享标题
//   expireDays?: 7|30|90|0
// @returns {Promise<{url:string, expireDays:number}>}
export async function createShareLink({ module, uiState = {}, snapshot = null, title = '', expireDays = 30 }) {
  const route = MODULE_ROUTE[module] || '/'
  const res = await shareApi.create({ module, route, uiState, snapshot, title, expireDays })
  if (!res?.shareId) throw new Error('分享创建失败')
  const url = `${window.location.origin}${window.location.pathname}#${route}?share=${res.shareId}`
  try { await navigator.clipboard?.writeText(url) } catch { /* 剪贴板不可用时由调用方提示手动复制 */ }
  return { url, expireDays: res.expireDays }
}

// 解析当前 URL 中的分享 shareId（若有）
export function getShareIdFromUrl() {
  try {
    const hash = window.location.hash || ''
    const qIdx = hash.indexOf('?')
    if (qIdx < 0) return ''
    const params = new URLSearchParams(hash.slice(qIdx + 1))
    return params.get('share') || ''
  } catch {
    return ''
  }
}

// 从分享快照打开：拉取并调用 apply 回调还原 UI 状态
export async function openShare(shareId, apply) {
  const res = await shareApi.get(shareId)
  if (apply) await apply(res)
  return res
}
