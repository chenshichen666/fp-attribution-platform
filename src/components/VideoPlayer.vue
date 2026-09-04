<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { onMediaError } from '../utils/mediaPreview'

/**
 * 通用视频播放器（内嵌预览）
 * - 中间大播放键（暂停时显示播放，播放时显示暂停，点击可切换）
 * - 底部控制条：进度条（点击可跳转进度）、倍速、音量、画中画、全屏放大、下载
 * - 控制条与中间按键跟随 hover 显隐（光标移入预览区显示、移出隐藏），播放中控制条常驻
 * - fit: cover 铺满裁剪 / contain 完整显示（单素材 case 使用 contain 看完整内容）
 * - 保留 v-lazy-video 懒加载与 onMediaError 三层兜底
 */
const props = defineProps({
  src: { type: String, required: true },
  rawUrl: { type: String, default: '' },
  muted: { type: Boolean, default: true },
  showSpeed: { type: Boolean, default: true },
  fit: { type: String, default: 'cover' }, // 'cover' | 'contain'
  autoRatio: { type: Boolean, default: false }, // 按视频原始宽高比自适应容器高度，完整呈现视频内容
})

const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const speed = ref(1)
const volume = ref(1)
const isMuted = ref(props.muted)
const pipActive = ref(false)
const fullscreen = ref(false)
const SPEED_OPTIONS = [1, 1.5, 2, 3, 0.5]
const videoEl = ref(null)
const videoSize = ref(null) // { w, h } 视频原始宽高，用于 autoRatio

const vpStyle = computed(() => {
  if (fullscreen.value) return {}
  if (!props.autoRatio || !videoSize.value) return {}
  const { w, h } = videoSize.value
  if (!w || !h) return {}
  return { aspectRatio: `${w} / ${h}`, height: 'auto', maxHeight: '100%' }
})

const pct = computed(() => {
  if (!duration.value) return 0
  return Math.min(Math.max((currentTime.value / duration.value) * 100, 0), 100)
})

function onPlay() { playing.value = true }
function onPause() { playing.value = false }
function onEnded() { playing.value = false; currentTime.value = duration.value }
function onTime(e) {
  const v = e.target
  currentTime.value = v.currentTime || 0
  duration.value = v.duration || 0
}
function onMeta(e) {
  const v = e.target
  onTime(e)
  if (v.videoWidth && v.videoHeight) videoSize.value = { w: v.videoWidth, h: v.videoHeight }
}
function onVolumeChange(e) {
  const v = e.target
  volume.value = v.volume || 0
  isMuted.value = v.muted
}

// 点击视频区域：播放/暂停（播放时解除静音）
function toggle() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) {
    el.muted = false
    el.play().catch(() => {})
  } else {
    el.pause()
  }
}

// 点击进度条跳转
function seek(e) {
  const el = videoEl.value
  const wrap = e.currentTarget
  if (!el || !wrap || !duration.value) return
  const rect = wrap.getBoundingClientRect()
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
  el.currentTime = ratio * duration.value
}

// 循环切换倍速，并同步到 video 元素
function cycleSpeed() {
  const idx = SPEED_OPTIONS.indexOf(speed.value)
  speed.value = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
  const el = videoEl.value
  if (el) el.playbackRate = speed.value
}

// 静音 / 取消静音
function toggleMute() {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
}

// 音量滑块
function onVol(e) {
  const el = videoEl.value
  if (!el) return
  const v = parseFloat(e.target.value)
  if (!isFinite(v)) return
  el.volume = v
  el.muted = v === 0
}

// 画中画：进入/退出系统 PiP
async function togglePip() {
  const el = videoEl.value
  if (!el) return
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture()
    } else {
      if (el.paused) { el.muted = false; await el.play().catch(() => {}) }
      await el.requestPictureInPicture()
    }
  } catch { /* PiP 不可用时静默忽略 */ }
}
function onEnterPip() { pipActive.value = true }
function onLeavePip() { pipActive.value = false }

