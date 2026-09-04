<script setup>
import { ref, computed, watch } from 'vue'
import { ticketApi } from '../api'
import { useToastStore } from '../stores/toast'
import { previewSrc, rawHttpsUrlPlain, mediaProxyFallback, retryOriginalSrc, isVideoByUrl, isMediaUrl } from '../utils/mediaPreview.js'
import Icon from './Icon.vue'

const props = defineProps({
  visible: Boolean,
  ticket: { type: Object, default: null },
})
const emit = defineEmits(['update:visible', 'create-ticket'])

const toast = useToastStore()

// 任务类型：自动探测 + 8 种手动（与 TragSearchModal / 后端口径一致）
const TASK_TYPES = [
  { task: 'auto', label: '自动探测（推荐）' },
  { task: 'text_text', label: '文本→文本' },
  { task: 'image_image_shangshu', label: '图片→图片（商数）' },
  { task: 'image_ocr', label: '图片OCR→文本' },
  { task: 'video_video', label: '视频→视频' },
  { task: 'video_ocr', label: '视频OCR→文本' },
  { task: 'video_asr', label: '视频ASR→文本' },
  { task: 'video_patch_asr', label: '视频ASR片段→文本' },
  { task: 'video_frame', label: '图片→视频风险帧' },
]

// 检索配置
const threshold = ref(0.85)
const resultLimit = ref(10)
const taskType = ref('auto')

// 样本库状态
const items = ref([])
const total = ref(0)
const loading = ref(false)
const searching = ref(false)
const error = ref('')
const selectedIds = ref(new Set())
const mediaErr = ref(new Set())

const ticketId = computed(() => props.ticket?.id || '')
const selectedCount = computed(() => selectedIds.value.size)
const selectedItems = computed(() => items.value.filter((i) => selectedIds.value.has(i.id)))

function safeUrl(url) { return previewSrc(url) }

function onMediaErr(id, e) {
  const el = e && e.target
  if (el && el.tagName === 'IMG' && retryOriginalSrc(el)) return
  if (el && mediaProxyFallback(el)) return
  if (mediaErr.value.has(id)) return
  mediaErr.value.add(id); mediaErr.value = new Set(mediaErr.value)
}

function scoreColor(s) {
  const v = Number(s) || 0
  if (v >= 0.9) return '#16a34a'
  if (v >= 0.8) return '#4f7cff'
  if (v >= 0.7) return '#f59e0b'
  return '#94a3b8'
}
function fmtScore(s) {
  const v = Number(s) || 0
  return `${Math.round(v * 100)}%`
}

function typeLabel(t) {
  if (!t) return '素材'
  if (t === '图片' || t === 'image') return '图片'
  if (t === '视频' || t === 'video') return '视频'
  if (t === '文本' || t === 'text') return '文本'
  return t
}

