<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { authApi } from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const loading = ref(true)
const requests = ref([])

// 角色 -> 可访问模块映射（与导航守卫保持一致）
const MODULE_BY_ROLE = [
  { label: '总览', roles: ['submitter', 'admin'] },
  { label: '误杀Case分析', roles: ['submitter', 'admin'] },
  { label: '问题提需', roles: ['submitter', 'handler', 'admin'] },
  { label: '结论沉淀', roles: ['submitter', 'handler', 'admin'] },
  { label: '管理后台', roles: ['admin'] },
]
const roleTags = computed(() => auth.user?.roleTag || [])
const modules = computed(() =>
  MODULE_BY_ROLE.filter((m) => m.roles.some((r) => auth.roles.includes(r))).map((m) => m.label)
)

const STATUS_META = {
  pending: { t: '审批中', c: 'orange', icon: 'clock', desc: '已提交，等待超级管理员审批' },
  approved: { t: '已通过', c: 'green', icon: 'checkCircle', desc: '审批通过，角色已生效' },
  rejected: { t: '已拒绝', c: 'red', icon: 'close', desc: '申请被驳回，未授予角色' },
}
function statusMeta(s) { return STATUS_META[s] || STATUS_META.pending }
function fmt(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '—' }

// ===== 历史申请 =====
async function load() {
  loading.value = true
  try {
    requests.value = await authApi.myRequests()
    // 如果有已通过的申请但当前本地角色仍为空，说明后端已授权但前端缓存未同步
    const hasApproved = requests.value.some((r) => r.status === 'approved')
    if (hasApproved && !auth.hasRole) {
      await auth.refresh()
      if (auth.hasRole) {
        toast.success('审批已通过，角色已生效')
        router.push('/')
        return
      }
    }
  } catch (e) {
    toast.warn(e.message || '加载申请记录失败')
  } finally {
    loading.value = false
  }
}
onMounted(load)

function goApply() { router.push('/apply') }

// 监听 hasRole 变化后自动跳转首页
watch(
  () => auth.hasRole,
  (newVal) => {
    if (newVal) {
      router.push('/')
    }
  }
)
</script>

<template>
  <div class="mp">
    <!-- 顶部用户卡 -->
    <div class="mp-hero card rise">
      <div class="hero-bg"></div>
      <div class="hero-main">
        <span class="hero-ava" :style="{ background: auth.user?.color }">
          <img v-if="auth.avatar" :src="auth.avatar" alt="" @error="(e) => (e.target.style.display = 'none')" />
          <template v-else>{{ auth.user?.initial }}</template>
        </span>
        <div class="hero-info">
          <h1>{{ auth.user?.name }}</h1>
          <p>{{ auth.user?.eng }}<span v-if="auth.user?.team"> · {{ auth.user.team }}</span></p>
          <div class="hero-tags">
            <span v-for="t in roleTags" :key="t.t" class="role-chip" :class="`chip-${t.c}`">{{ t.t }}</span>
            <span v-if="!roleTags.length" class="role-chip chip-gray">暂无角色</span>
          </div>
        </div>
      </div>
      <button v-if="!auth.hasRole" class="hero-apply" @click="goApply">
        <Icon name="plus" :size="16" />申请权限
      </button>
    </div>

    <!-- 具体权限 -->
    <section class="mp-sec">
      <h2 class="sec-title"><Icon name="shield" :size="18" />我的具体权限</h2>
      <div class="perm-grid">
        <div class="perm-card card">
          <div class="pc-hd"><Icon name="user" :size="16" /><span>当前角色</span></div>
          <div class="pc-body">
            <div class="tag-wrap" v-if="roleTags.length">
              <span v-for="t in roleTags" :key="t.t" class="role-chip" :class="`chip-${t.c}`">{{ t.t }}</span>
            </div>
            <div v-else class="empty-line">暂无角色，请先申请权限</div>
          </div>
        </div>

        <div class="perm-card card">
          <div class="pc-hd"><Icon name="grid" :size="16" /><span>可访问模块</span></div>
          <div class="pc-body">
            <div class="mod-wrap" v-if="modules.length">
              <span v-for="m in modules" :key="m" class="mod-chip"><Icon name="check" :size="12" />{{ m }}</span>
            </div>
            <div v-else class="empty-line">无可访问模块</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 历史申请与审批进度 -->
    <section class="mp-sec">
      <h2 class="sec-title"><Icon name="list" :size="18" />历史申请与审批进度</h2>

      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="!requests.length" class="state-box empty">
        <Icon name="doc" :size="34" />
        <p>暂无申请记录</p>
        <button class="btn btn-primary btn-sm" @click="goApply"><Icon name="plus" :size="15" />去申请权限</button>
      </div>

      <div v-else class="timeline">
        <div v-for="r in requests" :key="r.id" class="tl-item card">
          <div class="tl-top">
            <div class="tl-roles">
              <span v-for="role in r.applyRoles" :key="role" class="role-chip chip-blue">{{ role }}</span>
            </div>
            <span class="tl-status" :class="`st-${statusMeta(r.status).c}`">
              <Icon :name="statusMeta(r.status).icon" :size="13" />{{ statusMeta(r.status).t }}
            </span>
          </div>
          <p class="tl-reason" v-if="r.reason"><b>申请理由：</b>{{ r.reason }}</p>

          <!-- 进度步骤 -->
          <div class="steps">
            <div class="step done">
              <span class="dot"><Icon name="check" :size="11" /></span>
              <div class="step-txt"><b>已提交申请</b><em>{{ fmt(r.createdAt) }}</em></div>
            </div>
            <div class="step-line" :class="{ active: r.status !== 'pending' }"></div>
            <div class="step" :class="{ done: r.status !== 'pending', cur: r.status === 'pending' }">
              <span class="dot">
                <Icon v-if="r.status !== 'pending'" name="check" :size="11" />
                <Icon v-else name="clock" :size="11" />
              </span>
              <div class="step-txt">
                <b v-if="r.status === 'pending'">超级管理员审批中</b>
                <b v-else-if="r.status === 'approved'">审批通过</b>
                <b v-else>审批驳回</b>
                <em v-if="r.status !== 'pending'">{{ r.operator || '系统' }} · {{ fmt(r.operatedAt) }}</em>
                <em v-else>等待超级管理员处理</em>
              </div>
            </div>
          </div>

          <div class="tl-result" :class="`res-${statusMeta(r.status).c}`">
            <Icon :name="statusMeta(r.status).icon" :size="14" />
            <span>{{ statusMeta(r.status).desc }}</span>
          </div>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
