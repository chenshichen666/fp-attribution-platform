<script setup>
import Icon from './Icon.vue'
defineProps({ icon: { type: String, default: 'sediment' }, title: String, desc: String })
</script>
<template>
  <div class="empty">
    <div class="empty-ic"><Icon :name="icon" :size="40" /></div>
    <div class="empty-title">{{ title }}</div>
    <div class="empty-desc" v-if="desc">{{ desc }}</div>
    <slot />
  </div>
</template>
<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 20px; text-align: center; }
.empty-ic { width: 88px; height: 88px; border-radius: 24px; background: linear-gradient(135deg, #eef2ff, #f4f6fb);
  display: grid; place-items: center; color: var(--brand); margin-bottom: 18px; }
.empty-title { font-size: 16px; font-weight: 600; color: var(--text-1); }
.empty-desc { font-size: 13px; color: var(--text-3); margin-top: 8px; max-width: 360px; line-height: 1.7; }
</style>
