<script setup>
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({ preset: '7', start: '', end: '' }) },
  // 数据最新业务日期（YYYY-MM-DD）：作为「近N天」preset 的终点锚点，
  // 避免数据截止日早于今天时窗口落空导致空数据（如数据到 08/15、今天 08/23）
  maxDate: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const PRESETS = [
  { v: '1', t: '前1天' },
  { v: '7', t: '前7天' },
  { v: '30', t: '前30天' },
]

const preset = ref(props.modelValue.preset || '7')
const start = ref(props.modelValue.start || '')
const end = ref(props.modelValue.end || '')
const customMode = ref(!props.modelValue.preset && (props.modelValue.start || props.modelValue.end))

// 监听外部 modelValue 变化，同步更新内部 ref（例如从路由参数初始化时间窗口时）
watch(() => props.modelValue, (v) => {
  if (!v) return
  preset.value = v.preset || ''
  start.value = v.start || ''
  end.value = v.end || ''
  customMode.value = !v.preset && (!!(v.start || v.end))
}, { deep: true })

function fmt(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function pickPreset(v) {
  preset.value = v
  customMode.value = false
  const today = props.maxDate ? new Date(props.maxDate + 'T00:00:00') : new Date()
  const past = new Date(today.getTime())
  past.setDate(today.getDate() - Number(v))
  start.value = fmt(past)
  end.value = fmt(today)
  syncEmit()
}

function onCustom() {
  customMode.value = true
  preset.value = ''
  syncEmit()
}

function syncEmit() {
  emit('update:modelValue', { preset: preset.value, start: start.value, end: end.value })
}

watch([start, end], () => { if (customMode.value) { preset.value = ''; syncEmit() } })
</script>

<template>
  <div class="drf">
    <div class="drf-presets">
      <button
        v-for="p in PRESETS" :key="p.v"
        class="drf-btn" :class="{ on: !customMode && preset === p.v }"
        @click="pickPreset(p.v)"
      >{{ p.t }}</button>
    </div>
    <div class="drf-custom" :class="{ on: customMode }">
      <input type="date" v-model="start" @click="onCustom" />
      <span class="drf-sep">至</span>
      <input type="date" v-model="end" @click="onCustom" />
    </div>
  </div>
</template>

<style scoped>
.drf { display: flex; align-items: center; gap: 10px; }
.drf-presets { display: flex; background: #f0f2f6; border-radius: 9px; padding: 3px; }
.drf-btn { padding: 5px 13px; border-radius: 7px; font-size: 12px; color: var(--text-2); font-weight: 500; transition: all .15s; white-space: nowrap; }
.drf-btn:hover { color: var(--brand); }
.drf-btn.on { background: #fff; color: var(--brand); box-shadow: var(--shadow-sm); font-weight: 600; }
.drf-custom { display: flex; align-items: center; gap: 6px; padding: 3px 3px 3px 10px; border: 1.5px solid var(--text-4); border-radius: 9px; transition: all .18s; background: #fff; }
.drf-custom.on { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(79,124,255,.12); }
.drf-custom input[type="date"] { height: 30px; padding: 0 8px; border: none; outline: none; background: transparent; font-size: 13px; color: var(--text-1); font-weight: 600; cursor: pointer; appearance: none; -webkit-appearance: none; }
.drf-custom input[type="date"]:hover { color: var(--brand); }
.drf-sep { font-size: 13px; color: var(--text-2); font-weight: 600; }
@media (max-width: 720px) { .drf { flex-wrap: wrap; } }
</style>