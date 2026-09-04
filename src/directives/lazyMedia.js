/**
 * v-lazy-media — 媒体加载指令
 *
 * T0：采用「前端直链 + http→https 升级 + onerror 兜底」模式（对宽容 CDN 如 adsmind 一劳永逸）。
 * 必须签名的 CDN（微信视频等）直链失败时由 onMediaError 提供「↗ 原素材」新标签逃生通道。
 *
 * 图片：直接加载直链
 * 视频：不设置 src，改为插入封面占位图，用户点击播放时通过回调才设置 src
 *
 * 用法：
 *   <img v-lazy-media :data-src="url" />
 *   <video v-lazy-media :data-src="url" :data-poster="base64Thumb" @click="playVideo($event)" />
 */
import { previewSrc, onMediaError } from '../utils/mediaPreview.js'

function resolveSrc(url) {
  return previewSrc(url)
}

export default {
  mounted(el) {
    const src = el.dataset.src
    if (!src) return

    if (el.tagName === 'VIDEO') {
      // 视频：不设置 src，只显示封面图，点击后才加载
      const poster = el.dataset.poster
      if (poster) {
        el.poster = poster
      }
      // 存储直链供后续点击加载使用
      el._mediaSrc = resolveSrc(src)
      el.dataset.rawUrl = src
      // 监听自定义事件来触发加载
      el._loadVideo = () => {
        if (!el.src) {
          el.src = el._mediaSrc
          el.preload = 'auto'
          el.load()
        }
      }
      el._onError = (ev) => onMediaError(ev)
      el.addEventListener('click', el._loadVideo, { once: true })
      el.addEventListener('error', el._onError, { once: true })
    } else {
      // 图片：直链加载，失败时由 onMediaError 显示「↗ 原素材」兜底链接
      const finalSrc = resolveSrc(src)
      el.dataset.rawUrl = src
      el.src = finalSrc
      el.addEventListener('error', onMediaError, { once: true })
    }
    el.dataset.loaded = '1'
  },

  // keep-alive 下组件重新激活时，确保视频点击加载绑定仍生效（若之前被 once 消费后丢失）。
  activated(el) {
    if (el.tagName === 'VIDEO' && el.dataset.src && !el.src && !el._loadVideo) {
      const poster = el.dataset.poster
      if (poster) el.poster = poster
      el._mediaSrc = resolveSrc(el.dataset.src)
      el._loadVideo = () => {
        if (!el.src) {
          el.src = el._mediaSrc
          el.preload = 'auto'
          el.load()
        }
      }
      el._onError = (ev) => onMediaError(ev)
      el.addEventListener('click', el._loadVideo, { once: true })
      el.addEventListener('error', el._onError, { once: true })
    }
  },

  unmounted(el) {
    if (el._loadVideo) {
      el.removeEventListener('click', el._loadVideo)
    }
    if (el._onError) {
      el.removeEventListener('error', el._onError)
    }
  },
}
