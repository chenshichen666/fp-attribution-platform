<script setup>
import { useToastStore } from '../stores/toast'
import Icon from './Icon.vue'
const toast = useToastStore()
const iconOf = (t) => (t === 'success' ? 'checkCircle' : t === 'warn' ? 'alert' : t === 'error' ? 'close' : 'feedback')
</script>
<template>
  <div class="toast-host">
    <transition-group name="toast">
      <div v-for="t in toast.list" :key="t.id" class="toast" :class="`toast-${t.type}`">
        <Icon :name="iconOf(t.type)" :size="18" />
        <span>{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>
<style scoped>
.toast-host { position: fixed; right: 24px; bottom: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
.toast { display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-radius: 12px;
  background: #fff; box-shadow: var(--shadow-lg); font-size: 14px; font-weight: 500; border: 1px solid var(--border); }
.toast-success { color: var(--green); } .toast-success svg { color: var(--green); }
.toast-warn { color: #c87f00; } .toast-warn svg { color: var(--orange); }
.toast-error { color: #e74c3c; } .toast-error svg { color: #e74c3c; }
.toast-info { color: var(--brand); } .toast-info svg { color: var(--brand); }
.toast-enter-active { transition: all .35s cubic-bezier(.16,1,.3,1); }
.toast-leave-active { transition: all .25s ease; }
.toast-enter-from { opacity: 0; transform: translateX(40px); }
.toast-leave-to { opacity: 0; transform: translateX(40px); }
</style>
