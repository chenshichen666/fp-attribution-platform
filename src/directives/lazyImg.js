/**
 * v-lazy-img — 图片懒加载指令（IntersectionObserver + 并发限流）
 *
 * T0：采用「前端直链 + http→https 升级 + onerror 兜底」模式。
 * 机制：
 * 1. IntersectionObserver 只在图片进入可视区域（含预加载边距）时才设置 src
 * 2. 全局并发限制 MAX_LOADING=6，避免同时发起过多请求
 * 3. 加载失败时触发 error，由 onMediaError 显示「↗ 原素材」兜底链接
 *
 * 用法：
 *   <img v-lazy-img :data-src="url" @error="onMediaError" />
 *
 * 注意：data-src 应为原始素材 URL（指令内部做直链与协议升级处理）
 */
import { previewSrc, onMediaError } from '../utils/mediaPreview.js'

// 全局 IntersectionObserver，所有 v-lazy-img 共享
let _observer = null
// 正在加载中的图片数
let _loadingCount = 0
const MAX_LOADING = 6
const _pendingQueue = []

function _ensureObserver() {
  if (_observer) return _observer
  _observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target
          _observer.unobserve(el)
          _loadImg(el)
        }
      }
    },
    {
      rootMargin: '300px', // 提前 300px 开始加载，滚动时更流畅
      threshold: 0.01,
    }
  )
  return _observer
}

function _loadImg(el) {
  // 如果当前加载中的图片数已达上限，放入等待队列
  if (_loadingCount >= MAX_LOADING) {
    _pendingQueue.push(el)
    return
  }
  _loadingCount++
  const src = el.dataset.src
  if (!src) {
    _loadingCount--
    _processQueue()
    return
  }

  // 直链 + http→https 升级
  const finalSrc = previewSrc(src)
  el.dataset.rawUrl = src
  el.src = finalSrc

  let released = false
  const releaseSlot = () => {
    if (released) return
    released = true
    _loadingCount--
    _processQueue()
  }
  el.addEventListener('load', () => {
    // 检测极小占位响应（CDN 不可用时可能返回 1x1），触发 error 兜底
    if (el.naturalWidth <= 1 && el.naturalHeight <= 1) {
      el.dispatchEvent(new Event('error'))
    }
    releaseSlot()
  }, { once: true })
  el.addEventListener('error', () => {
    // 直链失败 → 显示「↗ 原素材」兜底链接
    onMediaError({ target: el })
    releaseSlot()
  }, { once: true })

  // 安全兜底：8 秒后强制释放名额
  setTimeout(releaseSlot, 8000)
}

function _processQueue() {
  if (_pendingQueue.length > 0 && _loadingCount < MAX_LOADING) {
    const next = _pendingQueue.shift()
    if (next && next.isConnected) {
      _loadImg(next)
    } else {
      // 元素已断开连接，递归处理下一个
      _processQueue()
    }
  }
}

export default {
  mounted(el) {
    const src = el.dataset.src
    if (!src) return

    // 浏览器不支持 IntersectionObserver → 回退为立即加载（同样走 previewSrc 直链 + 实体还原）
    if (!('IntersectionObserver' in window)) {
      el.src = previewSrc(src)
      return
    }

    const observer = _ensureObserver()
    observer.observe(el)
  },

  // 当 data-src 变化时（如 Vue 响应式更新），重新观察
  updated(el) {
    const src = el.dataset.src
    if (src && !el.src && _observer) {
      _observer.observe(el)
    }
  },

  // keep-alive 下组件被重新激活（离开页再回来）时，mounted 不会再次触发，
  // 已 unobserve 的元素不会再加载。重新观察以恢复懒加载（已加载过的不重复加载）。
  activated(el) {
    if (el.dataset.src && !el.src && _observer && !el.dataset.__mediaErrHandled) {
      _observer.observe(el)
    }
  },

  unmounted(el) {
    if (_observer) {
      _observer.unobserve(el)
    }
    const idx = _pendingQueue.indexOf(el)
    if (idx >= 0) _pendingQueue.splice(idx, 1)
  },
}
