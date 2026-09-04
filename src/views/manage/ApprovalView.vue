<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { manageApi } from '../../api'
import { usePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'
import EmptyState from '../../components/EmptyState.vue'

const toast = useToastStore()
const auth = useAuthStore()
const approvals = ref([])

const isSuperAdmin = computed(() => {
  return auth.user?.eng === 'admin'
})

async function loadRequests() {
  try {
    approvals.value = await manageApi.requests()
  } catch (e) {
    toast.warn(e.message || '加载审批列表失败')
  }
}
onMounted(loadRequests)
const tab = usePersistedRef('approval:tab', 'pending')
const STATUS = {
  pending: { t: '待审批', c: 'orange' },
  approved: { t: '已通过', c: 'green' },
  rejected: { t: '已拒绝', c: 'red' },
}
const tabs = [
  { v: 'pending', t: '待审批' },
  { v: 'approved', t: '已通过' },
  { v: 'rejected', t: '已拒绝' },
]
const filtered = computed(() => approvals.value.filter(a => a.status === tab.value))
const detailOpen = ref(false)
const detail = ref(null)

async function approve(a) {
  try {
    await manageApi.decideRequest(a.id, 'approved')
    toast.success(`已通过 ${a.name} 的权限申请`)
    await loadRequests()
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
async function reject(a) {
  if (!confirm(`确定拒绝 ${a.name} 的权限申请？`)) return
  try {
    await manageApi.decideRequest(a.id, 'rejected')
    toast.info(`已拒绝 ${a.name} 的申请`)
    await loadRequests()
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
function openDetail(a) { detail.value = a; detailOpen.value = true }
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="shield" :size="22" />权限审批</h1>
      <p class="page-sub">用户角色权限申请 · 审批 · 记录<span v-if="isSuperAdmin" class="super-tag">超级管理员</span></p>
    </div>

    <div class="card list-card rise">
      <div class="seg-tabs">
        <button v-for="t in tabs" :key="t.v" :class="{ on: tab === t.v }" @click="tab = t.v">
          {{ t.t }}
          <b v-if="t.v === 'pending'">{{ filtered.length }}</b>
        </button>
      </div>

      <table v-if="filtered.length" class="tbl">
        <thead>
          <tr>
            <th>申请人</th>
            <th>团队</th>
            <th>申请角色</th>
            <th>申请理由</th>
            <th>申请时间</th>
            <th>状态</th>
            <th class="ta-r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in filtered" :key="a.id">
            <td>
              <div class="u-cell">
                <span class="u-ava">{{ a.name[0] }}</span>
                <div><b>{{ a.name }}</b><em>{{ a.eng }}</em></div>
              </div>
            </td>
            <td>{{ a.team }}</td>
            <td>
              <span v-for="r in a.applyRoles" :key="r" class="badge badge-blue rtag">{{ r }}</span>
            </td>
            <td class="reason" @click="openDetail(a)">{{ a.reason }}</td>
            <td class="mono dim">{{ a.createdAt }}</td>
            <td>
              <span class="badge" :class="`badge-${STATUS[a.status].c}`">{{ STATUS[a.status].t }}</span>
            </td>
            <td class="ta-r">
              <template v-if="a.status === 'pending'">
                <button class="btn btn-primary btn-sm" @click="approve(a)">通过</button>
                <button class="btn btn-ghost btn-sm" @click="reject(a)">拒绝</button>
              </template>
              <template v-else>
                <span class="dim" style="font-size: 12px;">{{ a.operator }} · {{ a.operatedAt }}</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else icon="shield" title="暂无审批记录" desc="当前没有待处理的权限申请" />
    </div>

    <Modal v-model="detailOpen" title="申请详情" width="420px">
      <div v-if="detail" class="d">
        <div class="d-row"><span>申请人</span><b>{{ detail.name }}</b></div>
        <div class="d-row"><span>团队</span><b>{{ detail.team }}</b></div>
        <div class="d-row"><span>申请角色</span><b>
          <span v-for="r in detail.applyRoles" :key="r" class="badge badge-blue" style="margin-right: 4px;">{{ r }}</span>
        </b></div>
        <div class="d-row"><span>申请理由</span><b>{{ detail.reason }}</b></div>
        <div class="d-row"><span>申请时间</span><b class="mono">{{ detail.createdAt }}</b></div>
        <div class="d-row"><span>状态</span>
          <b><span class="badge" :class="`badge-${STATUS[detail.status].c}`">{{ STATUS[detail.status].t }}</span></b>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }
.super-tag { display: inline-block; margin-left: 10px; padding: 2px 10px; border-radius: 999px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-size: 11px; font-weight: 700; vertical-align: middle; }
.list-card { padding: 20px 24px; }
.seg-tabs { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; width: fit-content; margin-bottom: 18px; }
.seg-tabs button { display: flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; }
.seg-tabs button.on { background: #fff; color: var(--text-1); box-shadow: var(--shadow-sm); }
.seg-tabs b { color: var(--brand); }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 10px 12px; color: var(--text-3); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 12px; border-bottom: 1px solid var(--border); }
.ta-r { text-align: right; }
.u-cell { display: flex; align-items: center; gap: 10px; }
.u-ava { width: 34px; height: 34px; border-radius: 50%; background: var(--brand-grad); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.u-cell b { font-size: 13px; font-weight: 600; display: block; }
.u-cell em { font-style: normal; font-size: 11px; color: var(--text-4); }
.rtag { margin-right: 4px; }
.reason { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--text-2); }
.reason:hover { color: var(--brand); }
.mono { font-family: monospace; font-size: 12px; }
.dim { color: var(--text-4); }
.d-row { display: flex; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.d-row span { width: 80px; color: var(--text-3); flex-shrink: 0; }
</style>
