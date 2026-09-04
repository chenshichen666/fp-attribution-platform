<script setup>
import { ref } from 'vue'
import { useToastStore } from '../stores/toast'
import { createShareLink } from '../utils/share'
import Icon from './Icon.vue'

const props = defineProps({
  // 模块标识
  module: { type: String, required: true },
  // 取当前 UI 状态快照的函数：() => ({ [key]: value })
  getUiState: { type: Function, default: () => ({}) },
  // 分享标题
  title: { type: String, default: '' },
  // 有效期选项
  expireDays: { type: Number, default: 30 },
  // 按钮文案
  label: { type: String, default: '复制分享链接' },
  // 自定义样式类（如 btn-snap）
  btnClass: { type: String, default: 'btn btn-ghost btn-sm' },
})

const toast = useToastStore()
const loading = ref(false)
const justCopied = ref(false)

async function onShare() {
  if (loading.value) return
  loading.value = true
  try {
    const uiState = props.getUiState ? props.getUiState() : {}
    const { expireDays } = await createShareLink({
      module: props.module,
      uiState,
      title: props.title,
      expireDays: props.expireDays,
    })
    justCopied.value = true
    toast.success(`分享链接已复制（${expireDays === 0 ? '永不过期' : expireDays + '天有效'}），对方打开即可查看此页面`)
    setTimeout(() => { justCopied.value = false }, 2000)
  } catch (e) {
    toast.warn(e.message || '复制分享链接失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <button :class="btnClass" :disabled="loading" @click="onShare">
    <Icon :name="justCopied ? 'check' : 'share'" :size="14" />
    <span>{{ loading ? '生成中...' : (justCopied ? '已复制' : label) }}</span>
  </button>
</template>
