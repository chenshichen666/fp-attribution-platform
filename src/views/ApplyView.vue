<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { manageApi, authApi } from '../api'
import Icon from '../components/Icon.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const ROLES = [
  { v: 'submitter', t: '提需人', desc: '上传评测数据、分析误杀、发起工单并采纳结论 · 免审批', icon: 'analysis', c: 'blue' },
  { v: 'handler', t: '处理人', desc: '指派处理、填写归因结论、案例沉淀 · 免审批', icon: 'ticket', c: 'orange' },
  { v: 'admin', t: '管理员', desc: '权限审批、用户管理、数据大盘、审计合规 · 需超级管理员审批', icon: 'shield', c: 'green' },
]
const picked = ref([])
const reason = ref('')
const team = ref('')
const submitted = ref(false)
const checking = ref(false)
let pollTimer = null

function toggle(v) {
  const i = picked.value.indexOf(v)
  if (i >= 0) picked.value.splice(i, 1)
  else picked.value.push(v)
}
const canSubmit = computed(() => picked.value.length && reason.value.trim() && team.value.trim())

async function submit() {
  if (!canSubmit.value) { toast.warn('请完整填写申请信息'); return }
  const applyRoles = ROLES.filter(r => picked.value.includes(r.v)).map(r => r.t)
  const hasAdmin = picked.value.includes('admin')
  try {
    const res = await manageApi.applyRequest({ applyRoles, reason: reason.value.trim() })
    submitted.value = true
    if (hasAdmin) {
      toast.success('管理员申请已提交，等待超级管理员审批')
      startPolling()
    } else {
      toast.success('申请已提交')
      setTimeout(async () => {
        await auth.refresh()
        if (auth.hasRole) {
          router.push('/')
        }
      }, 600)
    }
  } catch (e) {
    toast.warn(e.message || '提交申请失败')
  }
}

// 轮询检查审批状态：每 10 秒拉取一次我的申请记录，发现 approved 则刷新角色并跳转
function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    if (checking.value) return
    checking.value = true
    try {
      const list = await authApi.myRequests()
      const hasApproved = list.some(r => r.status === 'approved')
      if (hasApproved) {
        stopPolling()
        await auth.refresh()
        if (auth.hasRole) {
          toast.success('审批已通过，正在进入平台…')
          setTimeout(() => router.push('/'), 600)
        }
      }
    } catch { /* 静默重试 */ } finally {
      checking.value = false
    }
  }, 10000)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// 手动检查审批状态
async function manualCheck() {
  checking.value = true
  try {
    const list = await authApi.myRequests()
    const hasApproved = list.some(r => r.status === 'approved')
    if (hasApproved) {
      stopPolling()
      await auth.refresh()
      if (auth.hasRole) {
        toast.success('审批已通过，正在进入平台…')
        setTimeout(() => router.push('/'), 600)
      }
    } else {
      toast.info('暂无新的审批结果，请耐心等待')
    }
  } catch (e) {
    toast.warn('检查失败，请稍后重试')
  } finally {
    checking.value = false
  }
}

onUnmounted(stopPolling)

function logout() { stopPolling(); auth.logout(); router.push('/login') }
</script>

<template>
  <div class="apply">
    <header class="ap-hdr">
      <div class="brand">
        <span class="brand-logo"><Icon name="target" :size="22" /></span>
<div class="brand-txt"><strong>误杀样本归因</strong><em>FALSE-POSITIVE ATTRIBUTION</em></div>
      </div>
      <div class="ap-user">
        <span class="ava" :style="{ background: auth.user?.color }">{{ auth.user?.initial }}</span>
        <span>{{ auth.user?.name }}</span>
        <button class="logout" @click="logout"><Icon name="back" :size="15" />退出</button>
      </div>
    </header>

    <main class="ap-main">
      <transition name="fade" mode="out-in">
        <!-- 申请表单 -->
        <div v-if="!submitted" key="form" class="ap-card card rise">
          <div class="ap-banner">
            <span class="ban-ic"><Icon name="shield" :size="26" /></span>
            <div>
              <h2>申请管理员权限</h2>
              <p>提需人/处理人角色已为你自动开通，可直接使用平台。如需管理员权限（权限审批、用户管理、数据大盘等），请填写申请理由，需超级管理员审批。</p>
            </div>
          </div>

          <label class="fl">申请角色 <i>*</i></label>
          <div class="role-grid">
            <button v-for="r in ROLES" :key="r.v" class="role-pick" :class="{ on: picked.includes(r.v) }" @click="toggle(r.v)">
              <span class="rp-ic" :class="`c-${r.c}`"><Icon :name="r.icon" :size="20" /></span>
              <div class="rp-body">
                <strong>{{ r.t }}</strong>
                <span>{{ r.desc }}</span>
              </div>
              <span class="rp-check" :class="{ on: picked.includes(r.v) }"><Icon name="check" :size="13" /></span>
            </button>
          </div>

          <div class="fl-row">
            <div class="fl-col">
              <label class="fl">所在团队 <i>*</i></label>
              <input class="field" v-model="team" placeholder="例如：内容安全 / 算法评测" />
            </div>
          </div>
          <label class="fl">申请理由 <i>*</i></label>
          <textarea class="field ta" v-model="reason" placeholder="请简要说明你的业务场景与使用诉求…"></textarea>

          <div class="ap-foot">
            <button class="btn btn-ghost" @click="logout">退出登录</button>
            <button class="btn btn-primary" :disabled="!canSubmit" @click="submit"><Icon name="check" :size="16" />提交申请</button>
          </div>
        </div>

        <!-- 提交成功 -->
        <div v-else key="done" class="ap-card card rise done-card">
          <span class="done-ic"><Icon name="checkCircle" :size="40" /></span>
          <h2>{{ picked.includes('admin') ? '管理员申请已提交' : '申请已提交' }}</h2>
          <p v-if="picked.includes('admin')">管理员角色申请需经超级管理员审批通过后方可使用。页面会自动检测审批结果，通过后将自动进入平台；也可点击下方按钮手动检查。</p>
          <p v-else>你的申请已提交，正在进入平台…</p>
          <div class="done-tags">
            <span v-for="v in picked" :key="v" class="badge badge-blue">{{ ROLES.find(r=>r.v===v).t }}</span>
          </div>
          <div class="ap-foot center">
            <button v-if="picked.includes('admin')" class="btn btn-ghost" @click="submitted=false">返回修改</button>
            <button v-if="picked.includes('admin')" class="btn btn-soft" :disabled="checking" @click="manualCheck">
              <Icon name="refresh" :size="16" />{{ checking ? '检查中…' : '手动检查审批状态' }}
            </button>
            <button class="btn btn-primary" @click="logout"><Icon name="back" :size="16" />退出登录</button>
          </div>
        </div>
      </transition>
    </main>
  </div>
