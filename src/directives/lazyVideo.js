/**
 * v-lazy-video — 视频懒加载指令（IntersectionObserver）
 *
 * T0：采用「前端直链 + http→https 升级」模式。
 * 避免页面同时加载数十个视频打满后端代理并发限制导致 Resource loading error；
 * 必须签名的 CDN 直链失败时，由组件 @error 兜底显示「↗ 原素材」新标签逃生通道。
 * preload 设为 'metadata'（仅加载元数据），用户点击播放后才加载完整视频。
 *
 * 用法：
 *   <video v-lazy-video :data-src="url" controls playsinline muted
 *          @error="onErr(id)" @loadedmetadata="onMeta($event.target, id)" />
 */
import { previewSrc } from '../utils/mediaPreview.js'

function resolveSrc(url) {
  return previewSrc(url)
}

/**
 * 统一交互增强：对「带 controls 的原生 <video>」执行 hover 播放键包装。
 * - 保留浏览器原生 controls：进度条、播放/暂停、音量、全屏、下载等视频功能每个素材都要有
 * - 原生控制条 hover 显隐：光标移入预览区 controls=true（显示完整控制条），移出 controls=false（隐藏）
 *   —— 解决浏览器原生控制条「播放时常驻、不随光标移出隐藏」的问题，与确认的交互一致
 * - 包裹 .lvh 容器并插入居中播放/暂停圆钮（.lvh-btn），同样 hover 显隐
 * - 点击预览区（非控制条区域）：播放/暂停切换（播放时解除静音），并阻止冒泡
 * VideoPlayer 内部 video 不带 controls，走其自带播放器 UI，不会进入此分支。
 * @param {HTMLVideoElement} el
 */
function _enhanceHoverPlay(el) {
  if (el.__lvhEnhanced) return
  el.__lvhEnhanced = true

  const wrap = document.createElement('div')
  wrap.className = 'lvh'
  const btn = document.createElement('span')
  btn.className = 'lvh-btn'
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
  wrap.appendChild(btn)

  el.parentNode.insertBefore(wrap, el)
  wrap.appendChild(el)

  // 原生控制条初始隐藏（无论播放状态），完全跟随 hover 显隐
  el.controls = false

  // hover 显隐：移入显示原生控制条 + 中间播放键，移出延迟隐藏
  // 延迟隐藏：给原生「三个点」菜单、全屏等操作留缓冲，避免鼠标移出即关闭控制条/菜单
  let hideTimer = null
  function showControls() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    el.controls = true
    wrap.classList.add('lvh-hover')
  }
  function hideControls() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      el.controls = false
      wrap.classList.remove('lvh-hover')
    }, 400)
  }
  wrap.addEventListener('mouseenter', showControls)
  wrap.addEventListener('mouseleave', hideControls)
  // 移动端无 hover：触摸预览区时短暂显示控制条，触碰后保留，离开播放器区域自动隐藏
  wrap.addEventListener('touchstart', showControls, { passive: true })

  // 播放状态同步：播放中显示暂停图标，暂停/结束显示播放图标
  function syncBtn() {
    const isPlaying = !el.paused && !el.ended
    btn.classList.toggle('playing', isPlaying)
    btn.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
  }
  el.addEventListener('play', syncBtn)
  el.addEventListener('pause', syncBtn)
  el.addEventListener('ended', syncBtn)

  // 点击预览区：播放/暂停（播放时解除静音），阻止冒泡避免触发父级打开详情
  // 排除底部原生控制条区域（进度条/音量/全屏/三点菜单等）：该区域点击交给浏览器原生处理
  wrap.addEventListener('click', (e) => {
    const rect = wrap.getBoundingClientRect()
    const inControlBar = rect.width > 0 && (rect.bottom - e.clientY) < 56
    // 控制条区域（含原生全屏、三个点菜单、播放/暂停、音量按钮）完全不拦截，交给浏览器原生处理
    if (inControlBar) return
    e.preventDefault()
    e.stopPropagation()
    if (el.paused || el.ended) {
      el.muted = false
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  })
}

