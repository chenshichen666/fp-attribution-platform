<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import Icon from '../components/Icon.vue'

const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

const eng = ref('')
const name = ref('')
const collabRole = ref('运营') // 协作角色：运营 / 产品 / 算法
const status = ref('submitter') // 状态：提需人 / 处理人（管理员免选）
const submitting = ref(false)
const showCustom = ref(false) // 是否展开「自定义身份」
const COLLAB_ROLES = ['运营', '产品', '算法']
const STATUS_OPTIONS = [
  { key: 'submitter', label: '提需人', desc: '发起问题提需' },
  { key: 'handler', label: '处理人', desc: '处理与跟进工单' },
]

// 管理员（admin）自动识别，无需选择提需人/处理人状态
const isAdmin = computed(() => eng.value.trim().toLowerCase() === 'admin')

// 外网 Demo 模式：不依赖任何企业微信 / SSO 鉴权，打开即可一键进入
onMounted(async () => {
  // 已有登录态（路由守卫通常已放行，双保险）
  if (auth.isLogin) { router.replace('/'); return }
  eng.value = localStorage.getItem('fp_last_eng') || ''
})

// 完成登录后的公共收尾：记忆身份、清除登出标记、跳转首页
function afterLogin(me, fallbackEng) {
  sessionStorage.removeItem('fp_no_auto_login')
  localStorage.setItem('fp_last_eng', me?.eng || fallbackEng || '')
  toast.success(`已登录：${me?.name || fallbackEng}`)
  setTimeout(() => router.push('/'), 300)
}

// 一键进入（管理员身份）：无需输入任何账号信息
async function quickLogin() {
  if (submitting.value) return
  submitting.value = true
  try {
    let me = null
    try {
      me = await auth.realLogin({ eng: 'admin', name: '演示管理员' })
    } catch { me = null }
    if (!me) {
      // 后端不可达时本地兜底，保证仍可进入平台
      me = auth.manualLogin({
        eng: 'admin', name: '演示管理员',
        collabRole: collabRole.value, status: 'admin',
      })
    } else {
      auth.user = { ...auth.user, collabRole: collabRole.value }
      localStorage.setItem('fp_user', JSON.stringify(auth.user))
    }
    afterLogin(me, 'admin')
  } catch (err) {
    toast.warn(err.message || '登录失败')
  } finally {
    submitting.value = false
  }
}

