<script setup>
import { ref, computed } from 'vue'
import { useToastStore } from '../../stores/toast'
import Icon from '../../components/Icon.vue'

const props = defineProps({ samples: Array, loadedTag: Object })
const toast = useToastStore()

// 素材数量
const sampleCount = computed(() => (props.samples || []).length)

// 素材类型分布（用于概览）
const typeStats = computed(() => {
  const m = {}
  for (const s of (props.samples || [])) {
    const t = s.elementTypeName ?? s.type ?? '未分类'
    m[t] = (m[t] || 0) + 1
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1])
})

// 素材预览列表（前 6 条）
const previewSamples = computed(() => (props.samples || []).slice(0, 6))

// 统一字段提取
function getOcr(s) { return s.ocrContent ?? s.osr ?? '' }
function getAsr(s) { return s.asrContent ?? '' }
function getType(s) { return s.elementTypeName ?? s.type ?? '图片' }

// OCR/ASR 折叠状态：expandedRows[i] = { ocr: bool, asr: bool }
const expandedRows = ref({})
function toggleExpand(idx, field) {
  if (!expandedRows.value[idx]) expandedRows.value[idx] = {}
  expandedRows.value[idx][field] = !expandedRows.value[idx][field]
}
function isExpanded(idx, field) {
  return expandedRows.value[idx]?.[field] ?? false
}
</script>

<template>
  <div class="cc-page">
    <!-- 顶部标签栏 -->
    <div class="tagbar-row">
      <div class="tagbar-slot"><slot name="tagbar" /></div>
    </div>

    <!-- 素材概览 -->
    <div class="overview card rise" v-if="loadedTag">
      <div class="ov-head">
        <div class="ov-title">
          <Icon name="list" :size="18" />
          <span>素材概览</span>
          <span class="ov-count">{{ sampleCount }} 条</span>
        </div>
      </div>

      <!-- 类型分布胶囊 -->
      <div class="type-pills" v-if="typeStats.length">
        <span v-for="[type, cnt] in typeStats" :key="type" class="tp" :style="{ '--p': (cnt / sampleCount * 100).toFixed(0) + '%' }">
          <i class="tp-dot"></i>{{ type }}<b>{{ cnt }}</b>
        </span>
      </div>

      <!-- 素材预览表 -->
      <div class="preview-table" v-if="previewSamples.length">
        <div class="pt-row pt-hd">
          <span class="pt-idx">#</span>
          <span class="pt-type">类型</span>
          <span class="pt-ocr">OCR 内容</span>
          <span class="pt-asr">ASR 内容</span>
        </div>
        <div v-for="(s, i) in previewSamples" :key="i" class="pt-row pt-data">
          <span class="pt-idx">{{ i + 1 }}</span>
          <span class="pt-type"><i class="type-tag">{{ getType(s) }}</i></span>
          <!-- OCR 内容可折叠 -->
          <span class="pt-ocr">
            <div v-if="getOcr(s)" class="cell-wrap" :class="{ open: isExpanded(i, 'ocr') }">
              <div class="cell-text" @click="toggleExpand(i, 'ocr')">{{ getOcr(s) }}</div>
              <button v-if="getOcr(s).length > 40" class="cell-btn" @click.stop="toggleExpand(i, 'ocr')">
                <Icon :name="isExpanded(i, 'ocr') ? 'chevronUp' : 'chevronDown'" :size="12" />
                {{ isExpanded(i, 'ocr') ? '收起' : '展开' }}
              </button>
            </div>
            <span v-else class="cell-empty">—</span>
          </span>
          <!-- ASR 内容可折叠 -->
          <span class="pt-asr">
            <div v-if="getAsr(s)" class="cell-wrap" :class="{ open: isExpanded(i, 'asr') }">
              <div class="cell-text" @click="toggleExpand(i, 'asr')">{{ getAsr(s) }}</div>
              <button v-if="getAsr(s).length > 40" class="cell-btn" @click.stop="toggleExpand(i, 'asr')">
                <Icon :name="isExpanded(i, 'asr') ? 'chevronUp' : 'chevronDown'" :size="12" />
                {{ isExpanded(i, 'asr') ? '收起' : '展开' }}
              </button>
            </div>
            <span v-else class="cell-empty">—</span>
          </span>
        </div>
        <p class="pt-more" v-if="sampleCount > 6">还有 {{ sampleCount - 6 }} 条素材未展示</p>
      </div>
    </div>

    <!-- 空状态 -->
    <div class="empty card rise" v-else>
      <Icon name="tagcount" :size="40" />
      <p>请先在上方选择标签并加载素材</p>
      <span>加载后将显示素材概览</span>
    </div>

    <!-- 引导提示卡 -->
    <div class="hint-card" v-if="loadedTag && sampleCount">
      <Icon name="doc" :size="20" />
      <div>
        <p class="hc-title">素材已加载</p>
        <p class="hc-desc">请在上方「素材预览与标注」页面进行误杀Case分析与归因</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc-page { min-height: calc(100vh - 160px); }

