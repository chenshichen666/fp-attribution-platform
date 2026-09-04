<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToastStore } from '../../stores/toast'
import { feedbackApi } from '../../api'
import { usePersistedRef } from '../../utils/usePersistedRef'
import Icon from '../../components/Icon.vue'
import Modal from '../../components/Modal.vue'
import EmptyState from '../../components/EmptyState.vue'

const toast = useToastStore()
const list = ref([])
const tab = usePersistedRef('feedback:tab', 'all')
const kw = usePersistedRef('feedback:kw', '')
const typeFilter = usePersistedRef('feedback:typeFilter', '')

async function loadFeedback() {
  try {
    list.value = await feedbackApi.list()
  } catch (e) {
    toast.warn(e.message || '加载反馈列表失败')
  }
}
onMounted(loadFeedback)

const STATUS = {
  pending: { t: '待处理', c: 'orange' },
  processing: { t: '处理中', c: 'blue' },
  resolved: { t: '已解决', c: 'green' },
}
const TYPE_CLS = { '功能建议': 'badge-blue', '体验问题': 'badge-orange', 'Bug 反馈': 'badge-red' }
const types = computed(() => [...new Set(list.value.map(f => f.type))])

const tabs = computed(() => [
  { v: 'all', t: '全部', n: list.value.length },
  { v: 'pending', t: '待处理', n: list.value.filter(f => f.status === 'pending').length },
  { v: 'processing', t: '处理中', n: list.value.filter(f => f.status === 'processing').length },
  { v: 'resolved', t: '已解决', n: list.value.filter(f => f.status === 'resolved').length },
])

const filtered = computed(() => list.value.filter(f => {
  if (tab.value !== 'all' && f.status !== tab.value) return false
  if (typeFilter.value && f.type !== typeFilter.value) return false
  if (kw.value && !f.content.includes(kw.value) && !f.user.includes(kw.value) && !f.id.includes(kw.value)) return false
  return true
}))

const detailOpen = ref(false)
const detail = ref(null)
const replyText = ref('')
function openDetail(f) { detail.value = f; replyText.value = f.reply || ''; detailOpen.value = true }
async function submitReply() {
  if (!replyText.value.trim()) { toast.warn('请填写回复内容'); return }
  const f = detail.value
  const reply = replyText.value.trim()
  const status = f.status === 'pending' ? 'processing' : f.status
  try {
    await feedbackApi.update(f.id, { status, reply })
    f.reply = reply
    f.status = status
    toast.success('回复已发送给反馈用户')
    detailOpen.value = false
  } catch (e) {
    toast.warn(e.message || '发送回复失败')
  }
}
async function markResolved(f) {
  try {
    await feedbackApi.update(f.id, { status: 'resolved', reply: f.reply || '' })
    f.status = 'resolved'
    toast.success(`已将 ${f.id} 标记为已解决`)
  } catch (e) {
    toast.warn(e.message || '操作失败')
  }
}
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="feedback" :size="22" />意见反馈</h1>
      <p class="page-sub">查看并处理用户提交的功能建议、体验问题与 Bug 反馈</p>
    </div>

    <div class="card list-card rise">
      <div class="seg-tabs">
        <button v-for="t in tabs" :key="t.v" :class="{ on: tab === t.v }" @click="tab = t.v">
          {{ t.t }}<b>{{ t.n }}</b>
        </button>
      </div>

      <div class="bar">
        <div class="search"><Icon name="search" :size="16" /><input v-model="kw" placeholder="搜索反馈内容 / 用户 / 编号…" /></div>
        <select class="field sm" v-model="typeFilter">
          <option value="">全部类型</option>
          <option v-for="t in types" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <table v-if="filtered.length" class="tbl">
        <thead>
          <tr><th>编号</th><th>提交用户</th><th>类型</th><th>反馈内容</th><th>提交时间</th><th>状态</th><th class="ta-r">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="f in filtered" :key="f.id">
            <td class="mono dim">{{ f.id }}</td>
            <td>
              <div class="u-cell">
                <span class="u-ava">{{ f.user[0] }}</span>
                <div><b>{{ f.user }}</b><em>{{ f.team }}</em></div>
              </div>
            </td>
            <td><span class="badge" :class="TYPE_CLS[f.type]">{{ f.type }}</span></td>
            <td class="content" @click="openDetail(f)">
              {{ f.content }}
              <span v-if="f.shots" class="shots"><Icon name="upload" :size="12" />{{ f.shots }}</span>
            </td>
            <td class="mono dim">{{ f.createdAt }}</td>
            <td><span class="badge" :class="`badge-${STATUS[f.status].c}`">{{ STATUS[f.status].t }}</span></td>
            <td class="ta-r">
              <button class="btn btn-ghost btn-sm" @click="openDetail(f)">查看</button>
              <button v-if="f.status !== 'resolved'" class="btn btn-primary btn-sm" @click="markResolved(f)">标记解决</button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else icon="feedback" title="暂无反馈" desc="当前筛选条件下没有用户反馈" />
    </div>

    <Modal v-model="detailOpen" title="反馈详情" width="520px">
      <div v-if="detail" class="d">
        <div class="d-row"><span>编号</span><b class="mono">{{ detail.id }}</b></div>
        <div class="d-row"><span>提交用户</span><b>{{ detail.user }} · {{ detail.team }}</b></div>
        <div class="d-row"><span>类型</span><b><span class="badge" :class="TYPE_CLS[detail.type]">{{ detail.type }}</span></b></div>
        <div class="d-row"><span>状态</span><b><span class="badge" :class="`badge-${STATUS[detail.status].c}`">{{ STATUS[detail.status].t }}</span></b></div>
        <div class="d-row"><span>提交时间</span><b class="mono">{{ detail.createdAt }}</b></div>
        <div class="d-block">
          <h5>反馈内容</h5>
          <p class="cont-txt">{{ detail.content }}</p>
        </div>
        <div v-if="detail.shots" class="d-block">
          <h5>附件截图（{{ detail.shots }}）</h5>
          <div class="shot-row">
            <span v-for="n in detail.shots" :key="n" class="shot-ph"><Icon name="upload" :size="18" /></span>
          </div>
        </div>
        <div class="d-block">
          <h5>处理回复</h5>
          <textarea class="field ta" v-model="replyText" placeholder="填写给用户的回复…"></textarea>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost btn-sm" @click="detailOpen = false">取消</button>
        <button class="btn btn-primary btn-sm" @click="submitReply">发送回复</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }
.list-card { padding: 20px 24px; }
.seg-tabs { display: flex; background: #f0f2f6; border-radius: 10px; padding: 3px; width: fit-content; margin-bottom: 16px; }
.seg-tabs button { display: flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: 8px; font-size: 13px; color: var(--text-2); font-weight: 500; }
.seg-tabs button.on { background: #fff; color: var(--text-1); box-shadow: var(--shadow-sm); }
.seg-tabs b { color: var(--brand); }
.bar { display: flex; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text-3); flex: 1; min-width: 220px; }
.search:focus-within { border-color: var(--brand); }
.search input { flex: 1; font-size: 14px; color: var(--text-1); border: none; outline: none; background: transparent; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 11px 12px; color: var(--text-3); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 13px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ta-r { text-align: right; white-space: nowrap; }
.u-cell { display: flex; align-items: center; gap: 10px; }
.u-ava { width: 34px; height: 34px; border-radius: 50%; background: var(--brand-grad); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.u-cell b { font-size: 13px; font-weight: 600; display: block; }
.u-cell em { font-style: normal; font-size: 11px; color: var(--text-4); }
.content { max-width: 320px; color: var(--text-2); cursor: pointer; line-height: 1.5; }
.content:hover { color: var(--brand); }
.shots { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: var(--bg-soft); font-size: 11px; color: var(--text-3); vertical-align: middle; }
.mono { font-family: monospace; font-size: 12px; }
.dim { color: var(--text-4); }
.d-row { display: flex; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.d-row span { width: 80px; color: var(--text-3); flex-shrink: 0; }
.d-block { padding: 14px 0 4px; }
.d-block h5 { font-size: 12px; color: var(--text-3); margin-bottom: 8px; }
.cont-txt { font-size: 14px; line-height: 1.7; color: var(--text-1); background: var(--bg-soft); border-radius: 10px; padding: 12px 14px; }
.shot-row { display: flex; gap: 10px; }
.shot-ph { width: 64px; height: 64px; border-radius: 10px; background: var(--bg-soft); border: 1px solid var(--border); display: grid; place-items: center; color: var(--text-4); }
.ta { width: 100%; height: 88px; padding: 12px 14px; resize: none; line-height: 1.6; }
</style>