// 自定义身份登录
async function doLogin() {
  const e = eng.value.trim()
  if (!e) { toast.warn('请输入你的昵称'); return }
  submitting.value = true
  try {
    let me = null
    try {
      me = await auth.realLogin({ eng: e, name: name.value || e })
    } catch { me = null }
    if (!me) {
      me = auth.manualLogin({
        eng: e,
        name: name.value || e,
        collabRole: collabRole.value,
        status: isAdmin.value ? 'admin' : status.value,
      })
    } else {
      auth.user = { ...auth.user, collabRole: collabRole.value }
      localStorage.setItem('fp_user', JSON.stringify(auth.user))
    }
    afterLogin(me, e)
  } catch (err) {
    toast.warn(err.message || '登录失败')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login">
    <!-- 左侧品牌区 -->
    <div class="brand-side">
      <div class="bs-grid"></div>
      <div class="bs-blob b1"></div>
      <div class="bs-blob b2"></div>
      <div class="bs-blob b3"></div>
      <div class="bs-glow"></div>

      <div class="bs-top">
        <span class="bs-logo"><Icon name="target" :size="30" /></span>
        <div>
          <strong>误杀归因平台</strong>
          <em>FALSE-POSITIVE ATTRIBUTION</em>
        </div>
      </div>

      <div class="bs-mid">
        <div class="bs-badge">全链路协作平台</div>
        <h1>让每一次误杀<br /><span class="bs-grad">都有迹可循</span></h1>
        <p>误杀识别 · 误杀Case分析 · 问题提需 · 结论沉淀。帮助团队快速定位、分类与沉淀机审误杀案例。</p>

        <div class="bs-features">
          <div class="bs-feat">
            <span class="bs-fi"><Icon name="search" :size="18" /></span>
            <div><b>误杀识别</b><small>精准定位机审误杀样本</small></div>
          </div>
          <div class="bs-feat">
            <span class="bs-fi"><Icon name="classify" :size="18" /></span>
            <div><b>误杀Case分析</b><small>自动归类素材类型特征</small></div>
          </div>
          <div class="bs-feat">
            <span class="bs-fi"><Icon name="ticket" :size="18" /></span>
            <div><b>问题提需</b><small>工单驱动的协作流程</small></div>
          </div>
          <div class="bs-feat">
            <span class="bs-fi"><Icon name="sediment" :size="18" /></span>
            <div><b>结论沉淀</b><small>归因结论知识库积累</small></div>
          </div>
        </div>
      </div>

      <div class="bs-bottom">
        <div class="bs-stats">
          <div class="bs-stat"><b>4</b><span>核心模块</span></div>
          <div class="bs-stat-sep"></div>
          <div class="bs-stat"><b>3</b><span>协作角色</span></div>
          <div class="bs-stat-sep"></div>
          <div class="bs-stat"><b>99.5%</b><span>可用性</span></div>
        </div>
        <div class="bs-foot">© 2026 误杀归因平台 · 内部协作系统</div>
      </div>
    </div>

    <!-- 右侧登录区：输入名字 + 选择协作角色 + 选择状态（提需人/处理人，管理员免选） -->
    <div class="login-side">
      <div class="login-box">
        <div class="lb-head">
          <h2>误杀归因平台</h2>
          <p class="lb-desc">登录后你的名字与角色将随所有操作留存，便于团队定位</p>
        </div>

        <div class="lb-form">
          <!-- 一键进入：无需任何账号，直接进入（演示模式） -->
          <button class="lb-quick" type="button" :disabled="submitting" @click="quickLogin">
            <span class="lb-quick-ic"><Icon name="shield" :size="20" /></span>
            <span class="lb-quick-txt">
              <b>一键进入</b>
              <small>以管理员身份体验全部功能</small>
            </span>
            <span class="lb-quick-arrow"><Icon name="chevronRight" :size="18" /></span>
          </button>

          <div class="lb-divider"><span>或使用自定义身份</span></div>

          <button class="lb-toggle" type="button" @click="showCustom = !showCustom">
            {{ showCustom ? '收起自定义身份' : '展开自定义身份' }}
            <Icon :name="showCustom ? 'chevronUp' : 'chevronDown'" :size="14" />
          </button>

          <div v-show="showCustom" class="lb-custom" @keydown.enter="doLogin">
            <div class="lb-field">
              <label class="lb-label">你的昵称</label>
              <input class="lb-input" v-model="eng" placeholder="例如：zhangsan" @input="eng = eng.replace(/\s+/g, '')" />
              <p class="lb-note">输入 admin 可获取管理员权限（系统会自动转小写）</p>
            </div>

            <div class="lb-field">
              <label class="lb-label">协作角色</label>
              <div class="lb-roles">
                <button v-for="r in COLLAB_ROLES" :key="r" type="button" class="lb-role" :class="{ on: collabRole === r }" @click="collabRole = r">
                  <Icon :name="r === '运营' ? 'users' : (r === '产品' ? 'target' : 'settings')" :size="15" />{{ r }}
                </button>
              </div>
            </div>

            <div class="lb-field">
              <label class="lb-label">状态</label>
              <div v-if="isAdmin" class="lb-admin-tip">
                <span class="lb-admin-badge"><Icon name="shield" :size="14" />管理员</span>
                <span class="lb-admin-desc">已识别为管理员，免选提需人/处理人状态</span>
              </div>
              <div v-else class="lb-statuses">
                <button v-for="s in STATUS_OPTIONS" :key="s.key" type="button" class="lb-status" :class="{ on: status === s.key }" @click="status = s.key">
                  <b>{{ s.label }}</b><small>{{ s.desc }}</small>
                </button>
              </div>
            </div>

            <button class="lb-submit" type="button" :disabled="submitting" @click="doLogin">
              <Icon name="send" :size="16" />{{ submitting ? '登录中…' : '登录' }}
            </button>
          </div>

          <p class="lb-foot">演示环境，无需企业微信或 SSO 鉴权；登录信息仅保存在本机浏览器</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login { display: flex; min-height: 100vh; }
/* 左侧 */
.brand-side { width: 46%; background: linear-gradient(160deg, #4f7cff 0%, #4569f5 55%, #5b6ef5 100%);
  color: #fff; padding: 56px 60px; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.bs-grid { position: absolute; inset: 0;
  background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
  background-size: 40px 40px; mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 30%, transparent 80%); }
.bs-blob { position: absolute; border-radius: 50%; filter: blur(60px); }
.b1 { width: 300px; height: 300px; right: -80px; top: 20px; background: rgba(140,190,255,.18); }
.b2 { width: 200px; height: 200px; left: -60px; bottom: 100px; background: rgba(170,160,255,.14); }
.b3 { width: 160px; height: 160px; right: 40px; bottom: 160px; background: rgba(120,220,255,.10); }
.bs-glow { position: absolute; top: -20%; left: -10%; width: 60%; height: 60%;
  background: radial-gradient(circle, rgba(255,255,255,.06) 0%, transparent 70%); }
.bs-top { display: flex; align-items: center; gap: 14px; position: relative; z-index: 2; }
.bs-logo { width: 52px; height: 52px; border-radius: 14px; background: rgba(255,255,255,.15); display: grid; place-items: center;
  backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.2); }
.bs-top strong { display: block; font-size: 32px; font-weight: 800; }
.bs-top em { font-style: normal; font-size: 12px; opacity: .7; letter-spacing: 1px; }
.bs-mid { margin-top: auto; position: relative; z-index: 2; }
.bs-badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 20px;
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2); backdrop-filter: blur(10px); margin-bottom: 18px; }
.bs-mid h1 { font-size: 32px; font-weight: 700; line-height: 1.3; letter-spacing: -.5px; }
.bs-grad { background: linear-gradient(135deg, #cfe0ff 0%, #d9d2ff 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.bs-mid p { margin-top: 18px; font-size: 14px; line-height: 1.8; opacity: .85; max-width: 420px; }
.bs-features { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 36px; max-width: 480px; }
.bs-feat { display: flex; align-items: center; gap: 14px; padding: 18px 16px; border-radius: 14px;
  background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); backdrop-filter: blur(8px); transition: all .25s; }
.bs-feat:hover { background: rgba(255,255,255,.14); transform: translateY(-2px); }
.bs-fi { width: 44px; height: 44px; border-radius: 12px; background: rgba(255,255,255,.14); display: grid; place-items: center; flex-shrink: 0; }
.bs-feat b { display: block; font-size: 16px; font-weight: 600; }
.bs-feat small { font-size: 12px; opacity: .75; line-height: 1.4; }
.bs-bottom { margin-top: 36px; position: relative; z-index: 2; }
.bs-stats { display: flex; align-items: center; gap: 24px; }
.bs-stat { display: flex; flex-direction: column; gap: 4px; }
.bs-stat b { font-size: 30px; font-weight: 800; line-height: 1; }
.bs-stat span { font-size: 12px; opacity: .75; }
.bs-stat-sep { width: 1px; height: 28px; background: rgba(255,255,255,.15); }
.bs-foot { margin-top: 20px; font-size: 12px; opacity: .5; }
/* 右侧 */
.login-side { flex: 1; display: grid; place-items: center; padding: 40px; background: #fff; overflow-y: auto; }
.login-box { width: 100%; max-width: 440px; padding: 28px 0; }
.lb-head { text-align: center; margin-bottom: 30px; }
.lb-head h2 { font-size: 26px; font-weight: 800; letter-spacing: -.3px; }
.lb-desc { margin-top: 10px; font-size: 13px; color: var(--text-3); line-height: 1.7; }
.lb-form { display: flex; flex-direction: column; gap: 22px; }
/* 一键进入 */
.lb-quick { display: flex; align-items: center; gap: 14px; width: 100%; padding: 18px 18px; border: none;
  border-radius: 14px; background: var(--brand); color: #fff; cursor: pointer; text-align: left;
  box-shadow: 0 6px 20px rgba(79,124,255,.32); transition: all .2s; }
.lb-quick:hover:not(:disabled) { background: var(--brand-strong); transform: translateY(-2px); box-shadow: 0 10px 28px rgba(79,124,255,.4); }
.lb-quick:disabled { background: #a9bdfa; cursor: not-allowed; box-shadow: none; }
.lb-quick-ic { width: 44px; height: 44px; border-radius: 12px; background: rgba(255,255,255,.18); display: grid; place-items: center; flex-shrink: 0; }
.lb-quick-txt { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.lb-quick-txt b { font-size: 16px; font-weight: 800; }
.lb-quick-txt small { font-size: 12px; opacity: .82; }
.lb-quick-arrow { flex-shrink: 0; opacity: .8; }
/* 分隔线 */
.lb-divider { display: flex; align-items: center; gap: 12px; color: var(--text-4); font-size: 12px; }
.lb-divider::before, .lb-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.lb-toggle { align-self: center; display: inline-flex; align-items: center; gap: 6px; background: none; border: none;
  color: var(--brand); font-size: 13px; font-weight: 600; cursor: pointer; padding: 4px 8px; }
.lb-toggle:hover { text-decoration: underline; }
.lb-custom { display: flex; flex-direction: column; gap: 22px; padding-top: 4px; }
.lb-auto { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 12px; background: var(--brand-soft); border: 1px solid #c9d8ff; }
.lb-auto.fail { background: #fdeeee; border-color: #f5c6c6; }
.lb-auto-spin { width: 18px; height: 18px; border: 2.5px solid var(--brand); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; flex-shrink: 0; }
.lb-auto-ico { font-size: 16px; flex-shrink: 0; }
.lb-auto-txt b { display: block; font-size: 13px; color: var(--text-1); }
.lb-auto-txt small { font-size: 11.5px; color: var(--text-3); line-height: 1.5; }
.lb-field { display: flex; flex-direction: column; gap: 8px; }
.lb-label { font-size: 13px; font-weight: 700; color: var(--text-1); }
.lb-input { height: 44px; border: 1.5px solid var(--border-strong); border-radius: 11px; padding: 0 14px;
  font-size: 14px; color: var(--text-1); background: #fafbfc; transition: all .18s; box-sizing: border-box; }
.lb-input:focus { outline: none; border-color: var(--brand); background: #fff; box-shadow: 0 0 0 4px var(--brand-soft); }
.lb-note { font-size: 11px; color: var(--text-4); }
.lb-roles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.lb-role { display: flex; align-items: center; justify-content: center; gap: 7px; height: 46px; border-radius: 11px;
  border: 1.5px solid var(--border); background: #fafbfc; font-size: 14px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: all .18s; }
.lb-role:hover { border-color: var(--brand); color: var(--brand); }
.lb-role.on { background: var(--brand); border-color: var(--brand); color: #fff; box-shadow: 0 4px 14px rgba(79,124,255,.28); }
.lb-statuses { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lb-status { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 12px 14px; border-radius: 11px;
  border: 1.5px solid var(--border); background: #fafbfc; text-align: left; cursor: pointer; transition: all .18s; }
.lb-status b { font-size: 13px; font-weight: 700; color: var(--text-1); }
.lb-status small { font-size: 11px; color: var(--text-4); line-height: 1.4; }
.lb-status:hover { border-color: var(--brand); }
.lb-status.on { border-color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 3px var(--brand-soft); }
.lb-admin-tip { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 11px; background: #eef7ef; border: 1.5px solid #b9e3c9; }
.lb-admin-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 700; color: #1a9d68; }
.lb-admin-desc { font-size: 12px; color: #4a8a63; }
.lb-submit { display: flex; align-items: center; justify-content: center; gap: 8px; height: 48px; border: none; border-radius: 12px;
  background: var(--brand); color: #fff; font-size: 15px; font-weight: 800; cursor: pointer; transition: all .18s;
  box-shadow: 0 5px 18px rgba(79,124,255,.32); margin-top: 4px; }
.lb-submit:hover:not(:disabled) { background: var(--brand-strong); box-shadow: 0 8px 24px rgba(79,124,255,.4); transform: translateY(-1px); }
.lb-submit:disabled { background: #a9bdfa; cursor: not-allowed; box-shadow: none; }
.lb-foot { text-align: center; font-size: 11.5px; color: var(--text-4); line-height: 1.6; }
@keyframes spin { to { transform: rotate(360deg) } }
@media (max-width: 900px) { .brand-side { display: none; } }
</style>
