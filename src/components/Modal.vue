<script setup>
import Icon from './Icon.vue'
defineProps({ modelValue: Boolean, title: String, width: { type: String, default: '520px' } })
const emit = defineEmits(['update:modelValue'])
</script>
<template>
  <teleport to="body">
    <transition name="pop">
      <div v-if="modelValue" class="mask" @click.self="emit('update:modelValue', false)">
        <div class="modal" :style="{ width }">
          <div class="modal-hd">
            <h3>{{ title }}</h3>
            <button class="x" @click="emit('update:modelValue', false)"><Icon name="close" :size="18" /></button>
          </div>
          <div class="modal-bd"><slot /></div>
          <div class="modal-ft" v-if="$slots.footer"><slot name="footer" /></div>
        </div>
      </div>
    </transition>
  </teleport>
</template>
<style scoped>
.mask { position: fixed; inset: 0; background: rgba(20,26,40,.4); backdrop-filter: blur(3px); z-index: 1000; display: grid; place-items: center; padding: 20px; }
.modal { background: #fff; border-radius: 18px; box-shadow: var(--shadow-lg); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; }
.modal-hd { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border); }
.modal-hd h3 { font-size: 17px; font-weight: 700; }
.x { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; color: var(--text-3); transition: all .18s; }
.x:hover { background: #f0f2f6; color: var(--text-1); }
.modal-bd { padding: 24px; overflow-y: auto; }
.modal-ft { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 12px; background: var(--bg-soft); }
</style>