</template>

<style scoped>
.apply { min-height: 100vh; background: var(--bg-page); }
.ap-hdr { height: 64px; padding: 0 32px; display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 11px; }
.brand-logo { width: 38px; height: 38px; border-radius: 11px; background: var(--brand-grad); color: #fff; display: grid; place-items: center; box-shadow: var(--shadow-brand); }
.brand-txt strong { display: block; font-size: 20px; font-weight: 700; }
.brand-txt em { font-style: normal; font-size: 9px; color: var(--text-4); letter-spacing: .5px; }
.ap-user { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); }
.ava { width: 32px; height: 32px; border-radius: 50%; color: #fff; font-weight: 700; display: grid; place-items: center; }
.logout { display: flex; align-items: center; gap: 5px; margin-left: 8px; padding: 6px 12px; border-radius: 8px; color: var(--text-2); font-size: 13px; }
.logout:hover { background: var(--bg-soft); color: var(--brand); }

.ap-main { display: grid; place-items: center; padding: 48px 20px; }
.ap-card { width: 100%; max-width: 620px; padding: 32px; }
.ap-banner { display: flex; gap: 16px; padding: 18px; background: var(--brand-soft); border-radius: 14px; margin-bottom: 24px; }
.ban-ic { width: 52px; height: 52px; border-radius: 14px; background: var(--brand-grad); color: #fff; display: grid; place-items: center; flex-shrink: 0; box-shadow: var(--shadow-brand); }
.ap-banner h2 { font-size: 18px; font-weight: 700; }
.ap-banner p { font-size: 13px; color: var(--text-2); margin-top: 6px; line-height: 1.7; }

.fl { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin: 18px 0 10px; }
.fl i { color: var(--red); }
.fl small { font-weight: 400; color: var(--text-4); margin-left: 8px; }
.role-grid { display: flex; flex-direction: column; gap: 10px; }
.role-pick { display: flex; align-items: center; gap: 14px; padding: 14px 16px; border: 1.5px solid var(--border); border-radius: 14px; background: #fff; transition: all .2s; text-align: left; }
.role-pick:hover { border-color: var(--brand); }
.role-pick.on { border-color: var(--brand); background: var(--brand-soft); }
.rp-ic { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; flex-shrink: 0; }
.c-blue { background: var(--brand-soft); color: var(--brand); }
.c-orange { background: var(--orange-soft); color: #c87f00; }
.c-green { background: var(--green-soft); color: var(--green); }
.rp-body { flex: 1; }
.rp-body strong { display: block; font-size: 14px; font-weight: 600; }
.rp-body span { font-size: 12px; color: var(--text-3); }
.rp-check { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: transparent; transition: all .2s; }
.rp-check.on { background: var(--brand); border-color: var(--brand); color: #fff; }
.fl-row { display: flex; gap: 16px; }
.fl-col { flex: 1; }
.fl-col .field { width: 100%; }
.field.ta { width: 100%; height: 96px; padding: 12px 14px; resize: none; line-height: 1.6; }
.field:not(.ta) { width: 100%; }
.ap-foot { display: flex; justify-content: flex-end; gap: 12px; margin-top: 28px; }
.ap-foot.center { justify-content: center; }

.done-card { text-align: center; padding: 48px 32px; }
.done-ic { display: inline-grid; place-items: center; width: 84px; height: 84px; border-radius: 50%; background: var(--green-soft); color: var(--green); margin-bottom: 18px; }
.done-card h2 { font-size: 22px; font-weight: 800; }
.done-card p { font-size: 14px; color: var(--text-2); line-height: 1.8; margin: 12px auto 18px; max-width: 420px; }
.done-tags { display: flex; justify-content: center; gap: 8px; }
</style>