.tagbar-row { margin-bottom: 16px; }
.tagbar-slot :deep(.tag-bar) { margin-bottom: 0; }

.overview { padding: 20px 24px; margin-bottom: 16px; }
.ov-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 12px; }
.ov-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--text-1); }
.ov-title svg { color: var(--brand); }
.ov-count { font-size: 13px; font-weight: 600; color: var(--brand); background: var(--brand-soft); padding: 2px 10px; border-radius: 20px; }

.type-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tp { display: flex; align-items: center; gap: 5px; padding: 5px 13px; border-radius: 20px; font-size: 12px; color: var(--text-2); background: var(--bg-soft); border: 1px solid var(--border); }
.tp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); }
.tp b { font-weight: 700; color: var(--brand); margin-left: 2px; }

.preview-table { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.pt-row { display: grid; grid-template-columns: 40px 80px 1fr 1fr; gap: 0; align-items: center; padding: 0; border-bottom: 1px solid var(--border); }
.pt-row:last-child { border-bottom: none; }
.pt-hd { background: var(--bg-soft); font-size: 12px; font-weight: 600; color: var(--text-3); }
.pt-hd span { padding: 9px 12px; }
.pt-row:not(.pt-hd) span { padding: 11px 12px; font-size: 13px; color: var(--text-2); }
.pt-row.pt-data { align-items: flex-start; }
.pt-row:not(.pt-hd):hover { background: var(--brand-soft); }
.pt-idx { color: var(--text-4) !important; font-size: 12px !important; }
.type-tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; background: #eef2ff; color: var(--brand); font-style: normal; }
.pt-ocr, .pt-asr { position: relative; }
.pt-ocr, .pt-asr { vertical-align: top; }
.cell-wrap { position: relative; }
.cell-wrap .cell-text {
  white-space: pre-wrap; word-break: break-all; line-height: 1.6; cursor: pointer;
  max-height: 38px; overflow: hidden; transition: max-height .3s ease;
}
.cell-wrap.open .cell-text { max-height: 200px; overflow-y: auto; }
.cell-btn {
  display: inline-flex; align-items: center; gap: 3px; margin-top: 4px;
  padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px;
  font-size: 11px; color: var(--brand); background: var(--brand-soft);
  cursor: pointer; transition: all .18s; white-space: nowrap;
}
.cell-btn:hover { background: var(--brand); color: #fff; border-color: var(--brand); }
.cell-empty { color: var(--text-4); }
.pt-more { padding: 12px; text-align: center; font-size: 12px; color: var(--text-4); }

.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 60px 20px; text-align: center; }
.empty svg { color: var(--text-4); }
.empty p { font-size: 15px; font-weight: 600; color: var(--text-2); }
.empty span { font-size: 13px; color: var(--text-4); }

.hint-card { display: flex; align-items: center; gap: 14px; padding: 16px 20px; background: linear-gradient(135deg, var(--brand-soft), #eef2ff); border: 1px solid #d6e0ff; border-radius: 14px; margin-bottom: 16px; }
.hint-card svg { color: var(--brand); flex-shrink: 0; }
.hc-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.hc-desc { font-size: 12px; color: var(--text-3); }
</style>