// 全局 IntersectionObserver，所有 v-lazy-video 共享
let _observer = null
// 正在加载中的视频数，限制同时发起的请求数
let _loadingCount = 0
const MAX_LOADING = 8
const _pendingQueue = []

function _ensureObserver() {
  if (_observer) return _observer
  _observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target
          _observer.unobserve(el)
          _loadVideo(el)
        }
      }
    },
    {
      rootMargin: '200px', // 提前 200px 开始加载，滚动时更流畅
      threshold: 0.01,
    }
  )
  return _observer
}

function _loadVideo(el) {
  // 如果当前加载中的视频数已达上限，放入等待队列
  if (_loadingCount >= MAX_LOADING) {
    _pendingQueue.push(el)
    return
  }
  _loadingCount++
  const src = el.dataset.src
  if (!src) { _loadingCount--; return }

  const finalSrc = resolveSrc(src)
  el.dataset.rawUrl = src
  el.src = finalSrc
  el.preload = 'metadata' // 只加载元数据，不预缓冲视频内容
  el.load()

  // metadata 就绪后 seek 到首帧，强制浏览器解码并渲染封面画面（避免纯色/黑底占位）
  el.addEventListener('loadedmetadata', () => {
    try {
      if (el.currentTime < 0.05 && isFinite(el.duration) && el.duration > 0.1) {
        el.currentTime = 0.1
      }
    } catch { /* seek 失败忽略，保留默认首帧 */ }
  }, { once: true })

  // 加载完成后释放名额，处理队列中的下一个
  let _released = false
  const releaseSlot = () => {
    if (_released) return
    _released = true
    _loadingCount--
    el.removeEventListener('loadedmetadata', releaseSlot)
    el.removeEventListener('error', releaseSlot)
    // 从队列取下一个
    if (_pendingQueue.length > 0 && _loadingCount < MAX_LOADING) {
      const next = _pendingQueue.shift()
      if (next && next.isConnected) {
        _loadVideo(next)
      }
    }
  }
  el.addEventListener('loadedmetadata', releaseSlot, { once: true })
  el.addEventListener('error', releaseSlot, { once: true })

  // 注意：不再用「超时主动派发 error」的方式兜底。
  // 业务数据里存在体积很大（数十~上百 MB）或非 fast-start（moov 原子在尾部）的视频，
  // 浏览器在收到足够数据前不会触发 loadedmetadata，可能远超过 10 秒；
  // 若此时伪造 error，组件的 @error 会移除 video 的 src 并降级为「打开原链接」，
  // 表现就是「预览不了」。因此仅做「超时释放并发名额」，绝不主动派发 error——
  // 真正的加载失败由浏览器原生 error 事件处理，未失败则继续等待播放（用户可先点播放）。
  setTimeout(() => {
    if (!_released) releaseSlot()
  }, 30000)
}

export default {
  mounted(el) {
    const src = el.dataset.src
    if (!src) return

    // 统一交互：原生 controls 缩略图 → hover 播放键（光标移入显示、移出隐藏）
    // VideoPlayer 内部 video 无 controls，走其自带播放器 UI，不在此列
    if (el.hasAttribute('controls')) {
      _enhanceHoverPlay(el)
    }

    // 如果浏览器不支持 IntersectionObserver，回退为立即加载
    if (!('IntersectionObserver' in window)) {
      const finalSrc = resolveSrc(src)
      el.dataset.rawUrl = src
      el.src = finalSrc
      el.preload = 'metadata'
      el.load()
      return
    }

    const observer = _ensureObserver()
    observer.observe(el)
  },

  // keep-alive 下组件被重新激活（离开页再回来）时，mounted 不会再次触发，
  // 已 unobserve 的元素不会再加载。重新观察以恢复懒加载（已加载过的不重复加载）。
  activated(el) {
    if (el.dataset.src && !el.src && _observer) {
      _observer.observe(el)
    }
  },

  unmounted(el) {
    if (_observer) {
      _observer.unobserve(el)
    }
    // 从待加载队列中移除
    const idx = _pendingQueue.indexOf(el)
    if (idx >= 0) _pendingQueue.splice(idx, 1)
  },
}
