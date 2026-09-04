<script setup>
import { ref, watch, onMounted } from 'vue'
import { materialApi } from '../api'
import { useToastStore } from '../stores/toast'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  tagId: { type: [String, Number], default: '' },
  sampleId: { type: String, default: '' },
  mediaUrl: { type: String, default: '' },
  compact: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  hideWhenEmpty: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false }, // 只读展示模式：仅展示已有标记内容气泡（含身份+时间），无输入表单
  unlimited: { type: Boolean, default: false }, // 历史标注列表完整展开，不限制高度（相似样本弹窗使用）
  lastOnly: { type: Boolean, default: false }, // 仅展示最后一条标注结果（身份：内容），多列卡片使用
})
const emit = defineEmits(['saved'])

const auth = useAuthStore()
const toast = useToastStore()
const annotations = ref([])
const draft = ref('')
const role = ref('运营') // 标注角色：产品/运营/算法（参照图二）
const ROLE_OPTIONS = ['产品', '运营', '算法']
const loading = ref(false)
const submitting = ref(false)
const expanded = ref(!props.compact)

async function load() {
  if (!props.tagId || !props.sampleId) { annotations.value = []; return }
  loading.value = true
  try {
    const list = await materialApi.annotations(props.tagId, props.sampleId)
    annotations.value = Array.isArray(list) ? list : []
  } catch {
    annotations.value = []
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (props.disabled) { toast.warn('当前为只读模式，无法标注'); return }
  const text = draft.value.trim()
  if (!text) { toast.warn('请输入标注内容'); return }
  if (!props.tagId || !props.sampleId) { toast.warn('缺少素材标识'); return }
  submitting.value = true
  try {
    const d = await materialApi.addAnnotation(props.tagId, {
      sampleId: props.sampleId, mediaUrl: props.mediaUrl, content: text, role: role.value,
    })
    annotations.value.push({ id: d.id, sampleId: d.sampleId, content: d.content, owner: d.owner, role: d.role || role.value, createdAt: d.createdAt })
    draft.value = ''
    expanded.value = true
    emit('saved', d)
    toast.success('标注已提交')
  } catch (e) {
    toast.warn(e.message || '标注失败')
  } finally {
    submitting.value = false
  }
}

function fmtTime(t) {
  if (!t) return ''
  return String(t).replace('T', ' ').slice(0, 19)
}

watch(() => props.sampleId, () => {
  annotations.value = []
  draft.value = ''
  expanded.value = !props.compact
  load()
})
onMounted(load)
</script>

<template>
  <div v-if="!hideWhenEmpty || loading || annotations.length" class="mat-ann" @click.stop>
    <!-- 仅展示最后一条结果：身份+标注内容（多列卡片，参照「运营：1」样式） -->
    <template v-if="lastOnly">
      <div v-if="loading" class="ma-loading">加载标注…</div>
      <div v-else-if="annotations.length" class="ma-last">
        <span class="ma-last-role">{{ annotations[annotations.length - 1].role || '标注' }}</span>
        <span class="ma-last-sep">：</span>
        <span class="ma-last-text" :title="annotations[annotations.length - 1].content">{{ annotations[annotations.length - 1].content }}</span>
      </div>
    </template>

    <!-- 只读模式：仅展示已有标记内容气泡（含标注身份+时间），无输入表单、无 placeholder -->
    <template v-else-if="readonly">
      <div v-if="loading" class="ma-loading">加载标注…</div>
      <div v-else class="ma-list ma-readonly" :class="{ 'ma-unlimited': unlimited }">
        <div v-for="a in annotations" :key="a.id" class="ma-item">
          <div class="ma-bubble">{{ a.content }}</div>
          <div class="ma-meta">
            <span class="ma-time">{{ fmtTime(a.createdAt) }}</span>
            <span class="ma-role" v-if="a.role">{{ a.role }}</span>
            <span class="ma-owner">{{ a.owner || '未知用户' }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- 可编辑模式（参照图二：角色选择 + 输入框 + 橙色标注按钮） -->
    <template v-else>
    <div class="ma-hd">
      <span class="ma-title">标注</span>
      <button v-if="annotations.length" class="ma-toggle" type="button" @click.stop="expanded = !expanded">{{ expanded ? '收起' : `展开历史（${annotations.length}）` }}</button>
    </div>

    <!-- 历史标注列表 -->
    <div v-if="expanded" class="ma-list" :class="{ 'ma-unlimited': unlimited }">
      <div v-if="loading" class="ma-loading">加载标注…</div>
      <template v-else>
        <div v-for="a in annotations" :key="a.id" class="ma-item">
          <div class="ma-bubble">{{ a.content }}</div>
          <div class="ma-meta">
            <span class="ma-time">{{ fmtTime(a.createdAt) }}</span>
            <span class="ma-role" v-if="a.role">{{ a.role }}</span>
            <span class="ma-owner">{{ a.owner || '未知用户' }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 输入区：角色选择 + Enter 提交 + 标注按钮 -->
    <div class="ma-input-row">
      <select class="ma-role" v-model="role" :disabled="disabled">
        <option v-for="r in ROLE_OPTIONS" :key="r" :value="r">{{ r }}</option>
      </select>
      <input class="ma-input" v-model="draft" :disabled="disabled" placeholder="标记原因，如：背景音乐误判为违规…" @keydown.enter.prevent="submit" />
      <button class="ma-btn" type="button" :disabled="disabled || submitting || !draft.trim()" @click.stop="submit">{{ submitting ? '提交中' : '标注' }}</button>
    </div>
    </template>
  </div>
</template>

<style scoped>
.mat-ann { display: flex; flex-direction: column; gap: 8px; }
.ma-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ma-title { font-size: 13px; font-weight: 700; color: var(--text-1); display: inline-flex; align-items: baseline; gap: 6px; }
.ma-sub { font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--text-4); }
.ma-toggle { border: none; background: transparent; color: var(--brand); font-size: 11px; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.ma-toggle:hover { background: var(--brand-soft); }
.ma-list { display: flex; flex-direction: column; gap: 7px; max-height: 180px; overflow-y: auto; padding: 2px 0; }
.ma-unlimited { max-height: none; }
.ma-readonly { max-height: none; gap: 8px; padding: 0; }
.ma-readonly .ma-item { gap: 2px; }
.ma-readonly .ma-bubble { background: transparent; border: none; border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0; padding: 5px 10px; }
.ma-item { display: flex; flex-direction: column; gap: 2px; }
.ma-bubble { font-size: 12px; line-height: 1.55; color: var(--text-1); background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px 10px 10px 2px; padding: 7px 10px; word-break: break-word; }
.ma-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding-left: 4px; }
.ma-meta > span + span::before { content: '·'; margin-right: 6px; color: var(--text-4); }
.ma-time { font-size: 10px; color: var(--text-4); font-variant-numeric: tabular-nums; }
.ma-role { font-size: 10px; font-weight: 700; color: var(--brand); background: var(--brand-soft); border-radius: 4px; padding: 1px 6px; line-height: 1.5; }
.ma-owner { font-size: 10.5px; font-weight: 600; color: var(--text-2); }
.ma-empty, .ma-loading { font-size: 11.5px; color: var(--text-4); padding: 8px 2px; }
.ma-input-row { display: flex; align-items: center; gap: 6px; }
.ma-role { flex-shrink: 0; height: 34px; border: 1px solid var(--border-strong); border-radius: 9px; padding: 0 8px; font-size: 12.5px; color: var(--text-1); background: #fff; cursor: pointer; transition: all .15s; box-sizing: border-box; }
.ma-role:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.ma-input { flex: 1; min-width: 0; height: 34px; border: 1px solid var(--border-strong); border-radius: 9px; padding: 0 12px; font-size: 12.5px; color: var(--text-1); background: #fff; transition: all .15s; box-sizing: border-box; }
.ma-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
.ma-input::placeholder { color: var(--text-4); }
.ma-input:disabled { background: var(--bg-soft); color: var(--text-4); }
.ma-btn { flex-shrink: 0; height: 34px; padding: 0 16px; border: none; border-radius: 9px; background: #f97316; color: #fff; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: all .15s; box-shadow: 0 3px 10px rgba(249,115,22,.28); }
.ma-btn:hover:not(:disabled) { background: #ea580c; box-shadow: 0 5px 14px rgba(249,115,22,.36); transform: translateY(-1px); }
.ma-btn:disabled { background: #fdba74; cursor: not-allowed; box-shadow: none; }
.ma-hint { font-size: 10.5px; color: var(--text-4); padding-left: 2px; }
.ma-last { display: inline-flex; align-items: baseline; gap: 4px; max-width: 100%; padding: 2px 10px; background: var(--brand-soft); border: 1px solid var(--border); border-radius: 999px; }
.ma-last-role { flex-shrink: 0; font-size: 11px; font-weight: 700; color: var(--brand); }
.ma-last-sep { flex-shrink: 0; font-size: 11px; color: var(--text-4); }
.ma-last-text { font-size: 11.5px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
