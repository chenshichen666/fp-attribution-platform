<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({ option: { type: Object, required: true }, height: { type: String, default: '320px' } })
const emit = defineEmits(['click', 'clickItem'])
const el = ref(null)
let chart = null
let ro = null
let rafId = 0

function render() {
  if (!el.value) return
  if (!chart) chart = echarts.init(el.value)
  chart.setOption(props.option, true)
}
// 用 rAF 异步执行 resize，跳出 ResizeObserver 的当前观察帧，
// 避免 "ResizeObserver loop completed with undelivered notifications" 告警
function resize() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => { rafId = 0; chart && chart.resize() })
}

function getChart() { return chart }

defineExpose({ getChart })

onMounted(() => {
  nextTick(() => {
    render()
    if (chart) {
      chart.on('click', (params) => {
        emit('click', params)
        if (params.componentType === 'series') emit('clickItem', params)
      })
    }
  })
  window.addEventListener('resize', resize)
  if (window.ResizeObserver && el.value) {
    ro = new ResizeObserver(() => resize())
    ro.observe(el.value)
  }
})
onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  window.removeEventListener('resize', resize)
  ro && ro.disconnect()
  chart && chart.dispose()
})
watch(() => props.option, render, { deep: true })
</script>
<template><div ref="el" :style="{ width: '100%', height }"></div></template>
