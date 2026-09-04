<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
const props = defineProps({
  icon: String,
  label: String,
  value: [String, Number],
  unit: String,
  color: { type: String, default: 'orange' }, // orange|red|blue|green|purple
  clickable: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  // 周环比变化：{ value: number, type: 'absolute'|'relative' }
  // absolute = 百分点变化（精度类，pp），relative = 相对变化比例（FP数类，%）
  change: { type: Object, default: null },
  // 变化对比时间范围文本（如近7天起止 "08/10-08/16"），用于图四式 KPI 卡
  period: { type: String, default: '' },
})
const hasChange = computed(() => props.change != null && props.change.value != null)
const isUp = computed(() => hasChange.value && props.change.value > 0)
const isDown = computed(() => hasChange.value && props.change.value < 0)
const changeText = computed(() => {
  if (!hasChange.value) return ''
  const v = Math.abs(props.change.value)
  if (props.change.type === 'relative') return v.toFixed(0) + '%'
  return v.toFixed(1) + 'pp'  // 百分点变化带 pp 后缀
})
const COLORS = {
  orange: { v: '#f5a000', soft: '#fff4e0', ic: '#f5a000' },
  red: { v: '#f0454b', soft: '#fdeced', ic: '#f0454b' },
  blue: { v: '#4f7cff', soft: '#eef2ff', ic: '#4f7cff' },
  green: { v: '#1fb574', soft: '#e6f7ef', ic: '#1fb574' },
  purple: { v: '#7c5cff', soft: '#f0ecff', ic: '#7c5cff' },
}
const c = computed(() => COLORS[props.color] || COLORS.orange)
</script>
<template>
  <div
    class="kpi card rise"
    :class="{ clickable, active }"
    :style="active ? { borderColor: c.v, boxShadow: `0 0 0 2px ${c.soft}, 0 8px 24px rgba(20,30,60,.10)` } : null"
  >
    <div class="kpi-top">
      <span class="kpi-ic" :style="{ background: c.soft, color: c.ic }">
        <Icon :name="icon" :size="18" />
      </span>
      <span class="kpi-label">{{ label }}</span>
      <span v-if="active" class="kpi-check" :style="{ background: c.v }"><Icon name="check" :size="11" /></span>
    </div>
    <div class="kpi-val" :style="{ color: c.v }">
      {{ value }}<small v-if="unit">{{ unit }}</small>
    </div>
    <div class="kpi-change" :class="{ up: isUp, down: isDown }">
      <template v-if="hasChange">
        <svg v-if="isUp" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2L10 7H8V10H4V7H2L6 2Z" fill="currentColor"/></svg>
        <svg v-else-if="isDown" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 10L2 5H4V2H8V5H10L6 10Z" fill="currentColor"/></svg>
        <span>{{ changeText }} <span class="text-ink-4" style="font-weight:400">近7天</span></span>
      </template>
      <span v-else class="text-ink-4">-</span>
      <span v-if="period" class="kpi-period">{{ period }}</span>
    </div>
    <span class="kpi-blob" :style="{ background: c.soft }"></span>
  </div>
</template>
<style scoped>
.kpi { position: relative; padding: 22px 24px; overflow: hidden; transition: transform .25s, box-shadow .25s, border-color .2s; border: 1px solid transparent; }
.kpi:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }
.kpi.clickable { cursor: pointer; }
.kpi.clickable:hover { transform: translateY(-4px); }
.kpi.active { transform: translateY(-2px); }
.kpi-top { display: flex; align-items: center; gap: 10px; }
.kpi-ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; }
.kpi-label { font-size: 14px; color: var(--text-2); font-weight: 500; }
.kpi-check { margin-left: auto; width: 18px; height: 18px; border-radius: 50%; color: #fff; display: grid; place-items: center; }
.kpi-check :deep(svg) { color: #fff; }
.kpi-val { font-size: 38px; font-weight: 800; margin-top: 14px; letter-spacing: -1px; line-height: 1; }
.kpi-val small { font-size: 15px; font-weight: 600; margin-left: 4px; color: var(--text-3); }
.kpi-change { display: flex; align-items: center; gap: 3px; margin-top: 8px; font-size: 12px; font-weight: 500; color: var(--text-4); }
.kpi-change.up { color: #22c55e; }
.kpi-change.down { color: #ef4444; }
.kpi-period { margin-left: auto; font-size: 11px; color: var(--text-4); font-weight: 400; }
.kpi-blob { position: absolute; right: -28px; top: -28px; width: 96px; height: 96px; border-radius: 50%; opacity: .6; }
</style>