// 全屏放大 / 退出全屏：CSS 模拟全屏（iframe 内原生 requestFullscreen 受 allowfullscreen 限制，
// 改为 position:fixed 铺满视口，兼容预览网关 iframe 环境，全屏按钮真正可用）
function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
}
function onKeydown(e) {
  if (e.key === 'Escape' && fullscreen.value) fullscreen.value = false
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="vp" :class="{ playing, pip: pipActive, full: fullscreen }" :style="vpStyle" @click="toggle">
    <video
      ref="videoEl"
      v-lazy-video
      :data-src="src"
      :data-raw-url="rawUrl || src"
      playsinline
      :muted="muted"
      :style="{ objectFit: fullscreen ? 'contain' : fit }"
      @play="onPlay"
      @pause="onPause"
      @timeupdate="onTime"
      @loadedmetadata="onMeta"
      @volumechange="onVolumeChange"
      @ended="onEnded"
      @error="onMediaError"
      @enterpictureinpicture="onEnterPip"
      @leavepictureinpicture="onLeavePip"
    ></video>

    <!-- 中间播放键：暂停时显示 ▶，播放时显示 ❚❚（可点击暂停），跟随 hover 显隐 -->
    <span v-if="!playing" class="vp-play" @click.stop="toggle">
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </span>
    <span v-else class="vp-pause" @click.stop="toggle">
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </span>

    <!-- 底部控制条：进度 + 倍速 + 音量 + 画中画 + 全屏 + 下载（hover 显隐，播放中常驻） -->
    <div class="vp-bar" @click.stop>
      <div class="vp-progress" @click="seek" :title="`${Math.round(pct)}%`"><i :style="{ width: pct + '%' }"></i></div>
      <button v-if="showSpeed" class="vp-speed" @click.stop="cycleSpeed" :title="'切换播放速度'">{{ speed }}x</button>
      <button class="vp-btn" @click.stop="toggleMute" :title="isMuted ? '取消静音' : '静音'">
        <svg v-if="isMuted" viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8l6 6M22 8l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <svg v-else viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 010 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <input class="vp-vol" type="range" min="0" max="1" step="0.05" :value="volume" @input="onVol" @change="onVol" @click.stop :title="'音量 ' + Math.round(volume * 100) + '%'" />
      <button class="vp-btn" :class="{ on: pipActive }" @click.stop="togglePip" :title="pipActive ? '退出画中画' : '画中画播放'">
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M19 11h-8v6h8v-6zm4 8V5c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 0H3V5h18v14z"/></svg>
      </button>
      <button class="vp-btn" :class="{ on: fullscreen }" @click.stop="toggleFullscreen" :title="fullscreen ? '退出全屏' : '全屏放大'">
        <svg v-if="!fullscreen" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3"/></svg>
        <svg v-else viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4H5a2 2 0 00-2 2v4M15 4h4a2 2 0 012 2v4M9 20H5a2 2 0 01-2-2v-4M15 20h4a2 2 0 002-2v-4"/></svg>
      </button>
      <a class="vp-btn" :href="rawUrl || src" target="_blank" rel="noopener" @click.stop :title="'下载 / 打开原视频'">
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 19h16"/></svg>
      </a>
    </div>
  </div>
</template>

<style scoped>
.vp { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: pointer; background: #000; }
.vp video { width: 100%; height: 100%; object-fit: cover; display: block; background: #000; }

/* CSS 模拟全屏：fixed 铺满视口（iframe 内原生 fullscreen 受限时仍可用） */
.vp.full { position: fixed; inset: 0; z-index: 9999; width: 100vw; height: 100vh; border-radius: 0; }
.vp.full .vp-bar { opacity: 1; }

/* 中间播放/暂停键 */
.vp-play {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 3; width: 40px; height: 40px; border-radius: 50%;
  display: grid; place-items: center; color: #fff;
  background: rgba(20, 24, 34, .55); border: 1.5px solid rgba(255, 255, 255, .4);
  backdrop-filter: blur(4px); pointer-events: none;
  opacity: 0; transition: opacity .18s, transform .18s, background .18s;
}
.vp-play svg { width: 20px; height: 20px; margin-left: 2px; }
.vp:hover .vp-play { opacity: 1; background: rgba(79, 124, 255, .9); border-color: rgba(255, 255, 255, .6); transform: translate(-50%, -50%) scale(1.08); }

.vp-pause {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 3; width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center; color: #fff;
  background: rgba(20, 24, 34, .4); border: 1px solid rgba(255, 255, 255, .35);
  backdrop-filter: blur(4px); opacity: 0; pointer-events: none;
  transition: opacity .18s;
}
.vp-pause svg { width: 14px; height: 14px; }
.vp:hover .vp-pause { opacity: 1; }

/* 底部控制条 + 倍速 */
.vp-bar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 4;
  display: flex; align-items: center; gap: 6px; padding: 8px 8px 7px;
  background: linear-gradient(180deg, transparent, rgba(12, 16, 26, .68));
  opacity: 0; transition: opacity .18s;
}
.vp:hover .vp-bar { opacity: 1; }
.vp-progress {
  flex: 1; height: 4px; border-radius: 3px; background: rgba(255, 255, 255, .32);
  overflow: hidden; cursor: pointer;
}
.vp-progress i { display: block; height: 100%; border-radius: 3px; background: var(--brand, #4f7cff); transition: width .12s linear; }
.vp-speed {
  flex-shrink: 0; min-width: 34px; padding: 2px 7px; border-radius: 7px;
  background: rgba(20, 24, 34, .6); color: #fff; font-size: 11px; font-weight: 700;
  border: 1px solid rgba(255, 255, 255, .3); cursor: pointer;
  backdrop-filter: blur(4px); transition: all .15s; line-height: 1.4;
}
.vp-speed:hover { background: rgba(79, 124, 255, .9); border-color: rgba(255, 255, 255, .5); }

/* 通用控制按钮（音量 / 画中画 / 全屏 / 下载） */
.vp-btn {
  flex-shrink: 0; width: 24px; height: 24px; padding: 3px; border-radius: 7px;
  background: rgba(20, 24, 34, .6); color: #fff;
  border: 1px solid rgba(255, 255, 255, .3); cursor: pointer;
  backdrop-filter: blur(4px); transition: all .15s; display: grid; place-items: center;
  text-decoration: none;
}
.vp-btn svg { width: 14px; height: 14px; }
.vp-btn:hover, .vp-btn.on { background: rgba(79, 124, 255, .9); border-color: rgba(255, 255, 255, .5); }
.vp.pip .vp-pip { background: rgba(79, 124, 255, .9); border-color: rgba(255, 255, 255, .5); }

/* 音量滑块 */
.vp-vol {
  flex-shrink: 0; width: 52px; height: 4px; accent-color: var(--brand, #4f7cff);
  cursor: pointer; background: transparent; border: none; margin: 0;
}
</style>
