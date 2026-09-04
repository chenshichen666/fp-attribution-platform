<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useNotificationStore } from '../stores/notification'
import { dataMetaApi } from '../api'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import { authApi, feedbackApi } from '../api'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()
const notif = useNotificationStore()

// 数据更新时间（所有账号共享显示）
const dataMeta = ref({ updatedAt: '', updatedBy: '', fileName: '', isDraft: false })
onMounted(async () => {
  try {
    const meta = await dataMetaApi.get()
    if (meta) {
      // 兼容新格式 { aiEval, tagPrecision } 和旧格式 { updatedAt, ... }
      if (meta.aiEval || meta.tagPrecision) {
        // 优先显示 AI评测明细数据的状态，若没有则显示策略标签的
        const primary = meta.aiEval?.updatedAt ? meta.aiEval : meta.tagPrecision
        dataMeta.value = primary || { updatedAt: '', updatedBy: '', fileName: '', isDraft: false }
      } else {
        dataMeta.value = { ...meta, isDraft: false }
      }
    }
  } catch { /* 忽略 */ }

  // 启动通知轮询
  notif.startPolling()
})

// 进入对应模块页面时自动标记已读
watch(() => route.name, (name) => {
  if (name === 'tickets') notif.markRead('tickets')
  if (name === 'manageApproval') notif.markRead('approval')
})
watch(() => route.path, (path) => {
  if (path === '/manage/approval') notif.markRead('approval')
})

onUnmounted(() => { notif.stopPolling() })

const navs = computed(() => {
  const all = [
    { name: 'analysis', label: '总览', icon: 'layout-dashboard', roles: ['submitter', 'admin'] },
    { name: 'classify', label: '误杀Case分析', icon: 'classify', roles: ['submitter', 'admin'] },
    { name: 'tickets', label: '问题提需', icon: 'ticket', roles: ['submitter', 'handler', 'admin'] },
    { name: 'sediment', label: '结论沉淀', icon: 'sediment', roles: ['submitter', 'handler', 'admin'] },
  ]
  return all.filter((n) => n.roles.some((r) => auth.roles.includes(r)))
})

const showManage = computed(() => auth.isAdmin)
const manageOpen = ref(false)
const userMenuOpen = ref(false)
const fbOpen = ref(false)
const fbContent = ref('')
const fbType = ref('功能建议')
const fbShots = ref([])  // 已选截图列表 [{ url, name, size }]
const fbDragOver = ref(false)
const fileInput = ref(null)
const avatarUrl = ref('')

if (auth.avatar) {
  const probe = new Image()
  probe.onload = () => { avatarUrl.value = auth.avatar }
  probe.onerror = () => { /* 头像加载失败，静默降级为文字头像 */ }
  probe.src = auth.avatar
}

function active(name) {
  if (name === 'analysis') return route.path.startsWith('/analysis')
  if (name === 'classify') return route.path.startsWith('/classify')
  if (name === 'manage') return route.path.startsWith('/manage')
  return route.name === name
}
function go(name) { router.push({ name }); manageOpen.value = false }
// 复制当前账号标识
// （原实现为拉起企业微信客户端 wework:// 协议，仅内网且装了企业微信时可用，
//   外网 Demo 模式改为复制账号标识）
async function copyMyAccount() {
  const eng = auth.user?.eng
  if (!eng) {
    toast.warn('无法获取当前账号信息')
    return
  }
  try {
    await navigator.clipboard.writeText(eng)
    toast.success(`已复制账号：${eng}`)
  } catch {
    toast.info(`当前账号：${eng}`)
  }
  userMenuOpen.value = false
}
function goMyPermission() { userMenuOpen.value = false; router.push('/my-permission') }
function switchAccount() { auth.logout(); router.push('/login') }
function logout() { auth.logout(); router.push('/login') }

function openFb() {
  fbOpen.value = true
}
function closeFb() {
  fbOpen.value = false
}

// 图片上传相关
const MAX_SIZE = 5 * 1024 * 1024  // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif']

function handleFileSelect() {
  fileInput.value?.click()
}

function onFileChange(e) {
  const files = Array.from(e.target.files || [])
  processFiles(files)
  e.target.value = ''  // 允许重复选择同一文件
}

function onDrop(e) {
  e.preventDefault()
  fbDragOver.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  processFiles(files)
}

