/**
 * 环境检测工具：判断当前前端运行在 With 平台（草稿/预览）还是线上正式环境
 *
 * - With 平台预览域名：*.preview.platform.example.com / *.devnet-preview.platform.example.com / *.test-preview.platform.example.com
 *   → isPreview = true，显示草稿相关 UI（上传写草稿表、回滚、放弃草稿、草稿状态展示）
 * - 线上正式域名：其他所有域名
 *   → isPreview = false，隐藏草稿/发布 UI，仅显示正式数据状态，上传直接写正式表
 *
 * 允许手动覆盖（便于调试）：localStorage 设置 fp_data_mode=draft/prod
 */

const PREVIEW_HOST_PATTERNS = [
  /(^|\.)preview\.with\.woa\.com$/,
  /(^|\.)devnet-preview\.with\.woa\.com$/,
  /(^|\.)test-preview\.with\.woa\.com$/,
]

function getHostname() {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.hostname || ''
  }
  return ''
}

export function isPreviewEnv() {
  const host = getHostname()
  // 允许手动覆盖（便于调试）
  try {
    const override = localStorage.getItem('fp_data_mode')
    if (override === 'prod') return false
    if (override === 'draft') return true
  } catch { /* ignore */ }
  return PREVIEW_HOST_PATTERNS.some(re => re.test(host))
}

export function dataMode() {
  return isPreviewEnv() ? 'draft' : 'prod'
}
