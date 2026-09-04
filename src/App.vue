<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useSessionStore, setRestored } from './stores/session'
import { primeRemoteBaseline } from './utils/usePersistedRef'
import ToastHost from './components/ToastHost.vue'

const auth = useAuthStore()
const session = useSessionStore()
const route = useRoute()
const ready = ref(false)
let bootDone = false

async function boot() {
  if (bootDone) return
  bootDone = true
  try { await auth.refresh() } catch { /* 刷新角色失败不阻断 */ }
  // 拉取服务端 UI 状态镜像（用于换设备恢复），作为各模块初始化基线
  await session.loadRemote()
  primeRemoteBaseline(session.remote)
  // 恢复上次停留视图（跨设备延续）：登录后跳回上次模块与位置
  if (!session.restored && session.lastView && session.lastView.path) {
    session.markRestored()
    setRestored(true)
    import('./router').then(({ default: router }) => router.replace(session.lastView))
  }
  ready.value = true
}

onMounted(() => {
  if (auth.isLogin) boot()
  else ready.value = true
})

// 登录完成后（LoginView → 路由切换）触发恢复
watch(
  () => auth.isLogin,
  (v) => { if (v && !bootDone) boot() }
)

// 记录当前视图（供下次进入恢复 + 服务端镜像）
watch(
  () => route.fullPath,
  () => {
    if (auth.isLogin && ready.value) {
      session.recordView({
        name: route.name,
        path: route.fullPath,
        query: { ...route.query },
        params: { ...route.params },
      })
    }
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="!ready" class="boot">
    <div class="boot-spin"></div>
    <p>正在恢复你的工作区…</p>
  </div>
  <router-view v-else v-slot="{ Component }">
    <transition name="fade" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
  <ToastHost />
</template>

<style scoped>
.boot { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; background: #fff; color: var(--text-3); }
.boot-spin { width: 36px; height: 36px; border: 3px solid var(--border); border-top-color: var(--brand); border-radius: 50%; animation: spin .8s linear infinite; }
.boot p { font-size: 14px; }
@keyframes spin { to { transform: rotate(360deg) } }
</style>