function onDragOver(e) {
  e.preventDefault()
  fbDragOver.value = true
}

function onDragLeave() {
  fbDragOver.value = false
}

function processFiles(files) {
  for (const file of files) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.warn(`${file.name} 格式不支持，仅支持 jpg/png/gif`)
      continue
    }
    if (file.size > MAX_SIZE) {
      toast.warn(`${file.name} 超过 5MB 限制`)
      continue
    }
    const url = URL.createObjectURL(file)
    fbShots.value.push({ url, name: file.name, size: file.size })
  }
}

function removeShot(index) {
  const shot = fbShots.value[index]
  if (shot?.url) URL.revokeObjectURL(shot.url)
  fbShots.value.splice(index, 1)
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / 1024 / 1024).toFixed(1) + 'MB'
}

function submitFb() {
  if (!fbContent.value.trim()) { toast.warn('请填写反馈内容'); return }
  const shotsCount = fbShots.value.length
  feedbackApi.submit({
    type: fbType.value,
    content: fbContent.value.trim(),
    shots: shotsCount,
  }).then(() => {
    toast.success(`反馈已提交，感谢你的建议${shotsCount ? `（含 ${shotsCount} 张截图）` : ''}`)
    // 清理
    fbShots.value.forEach(s => s.url && URL.revokeObjectURL(s.url))
    fbShots.value = []
    fbContent.value = ''
    fbType.value = '功能建议'
    fbOpen.value = false
  }).catch(e => {
    toast.warn(e.message || '提交反馈失败')
  })
}
const roleText = computed(() => auth.user.roleTag.map((r) => r.t).join(' · '))
</script>

<template>
  <header class="hdr">
    <div class="hdr-inner">
      <!-- 品牌 -->
      <div class="brand" @click="go(navs[0]?.name)">
