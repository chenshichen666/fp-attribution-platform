<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToastStore } from '../../stores/toast'
import { manageApi } from '../../api'
import { usePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'

const toast = useToastStore()
const users = ref([])
const loading = ref(false)

async function loadUsers() {
  loading.value = true
  try {
    users.value = await manageApi.users()
  } catch (e) {
    toast.warn(e.message || '加载用户列表失败')
  } finally {
    loading.value = false
  }
}
onMounted(loadUsers)
const ROLE_OPTS = ['提需人', '处理人', '管理员']
const STATUS = { active: { t: '正常', c: 'green' }, pending: { t: '待审批', c: 'orange' }, disabled: { t: '已停用', c: 'gray' } }

const tab = usePersistedRef('users:tab', 'all')
const tabs = [
  { v: 'all', t: '全部用户' },
  { v: 'pending', t: '权限审批', st: 'pending' },
  { v: 'active', t: '正常', st: 'active' },
  { v: 'disabled', t: '已停用', st: 'disabled' },
]
function tabCount(v) { return v === 'all' ? users.value.length : users.value.filter(u => u.status === v).length }
const filtered = computed(() => tab.value === 'all' ? users.value : users.value.filter(u => u.status === tab.value))

const editOpen = ref(false)
const editUser = ref(null)
const editRoles = ref([])
function openEdit(u) { editUser.value = u; editRoles.value = [...u.roles]; editOpen.value = true }
function toggleRole(r) { const i = editRoles.value.indexOf(r); i >= 0 ? editRoles.value.splice(i, 1) : editRoles.value.push(r) }
async function saveRoles() {
  const u = editUser.value
  const roles = [...editRoles.value]
  const status = u.status === 'pending' ? 'active' : u.status
  try {
    await manageApi.updateUser(u.id, { roles, status })
    u.roles = roles
    u.status = status
    editOpen.value = false
    toast.success('角色已更新并立即生效')
  } catch (e) {
    toast.warn(e.message || '更新角色失败')
  }
}
async function approve(u) {
  const roles = u.roles.length ? u.roles : ['提需人']
  try {
    await manageApi.updateUser(u.id, { roles, status: 'active' })
    u.status = 'active'
    u.roles = roles
    toast.success(`已通过 ${u.name} 的权限申请，已通知`)
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
async function reject(u) {
  try {
    await manageApi.updateUser(u.id, { roles: u.roles, status: 'disabled' })
    u.status = 'disabled'
    toast.info(`已拒绝 ${u.name} 的申请`)
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
async function toggleDisable(u) {
  const next = u.status === 'disabled' ? 'active' : 'disabled'
  try {
    await manageApi.updateUser(u.id, { roles: u.roles, status: next })
    u.status = next
    toast.success(next === 'disabled' ? `已停用 ${u.name}` : `已恢复 ${u.name}`)
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="users" :size="22" />用户管理</h1>
      <p class="page-sub">用户列表 · 角色分配 · 权限审批 · 账号停用</p>
    </div>

    <div class="card list-card rise">
      <div class="seg-tabs">
        <button v-for="t in tabs" :key="t.v" :class="{ on: tab===t.v }" @click="tab=t.v">
          {{ t.t }}<b>{{ tabCount(t.v) }}</b>
          <i v-if="t.v==='pending' && tabCount('pending')" class="rdot"></i>
        </button>
      </div>

      <table class="tbl">
        <thead><tr><th>用户</th><th>团队</th><th>角色</th><th>状态</th><th class="ta-r">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in filtered" :key="u.id">
            <td>
              <div class="u-cell">
                <span class="u-ava">{{ u.name[0] }}</span>
                <div><b>{{ u.name }}</b><em>{{ u.eng }}</em></div>
              </div>
            </td>
            <td>{{ u.team }}</td>
            <td>
              <template v-if="u.roles.length">
                <span v-for="r in u.roles" :key="r" class="badge badge-blue rtag">{{ r }}</span>
              </template>
              <span v-if="!u.roles.length" class="badge badge-gray">无角色</span>
            </td>
            <td><span class="badge" :class="`badge-${STATUS[u.status].c}`">{{ STATUS[u.status].t }}</span></td>
            <td class="ta-r">
              <div class="ops">
                <template v-if="u.status==='pending'">
                  <button class="btn btn-primary btn-sm" @click="approve(u)">通过</button>
                  <button class="btn btn-ghost btn-sm" @click="reject(u)">拒绝</button>
                </template>
                <template v-else>
                  <button class="btn btn-ghost btn-sm" @click="openEdit(u)"><Icon name="settings" :size="14" />角色</button>
                  <button class="btn btn-ghost btn-sm" @click="toggleDisable(u)">{{ u.status==='disabled' ? '恢复' : '停用' }}</button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-model="editOpen" :title="`调整角色 · ${editUser?.name}`" width="440px">
      <p class="m-tip">勾选角色，提交后立即生效。可同时持有多个角色。</p>
      <div class="role-list">
        <button v-for="r in ROLE_OPTS" :key="r" class="role-it" :class="{ on: editRoles.includes(r) }" @click="toggleRole(r)">
          <span class="ck"><Icon v-if="editRoles.includes(r)" name="check" :size="12" /></span>{{ r }}
        </button>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="editOpen=false">取消</button>
        <button class="btn btn-primary btn-sm" @click="saveRoles">保存</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }
.list-card { padding: 20px 24px; }
.seg-tabs { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; width: fit-content; margin-bottom: 18px; }
.seg-tabs button { position: relative; display: flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; }
.seg-tabs button.on { background: #fff; color: var(--text-1); box-shadow: var(--shadow-sm); }
.seg-tabs b { color: var(--text-4); } .seg-tabs button.on b { color: var(--brand); }
.rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--red); position: absolute; top: 3px; right: 3px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 14px; }
.tbl th { text-align: left; padding: 12px 14px; color: var(--text-3); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 14px; border-bottom: 1px solid var(--border); }
.ta-r { text-align: right; }
.u-cell { display: flex; align-items: center; gap: 11px; }
.u-ava { width: 38px; height: 38px; border-radius: 50%; background: var(--brand-grad); color: #fff; display: grid; place-items: center; font-weight: 700; }
.u-cell b { font-size: 14px; font-weight: 600; display: block; }
.u-cell em { font-style: normal; font-size: 12px; color: var(--text-4); }
.rtag { margin-right: 4px; }
.ops { display: flex; gap: 8px; justify-content: flex-end; }
.m-tip { font-size: 13px; color: var(--text-3); background: var(--brand-soft); padding: 11px 14px; border-radius: 10px; margin-bottom: 16px; }
.role-list { display: flex; flex-direction: column; gap: 10px; }
.role-it { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border: 1.5px solid var(--border); border-radius: 12px; font-size: 14px; text-align: left; transition: all .18s; }
.role-it.on { border-color: var(--brand); background: var(--brand-soft); font-weight: 600; }
.role-it .ck { width: 19px; height: 19px; border-radius: 6px; border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: #fff; }
.role-it.on .ck { background: var(--brand); border-color: var(--brand); }
</style>
