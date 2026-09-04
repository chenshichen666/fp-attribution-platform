<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToastStore } from '../../stores/toast'
import { auditApi } from '../../api'
import { usePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'
import EmptyState from '../../components/EmptyState.vue'

const toast = useToastStore()
const logs = ref([])
const kw = usePersistedRef('audit:kw', '')
const actionFilter = usePersistedRef('audit:actionFilter', '')
const actions = computed(() => [...new Set(logs.value.map(l => l.action))])
const filtered = computed(() => logs.value.filter(l => {
  if (kw.value && !l.user.includes(kw.value) && !l.target.includes(kw.value)) return false
  if (actionFilter.value && l.action !== actionFilter.value) return false
  return true
}))

async function loadLogs() {
  try {
    logs.value = await auditApi.list()
  } catch (e) {
    toast.warn(e.message || '加载审计日志失败')
  }
}
onMounted(loadLogs)

function actionCls(a) {
  if (a.includes('采纳')) return 'badge-green'
  if (a.includes('结论') || a.includes('受理')) return 'badge-blue'
  if (a.includes('上传') || a.includes('AI')) return 'badge-purple'
  return 'badge-gray'
}
const detailOpen = ref(false)
const detail = ref(null)
function openDetail(l) {
  detail.value = {
    ...l,
    before: l.action.includes('采纳') ? { status: 'concluded', final_category: null } : { status: '—' },
    after: l.action.includes('采纳') ? { status: 'done', final_category: 'RULE_UNREASONABLE' } : { status: '—' },
  }
  detailOpen.value = true
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="shield" :size="22" />审计日志</h1>
      <p class="page-sub">全量记录登录、审批、抢单、采纳确定问题分类、AI 提取等关键操作</p>
    </div>

    <div class="card list-card rise">
      <div class="bar">
        <div class="search"><Icon name="search" :size="16" /><input v-model="kw" placeholder="搜索用户 / 目标对象…" /></div>
        <select class="field sm" v-model="actionFilter">
          <option value="">全部操作类型</option>
          <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
        </select>
        <button class="btn btn-ghost btn-sm"><Icon name="download" :size="14" />导出 CSV</button>
      </div>

      <table v-if="filtered.length" class="tbl">
        <thead><tr><th>时间</th><th>操作用户</th><th>操作类型</th><th>目标对象</th><th>IP</th><th></th></tr></thead>
        <tbody>
          <tr v-for="l in filtered" :key="l.id" @click="openDetail(l)">
            <td class="mono">{{ l.t }}</td>
            <td><span class="u-mini">{{ l.user }}</span></td>
            <td><span class="badge" :class="actionCls(l.action)">{{ l.action }}</span></td>
            <td class="mono">{{ l.target }}</td>
            <td class="mono dim">{{ l.ip }}</td>
            <td class="ta-r"><Icon name="chevronRight" :size="15" class="dim" /></td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else icon="shield" title="无匹配日志" desc="试试调整搜索词或操作类型筛选" />
    </div>

    <Modal v-model="detailOpen" title="审计日志详情" width="520px">
      <div v-if="detail" class="d">
        <div class="d-row"><span>操作用户</span><b>{{ detail.user }}</b></div>
        <div class="d-row"><span>操作类型</span><b>{{ detail.action }}</b></div>
        <div class="d-row"><span>目标对象</span><b class="mono">{{ detail.target }}</b></div>
        <div class="d-row"><span>时间 / IP</span><b class="mono">{{ detail.t }} · {{ detail.ip }}</b></div>
        <div class="d-json">
          <div class="jc"><h5>变更前 (before)</h5><pre>{{ JSON.stringify(detail.before, null, 2) }}</pre></div>
          <div class="jc"><h5>变更后 (after)</h5><pre>{{ JSON.stringify(detail.after, null, 2) }}</pre></div>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }
.list-card { padding: 20px 24px; }
.bar { display: flex; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text-3); flex: 1; min-width: 200px; }
.search:focus-within { border-color: var(--brand); }
.search input { flex: 1; font-size: 14px; color: var(--text-1); border: none; outline: none; background: transparent; appearance: none; -webkit-appearance: none; box-shadow: none; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 12px 14px; color: var(--text-3); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 13px 14px; border-bottom: 1px solid var(--border); }
.tbl tbody tr { cursor: pointer; transition: background .15s; }
.tbl tbody tr:hover { background: var(--bg-soft); }
.mono { font-family: monospace; font-size: 12px; }
.dim { color: var(--text-4); }
.u-mini { font-weight: 600; }
.ta-r { text-align: right; }
.d-row { display: flex; gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.d-row span { width: 90px; color: var(--text-3); }
.d-json { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
.jc h5 { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.jc pre { background: var(--bg-soft); border-radius: 10px; padding: 12px; font-size: 12px; color: var(--text-2); overflow-x: auto; }
</style>