<span class="brand-logo"><Icon name="target" :size="20" /></span>
        <div class="brand-txt">
          <strong>误杀样本归因</strong>
          <em>FALSE-POSITIVE ATTRIBUTION</em>
        </div>
      </div>

      <!-- 一级导航 -->
      <nav class="nav">
        <button v-for="n in navs" :key="n.name" class="nav-item" :class="{ on: active(n.name) }" @click="go(n.name)">
          <Icon :name="n.icon" :size="16" /><span>{{ n.label }}</span>
          <span v-if="n.name === 'tickets' && notif.unreadTickets.value > 0" class="nav-badge">{{ notif.unreadTickets.value > 99 ? '99+' : notif.unreadTickets.value }}</span>
        </button>
        <div v-if="showManage" class="nav-drop" @mouseenter="manageOpen = true" @mouseleave="manageOpen = false">
          <button class="nav-item" :class="{ on: active('manage') }">
            <Icon name="settings" :size="16" /><span>管理</span><Icon name="chevronDown" :size="13" />
            <span v-if="notif.unreadApproval.value > 0" class="nav-badge">{{ notif.unreadApproval.value > 99 ? '99+' : notif.unreadApproval.value }}</span>
          </button>
          <transition name="pop">
            <div v-if="manageOpen" class="drop-menu manage-menu">
              <button @click="router.push('/manage/dashboard')"><Icon name="chart" :size="16" />数据大盘</button>
              <button @click="router.push('/manage/data')"><Icon name="database" :size="16" />数据管理</button>
              <button @click="router.push('/manage/users')"><Icon name="users" :size="16" />用户管理</button>
              <button @click="router.push('/manage/approval')"><Icon name="checkCircle" :size="16" />权限审批<span v-if="notif.unreadApproval.value > 0" class="menu-badge">{{ notif.unreadApproval.value > 99 ? '99+' : notif.unreadApproval.value }}</span></button>
              <button @click="router.push('/manage/audit')"><Icon name="shield" :size="16" />审计日志</button>
              <button @click="go('manageFeedback')"><Icon name="feedback" :size="16" />意见反馈</button>
            </div>
          </transition>
        </div>
      </nav>

      <!-- 右侧 -->
      <div class="hdr-right">
        <span v-if="dataMeta.updatedAt" class="data-update-badge" :class="{ draft: dataMeta.isDraft }">
          <Icon name="clock" :size="13" />数据更新至 {{ dataMeta.updatedAt }}
        </span>
        <button class="fb-btn" @click="fbOpen = true"><Icon name="feedback" :size="16" />意见反馈</button>
        <div class="user" @mouseenter="userMenuOpen = true" @mouseleave="userMenuOpen = false">
          <span class="avatar" :style="{ background: auth.user.color }">
            <img v-if="avatarUrl" :src="avatarUrl" alt="" />
            <template v-else>{{ auth.user.initial }}</template>
          </span>
          <div class="user-txt">
            <strong>{{ auth.user.name }}</strong>
            <em>{{ roleText }}</em>
          </div>
          <Icon name="chevronDown" :size="14" class="user-arrow" />
          <transition name="pop">
            <div v-if="userMenuOpen" class="drop-menu user-menu">
              <button @click="copyMyAccount"><Icon name="copy" :size="16" />复制我的账号</button>
              <button @click="goMyPermission"><Icon name="list" :size="16" />我的权限</button>
              <div class="drop-sep"></div>
              <button @click="logout"><Icon name="back" :size="16" />退出登录</button>
            </div>
          </transition>
        </div>
      </div>
    </div>
  </header>

  <!-- 意见反馈弹窗 -->
  <Modal v-model="fbOpen" title="意见反馈" width="480px">
    <div class="fb-form">
      <label>当前用户</label>
      <input class="field" :value="auth.user.name" disabled />
      <label>反馈内容 <i>*</i></label>
      <textarea class="field ta" v-model="fbContent" placeholder="请描述你遇到的问题或建议…"></textarea>
      <label>上传截图（选填）</label>
      <div
        class="up-box"
        :class="{ dragover: fbDragOver }"
        @click="handleFileSelect"
        @drop="onDrop"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
      >
        <Icon name="upload" :size="24" />
        <span>点击或拖拽上传，jpg/png/gif，单张 ≤ 5MB</span>
        <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/gif" multiple hidden @change="onFileChange" />
      </div>
      <div v-if="fbShots.length" class="shot-list">
        <div v-for="(shot, i) in fbShots" :key="i" class="shot-item">
          <img :src="shot.url" :alt="shot.name" class="shot-thumb" />
          <div class="shot-info">
            <span class="shot-name">{{ shot.name }}</span>
            <span class="shot-size">{{ formatSize(shot.size) }}</span>
          </div>
          <button class="shot-remove" @click="removeShot(i)"><Icon name="close" :size="14" /></button>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost btn-sm" @click="closeFb">取消</button>
      <button class="btn btn-primary btn-sm" @click="submitFb">提交反馈</button>
    </template>
  </Modal>
</template>

