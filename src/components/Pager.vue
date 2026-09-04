<script setup>
import Icon from './Icon.vue'
defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: [Number, String], default: 20 },
})
const emit = defineEmits(['update:page', 'update:pageSize'])
const sizes = [{ v: 'all', t: '全部' }, { v: 20, t: '20' }, { v: 50, t: '50' }]
function pages(total, size) {
  if (size === 'all') return 1
  return Math.max(1, Math.ceil(total / Number(size)))
}
</script>
<template>
  <div class="pager">
    <div class="pager-info">共 <b>{{ total }}</b> 条 · 第 {{ page }}/{{ pages(total, pageSize) }} 页</div>
    <div class="pager-ctrl">
      <span class="pager-lab">每页</span>
      <div class="seg">
        <button v-for="s in sizes" :key="s.v" :class="{ on: pageSize === s.v }"
          @click="emit('update:pageSize', s.v); emit('update:page', 1)">{{ s.t }}</button>
      </div>
      <div class="pg-btns">
        <button class="pg" :disabled="page === 1" @click="emit('update:page', 1)"><Icon name="doubleLeft" :size="15" /></button>
        <button class="pg" :disabled="page === 1" @click="emit('update:page', page - 1)"><Icon name="chevronLeft" :size="15" /></button>
        <span class="pg-cur">{{ page }}</span>
        <button class="pg" :disabled="page >= pages(total, pageSize)" @click="emit('update:page', page + 1)"><Icon name="chevronRight" :size="15" /></button>
        <button class="pg" :disabled="page >= pages(total, pageSize)" @click="emit('update:page', pages(total, pageSize))"><Icon name="doubleRight" :size="15" /></button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.pager { display: flex; align-items: center; justify-content: space-between; padding: 18px 4px 4px; flex-wrap: wrap; gap: 12px; }
.pager-info { color: var(--text-3); font-size: 13px; } .pager-info b { color: var(--text-1); }
.pager-ctrl { display: flex; align-items: center; gap: 12px; }
.pager-lab { color: var(--text-3); font-size: 13px; }
.seg { display: flex; background: #f0f2f6; border-radius: 9px; padding: 3px; }
.seg button { padding: 4px 14px; border-radius: 7px; font-size: 13px; color: var(--text-2); font-weight: 500; transition: all .18s; }
.seg button.on { background: var(--brand); color: #fff; box-shadow: 0 2px 6px rgba(79,124,255,.3); }
.pg-btns { display: flex; align-items: center; gap: 4px; }
.pg { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: var(--text-2); border: 1px solid var(--border); background: #fff; transition: all .18s; }
.pg:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
.pg:disabled { opacity: .4; cursor: not-allowed; }
.pg-cur { min-width: 30px; height: 30px; padding: 0 6px; border-radius: 8px; background: var(--brand); color: #fff; display: grid; place-items: center; font-size: 13px; font-weight: 600; }
</style>