.mp { max-width: 1000px; margin: 0 auto; padding: 28px 24px 48px; display: flex; flex-direction: column; gap: 26px; }
.mp-hero { position: relative; overflow: hidden; padding: 26px 28px; display: flex; align-items: center; justify-content: space-between; }
.hero-bg { position: absolute; inset: 0; background: linear-gradient(120deg, var(--brand-soft) 0%, transparent 60%); pointer-events: none; }
.hero-main { display: flex; align-items: center; gap: 18px; position: relative; z-index: 1; }
.hero-ava { width: 68px; height: 68px; border-radius: 50%; color: #fff; font-size: 24px; font-weight: 700; display: grid; place-items: center; overflow: hidden; box-shadow: var(--shadow-brand); flex-shrink: 0; }
.hero-ava img { width: 100%; height: 100%; object-fit: cover; }
.hero-info h1 { font-size: 22px; font-weight: 800; }
.hero-info p { font-size: 13px; color: var(--text-3); margin-top: 4px; }
.hero-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.hero-apply { position: relative; z-index: 1; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 18px; border-radius: 11px; background: var(--brand); color: #fff; font-size: 14px; font-weight: 600; box-shadow: var(--shadow-brand); transition: all .2s; }
.hero-apply:hover { background: var(--brand-strong); transform: translateY(-1px); }
.mp-sec { display: flex; flex-direction: column; gap: 14px; }
.sec-title { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: var(--text-1); }
.sec-title svg { color: var(--brand); }
.perm-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.perm-card { padding: 18px; }
.pc-hd { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 14px; }
.pc-hd svg { color: var(--brand); }
.tag-wrap, .mod-wrap { display: flex; flex-wrap: wrap; gap: 8px; }
.role-chip { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.chip-blue { background: #e0eaff; color: #3b6cf5; }
.chip-orange { background: #fff1e6; color: #d97a1a; }
.chip-green { background: #dcfce7; color: #16a34a; }
.chip-gray { background: #f0f2f6; color: #8b94a8; }
.mod-chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 8px; font-size: 12.5px; color: var(--text-2); background: var(--bg-soft); }
.mod-chip svg { color: var(--green); }
.empty-line { font-size: 13px; color: var(--text-4); }
.state-box { padding: 40px; text-align: center; color: var(--text-4); font-size: 14px; background: #fff; border: 1px dashed var(--border-strong); border-radius: 14px; }
.state-box.empty { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.state-box.empty svg { color: var(--text-4); opacity: .6; }
.timeline { display: flex; flex-direction: column; gap: 16px; }
.tl-item { padding: 20px 22px; }
.tl-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tl-roles { display: flex; flex-wrap: wrap; gap: 6px; }
.tl-status { display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.st-orange { background: #fff1e6; color: #d97a1a; }
.st-green { background: #dcfce7; color: #16a34a; }
.st-red { background: #fee2e2; color: #dc2626; }
.tl-reason { font-size: 13px; color: var(--text-2); margin: 14px 0 4px; line-height: 1.6; }
.tl-reason b { color: var(--text-3); font-weight: 600; }
.steps { display: flex; align-items: center; margin: 16px 0 14px; }
.step { display: flex; align-items: center; gap: 10px; }
.step .dot { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-soft); color: var(--text-4); flex-shrink: 0; transition: all .2s; }
.step.done .dot { background: var(--green); color: #fff; }
.step.cur .dot { background: #fff7ed; color: #d97a1a; border: 1.5px solid #f5b366; }
.step-txt { display: flex; flex-direction: column; line-height: 1.4; }
.step-txt b { font-size: 13px; font-weight: 600; color: var(--text-1); }
.step-txt em { font-size: 11px; font-style: normal; color: var(--text-4); margin-top: 2px; }
.step-line { flex: 1; height: 2px; background: var(--border); margin: 0 12px; min-width: 30px; }
.step-line.active { background: var(--green); }
.tl-result { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 10px; font-size: 12.5px; }
.res-orange { background: #fff7ed; color: #b45309; }
.res-green { background: #f0fdf4; color: #15803d; }
.res-red { background: #fef2f2; color: #b91c1c; }
@media (max-width: 760px) { .perm-grid { grid-template-columns: 1fr; } }
</style>