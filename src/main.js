import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import router from './router'
import tip from './directives/tip'
import autosize from './directives/autosize'
import lazyMedia from './directives/lazyMedia'
import lazyVideo from './directives/lazyVideo'
import lazyImg from './directives/lazyImg'

// 屏蔽浏览器无害告警："ResizeObserver loop completed with undelivered notifications"
// 该告警由 ECharts 等组件在容器尺寸变化时触发，不影响功能，但会污染控制台并触发 dev overlay
const RO_MSG = 'ResizeObserver loop'
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes(RO_MSG)) {
    e.stopImmediatePropagation()
    e.preventDefault()
  }
})

// 静默「媒体资源加载失败」冒泡到 window 的错误事件。
// 这类事件对象无 message/stack（属性不可枚举），被外部错误采集器序列化后会显示成空对象 {}，
// 造成无法定位的噪声。实际的图片/视频加载失败已由各组件 @error / onMediaError 局部兜底
// （切换到「↗ 原素材」逃生链接），无需再作为全局错误上报。
// 注意：资源加载错误不冒泡，必须在捕获阶段（第三参 true）拦截。
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'TRACK'])
window.addEventListener(
  'error',
  (e) => {
    const t = e && e.target
    if (t && t.tagName && MEDIA_TAGS.has(t.tagName) && !e.message) {
      e.stopImmediatePropagation()
      // 资源错误不可 preventDefault 取消加载，此处仅阻断向采集器冒泡的噪声
      return false
    }
  },
  true,
)

// 静默未处理的 Promise 拒绝中「空对象 / 无信息」的噪声（例如被 catch(()=>{}) 场景外溢的空 reason）。
// 有实际信息的 rejection 仍会正常抛出，便于排查。
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason
  const isEmpty =
    r == null ||
    (typeof r === 'object' && !(r instanceof Error) && Object.keys(r).length === 0)
  if (isEmpty) {
    e.preventDefault()
  }
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.directive('tip', tip)
app.directive('autosize', autosize)
app.directive('lazy-media', lazyMedia)
app.directive('lazy-video', lazyVideo)
app.directive('lazy-img', lazyImg)
app.mount('#app')