async function loadLibrary() {
  if (!ticketId.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await ticketApi.similarLibrary(ticketId.value)
    items.value = Array.isArray(data?.items) ? data.items : []
    total.value = data?.total || items.value.length
    selectedIds.value = new Set(items.value.filter((i) => i.selected).map((i) => i.id))
  } catch (e) {
    error.value = e.message || '加载相似样本库失败'
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function doSearch() {
  if (!ticketId.value) return
  searching.value = true
  error.value = ''
  try {
    const data = await ticketApi.similarSearch(ticketId.value, {
      threshold: Number(threshold.value) || 0,
      limit: Number(resultLimit.value) || 10,
      taskType: taskType.value,
    })
    items.value = Array.isArray(data?.items) ? data.items : []
    total.value = data?.total || items.value.length
    selectedIds.value = new Set(items.value.filter((i) => i.selected).map((i) => i.id))
    toast.success(`检索完成，共命中 ${total.value} 条相似样本`)
  } catch (e) {
    error.value = e.message || '相似检索失败'
  } finally {
    searching.value = false
  }
}

async function toggleSelect(item) {
  const id = item.id
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  selectedIds.value = next
  try {
    await ticketApi.selectSimilarSamples(ticketId.value, { ids: [id], selected: next.has(id) })
  } catch { /* 勾选持久化失败不阻断交互 */ }
}

function toggleAll() {
  if (!items.value.length) return
  const allSelected = selectedCount.value === items.value.length
  const ids = items.value.map((i) => i.id)
  const next = allSelected ? new Set() : new Set(ids)
  selectedIds.value = next
  ticketApi.selectSimilarSamples(ticketId.value, { ids, selected: !allSelected }).catch(() => {})
}

async function clearLibrary() {
  if (!total.value) { toast.info('样本库已为空'); return }
  if (!window.confirm('确认清空该工单的相似样本库？清空后需重新检索。')) return
  try {
    await ticketApi.clearSimilarLibrary(ticketId.value)
    items.value = []
    total.value = 0
    selectedIds.value = new Set()
    toast.success('相似样本库已清空')
  } catch (e) {
    toast.error(e.message || '清空失败')
  }
}

function toTicketSample(item) {
  const url = item.elementValue || ''
  const vid = isVideoByUrl(url)
  return {
    id: `sim-${item.id}`,
    mediaUrl: url,
    type: vid ? 'video' : 'image',
    ocr: item.ocrContent || '',
    asr: item.asrContent || '',
    dcId: item.dcId || '',
    opsAdvertiserName: item.opsAdvertiserName || '',
    elementFingerprint: item.elementFingerprint || '',
    aiEvaluateReviewerName: '',
    similarityScore: item.score,
    fromSimilarLibrary: true,
    seedFingerprint: item.seedFingerprint || '',
    taskType: item.taskType || '',
    policyIds: Array.isArray(item.policyIds) ? item.policyIds.join(',') : '',
    aiEvaluatePolicyIds: Array.isArray(item.aiEvaluatePolicyIds) ? item.aiEvaluatePolicyIds.join(',') : '',
  }
}

function createTicket() {
  if (!selectedCount.value) { toast.warn('请先勾选相似样本'); return }
  emit('create-ticket', {
    samples: selectedItems.value.map(toTicketSample),
    tagId: props.ticket?.tagId || '',
    tag: props.ticket?.tag || '',
    elementType: props.ticket?.elementType || '',
    industryL1: props.ticket?.industryL1 || '',
    industryL2: props.ticket?.industryL2 || '',
    parentTicketId: ticketId.value,
  })
  emit('update:visible', false)
}

function close() {
  emit('update:visible', false)
}

watch(() => props.visible, (v) => {
  if (v) {
    selectedIds.value = new Set()
    loadLibrary()
  }
})
</script>

<template>
  <teleport to="body">
    <transition name="pop">
      <div v-if="visible" class="slm-mask" @click.self="close">
        <div class="slm-modal">
          <div class="slm-hd">
            <div class="slm-title">
              <Icon name="database" :size="18" />
              <h3>相似样本库</h3>
              <span v-if="ticket" class="slm-ticket">来源工单 {{ ticket.id }}</span>
            </div>
            <button class="slm-x" @click="close"><Icon name="close" :size="20" /></button>
          </div>

          <div class="slm-bd">
            <!-- 检索配置区 -->
            <div class="slm-config">
              <div class="cfg-row">
                <label>任务类型</label>
                <select v-model="taskType">
                  <option v-for="t in TASK_TYPES" :key="t.task" :value="t.task">{{ t.label }}</option>
                </select>
              </div>
              <div class="cfg-row">
                <label>相似阈值</label>
                <input type="number" v-model="threshold" min="0" max="1" step="0.05" />
              </div>
              <div class="cfg-row">
                <label>每条样本命中数</label>
                <select v-model="resultLimit">
                  <option :value="5">5</option>
                  <option :value="10">10</option>
                  <option :value="20">20</option>
                  <option :value="50">50</option>
                </select>
              </div>
              <button class="btn btn-primary btn-sm" :disabled="searching" @click="doSearch">
                <Icon name="refresh" :size="14" />
                {{ searching ? '检索中…' : '检索相似样本' }}
              </button>
            </div>

            <!-- 工具条 -->
            <div class="slm-bar">
              <span class="slm-count">
                已选 <b>{{ selectedCount }}</b> / {{ total }} 条
              </span>
              <div class="slm-actions">
                <button class="btn btn-ghost btn-xs" @click="toggleAll">
                  <Icon name="check" :size="13" />{{ selectedCount === items.length && items.length ? '取消全选' : '全选' }}
                </button>
                <button class="btn btn-ghost btn-xs" :disabled="!total" @click="clearLibrary">
                  <Icon name="trash" :size="13" />清空
                </button>
              </div>
            </div>

            <!-- 状态提示 -->
            <div v-if="loading" class="slm-state"><span class="spin"></span>正在加载样本库…</div>
            <div v-else-if="searching" class="slm-state"><span class="spin"></span>正在检索相似样本，请稍候…</div>
            <div v-else-if="error" class="slm-state slm-error">{{ error }}</div>
            <div v-else-if="!items.length" class="slm-state">
              <Icon name="search" :size="30" />
              <p>暂无相似样本，点击上方「检索相似样本」基于工单样本自动检索</p>
            </div>

            <!-- 样本列表 -->
            <div v-else class="slm-list">
              <div v-for="item in items" :key="item.id" class="slm-item" :class="{ on: selectedIds.has(item.id) }">
                <label class="slm-check" @click.stop>
                  <input type="checkbox" :checked="selectedIds.has(item.id)" @change="toggleSelect(item)" />
                  <span class="slm-checkbox"><Icon v-if="selectedIds.has(item.id)" name="check" :size="12" /></span>
                </label>

                <!-- 素材预览 -->
                <div class="slm-thumb">
                  <video v-if="isVideoByUrl(item.elementValue) && !mediaErr.has('v'+item.id) && isMediaUrl(item.elementValue)"
                    :src="safeUrl(item.elementValue)" :data-raw-url="item.elementValue" muted controls playsinline
                    @error="onMediaErr('v'+item.id, $event)" @click.stop />
                  <img v-else-if="!isVideoByUrl(item.elementValue) && item.elementValue && !mediaErr.has('v'+item.id) && isMediaUrl(item.elementValue)"
                    :src="safeUrl(item.elementValue)" :data-raw-url="item.elementValue" alt="" @error="onMediaErr('v'+item.id, $event)" @click.stop />
                  <a v-else-if="item.elementValue" class="slm-link" :href="rawHttpsUrlPlain(item.elementValue)" target="_blank" @click.stop>
                    <Icon name="link" :size="18" />
                  </a>
                  <div v-else class="slm-thumb-text">{{ (item.ocrContent || item.asrContent || '文本').slice(0, 30) }}</div>
                </div>

                <!-- 信息 -->
                <div class="slm-info">
                  <div class="slm-info-top">
                    <span class="badge badge-gray">{{ typeLabel(item.elementType) }}</span>
                    <span class="slm-score" :style="{ color: scoreColor(item.score) }">{{ fmtScore(item.score) }}</span>
                    <span v-if="item.taskType" class="slm-task">{{ item.taskType }}</span>
                  </div>
                  <div class="slm-tags" v-if="item.policyIds && item.policyIds.length">
                    <span class="tag-lb">机审</span>
                    <span class="tag-pill" v-for="(p, i) in item.policyIds" :key="'m'+i">{{ p }}</span>
                  </div>
                  <div class="slm-tags" v-if="item.aiEvaluatePolicyIds && item.aiEvaluatePolicyIds.length">
                    <span class="tag-lb">人审</span>
                    <span class="tag-pill tag-pill-human" v-for="(p, i) in item.aiEvaluatePolicyIds" :key="'h'+i">{{ p }}</span>
                  </div>
                  <div class="slm-ocr" v-if="item.ocrContent || item.asrContent" :title="item.ocrContent || item.asrContent">
                    {{ (item.ocrContent || item.asrContent).slice(0, 60) }}{{ (item.ocrContent || item.asrContent).length > 60 ? '…' : '' }}
                  </div>
                  <div class="slm-fp" v-if="item.elementFingerprint">
                    <Icon name="copy" :size="12" />
                    <span class="mono">{{ item.elementFingerprint.slice(0, 24) }}{{ item.elementFingerprint.length > 24 ? '…' : '' }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="slm-ft">
            <button class="btn btn-primary" :disabled="!selectedCount" @click="createTicket">
              <Icon name="ticket" :size="15" />发起问题提需（已选 {{ selectedCount }} 条）
            </button>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
.slm-mask { position: fixed; inset: 0; background: rgba(20,26,40,.45); backdrop-filter: blur(3px); z-index: 1000; display: grid; place-items: center; padding: 20px; }
.slm-modal { background: #fff; border-radius: 18px; box-shadow: var(--shadow-lg); width: 860px; max-width: 94vw; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; }
.slm-hd { display: flex; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid var(--border); }
.slm-title { display: flex; align-items: center; gap: 10px; color: var(--brand); }
.slm-title h3 { font-size: 17px; font-weight: 700; color: var(--text-1); }
.slm-ticket { font-size: 12px; color: var(--text-3); background: var(--bg-soft); padding: 2px 10px; border-radius: 20px; }
.slm-x { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; color: var(--text-3); transition: all .18s; }
.slm-x:hover { background: #f0f2f6; color: var(--text-1); }

.slm-bd { padding: 20px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.slm-config { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; padding: 16px; background: var(--bg-soft); border-radius: 12px; }
.cfg-row { display: flex; flex-direction: column; gap: 6px; }
.cfg-row label { font-size: 12px; color: var(--text-3); font-weight: 600; }
.cfg-row select, .cfg-row input {
  height: 36px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 9px;
  background: #fff; font-size: 13px; color: var(--text-1); outline: none; min-width: 120px; transition: all .18s;
}
.cfg-row input { width: 100px; }
.cfg-row select:hover, .cfg-row input:hover { border-color: var(--brand); }
.cfg-row select:focus, .cfg-row input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.slm-config .btn { margin-left: auto; }

.slm-bar { display: flex; align-items: center; justify-content: space-between; }
.slm-count { font-size: 13px; color: var(--text-2); }
.slm-count b { color: var(--brand); font-size: 15px; }
.slm-actions { display: flex; gap: 8px; }

.slm-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 0; color: var(--text-3); font-size: 13px; text-align: center; }
.slm-state .spin { width: 20px; height: 20px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: lspin .7s linear infinite; }
.slm-state p { max-width: 360px; line-height: 1.7; }
.slm-error { color: var(--red); }
@keyframes lspin { to { transform: rotate(360deg); } }

.slm-list { display: flex; flex-direction: column; gap: 10px; }
.slm-item { display: flex; align-items: flex-start; gap: 14px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; transition: all .18s; }
.slm-item:hover { border-color: var(--brand); }
.slm-item.on { border-color: var(--brand); background: var(--brand-soft); }

.slm-check { display: flex; align-items: center; cursor: pointer; flex-shrink: 0; padding-top: 6px; }
.slm-check input { display: none; }
.slm-checkbox { width: 20px; height: 20px; border: 2px solid var(--border-strong); border-radius: 6px; display: grid; place-items: center; color: #fff; transition: all .15s; }
.slm-check input:checked + .slm-checkbox { background: var(--brand); border-color: var(--brand); }

.slm-thumb { width: 88px; height: 66px; border-radius: 9px; overflow: hidden; background: var(--bg-soft); border: 1px solid var(--border); display: grid; place-items: center; flex-shrink: 0; }
.slm-thumb img, .slm-thumb video { width: 100%; height: 100%; object-fit: cover; }
.slm-link { color: var(--brand); }
.slm-thumb-text { font-size: 11px; color: var(--text-3); padding: 6px; text-align: center; overflow: hidden; }

.slm-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.slm-info-top { display: flex; align-items: center; gap: 8px; }
.slm-score { font-size: 14px; font-weight: 700; }
.slm-task { font-size: 11px; color: var(--text-4); background: var(--bg-soft); padding: 1px 7px; border-radius: 6px; }
.slm-tags { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.tag-lb { font-size: 11px; color: var(--text-4); }
.tag-pill { font-size: 11px; padding: 1px 8px; border-radius: 6px; background: #fff4e0; color: #b67400; }
.tag-pill-human { background: #eef2ff; color: var(--brand); }
.slm-ocr { font-size: 12px; color: var(--text-2); line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slm-fp { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-4); }
.mono { font-family: monospace; }

.slm-ft { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; background: var(--bg-soft); }
</style>