<style scoped>
.hdr { position: sticky; top: 0; z-index: 100; background: #fff; border-bottom: 1px solid var(--border); box-shadow: 0 2px 12px rgba(0,0,0,.04); }
.hdr-inner { width: 100%; height: 112px; padding: 0 52px; display: flex; align-items: center; gap: 44px; }
.brand { display: flex; align-items: center; gap: 12px; cursor: pointer; flex-shrink: 0; }
.brand-logo { width: 64px; height: 64px; border-radius: 10px; background: var(--brand-grad); color: #fff; display: grid; place-items: center; box-shadow: var(--shadow-brand); }
.brand-txt { display: flex; flex-direction: column; line-height: 1.2; }
.brand-txt strong { font-size: 28px; font-weight: 800; color: var(--text-1); }
.brand-txt em { font-size: 12px; font-style: normal; color: var(--text-4); letter-spacing: .6px; }

.nav { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.nav-item { display: flex; align-items: center; gap: 10px; height: 66px; padding: 0 24px; border-radius: 12px; font-size: 20px; font-weight: 600; color: var(--text-2); transition: all .18s; white-space: nowrap; flex-shrink: 0; position: relative; }
.nav-badge { position: absolute; top: 6px; right: 4px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 8px; background: #ff4d4f; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1; box-shadow: 0 2px 6px rgba(255,77,79,.4); animation: badge-pulse 2s ease-in-out infinite; }
.menu-badge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #ff4d4f; color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; line-height: 1; }
@keyframes badge-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
.nav-item:hover { background: var(--bg-soft); color: var(--text-1); }
.nav-item.on { background: var(--brand-soft); color: var(--brand); font-weight: 800; box-shadow: inset 0 -3px 0 var(--brand); }
.nav-drop { position: relative; }
.drop-menu { position: absolute; top: calc(100% + 8px); left: 0; min-width: 180px; background: #fff; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 6px; z-index: 20; }
.drop-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px; border-radius: 8px; font-size: 14px; color: var(--text-2); transition: all .15s; }
.drop-menu button:hover { background: var(--brand-soft); color: var(--brand); }
.manage-menu { min-width: 200px; }

.hdr-right { margin-left: auto; display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
.data-update-badge { display: flex; align-items: center; gap: 5px; padding: 5px 11px; background: #f0fdf4; color: #16a34a; border-radius: 8px; font-size: 12px; font-weight: 500; border: 1px solid #bbf7d0; white-space: nowrap; }
.data-update-badge svg { color: #16a34a; }
.data-update-badge.draft { background: #fff7ed; color: #ea580c; border-color: #fed7aa; }
.data-update-badge.draft svg { color: #ea580c; }
.fb-btn { display: flex; align-items: center; gap: 7px; height: 42px; padding: 0 14px; border-radius: 10px; font-size: 14px; color: var(--text-2); transition: all .18s; }
.fb-btn:hover { background: var(--bg-soft); color: var(--brand); }
.user { position: relative; display: flex; align-items: center; gap: 10px; padding: 4px 12px 4px 4px; border-radius: 12px; cursor: pointer; transition: background .18s; }
.user:hover { background: var(--bg-soft); }
.avatar { width: 40px; height: 40px; border-radius: 50%; color: #fff; font-size: 13px; font-weight: 700; display: grid; place-items: center; overflow: hidden; flex-shrink: 0; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.user-txt { display: flex; flex-direction: column; line-height: 1.2; }
.user-txt strong { font-size: 14px; font-weight: 600; }
.user-txt em { font-size: 11px; font-style: normal; color: var(--text-3); }
.user-arrow { color: var(--text-4); }
.user-menu { right: 0; left: auto; min-width: 280px; }
.perm-panel { padding: 14px 16px 10px; }
.perm-hd { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--text-1); margin-bottom: 12px; }
.perm-hd svg { color: var(--brand); }
.perm-body { display: flex; flex-direction: column; gap: 10px; }
.perm-row { display: flex; align-items: flex-start; gap: 10px; }
.perm-label { font-size: 12px; color: var(--text-4); min-width: 48px; padding-top: 2px; }
.perm-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.perm-tag { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.perm-tag-blue { background: #e0eaff; color: #3b6cf5; }
.perm-tag-orange { background: #fff1e6; color: #d97a1a; }
.perm-tag-green { background: #dcfce7; color: #16a34a; }
.perm-tag-gray { background: #f0f2f6; color: #8b94a8; }
.perm-modules { display: flex; flex-wrap: wrap; gap: 5px; }
.perm-mod { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 6px; font-size: 11px; color: var(--text-3); background: var(--bg-soft); }
.perm-val { font-size: 12px; color: var(--text-3); display: inline-flex; align-items: center; gap: 4px; }
.perm-val.ok { color: #16a34a; }
.drop-sep { height: 1px; background: var(--border); margin: 4px 0; }

.fb-form { display: flex; flex-direction: column; gap: 8px; }
.fb-form label { font-size: 13px; font-weight: 500; color: var(--text-2); margin-top: 6px; }
.fb-form label i { color: var(--red); }
.fb-form .ta { height: 110px; padding: 12px 14px; resize: none; line-height: 1.6; }
.up-box { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px; border: 1.5px dashed var(--border-strong); border-radius: 12px; color: var(--text-3); font-size: 12px; cursor: pointer; transition: all .18s; }
.up-box:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.up-box.dragover { border-color: var(--brand); background: var(--brand-soft); border-style: solid; }
.shot-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.shot-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-soft); transition: all .15s; }
.shot-item:hover { border-color: var(--brand); }
.shot-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 8px; flex-shrink: 0; }
.shot-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.shot-name { font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shot-size { font-size: 11px; color: var(--text-4); }
.shot-remove { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; color: var(--text-4); transition: all .15s; flex-shrink: 0; }
.shot-remove:hover { background: #fee; color: var(--red); }
</style>