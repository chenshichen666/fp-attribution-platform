import { ref, computed } from 'vue'
import { notificationApi } from '../api'

// 全局通知状态：工单 + 审批 待处理计数
const ticketsCount = ref(0)
const approvalCount = ref(0)
// 用户已"看过"的计数快照（localStorage 持久化），用于判断是否显示红点
const seenTickets = ref(parseInt(localStorage.getItem('fp_seen_tickets') || '0', 10))
const seenApproval = ref(parseInt(localStorage.getItem('fp_seen_approval') || '0', 10))

let pollTimer = null

// 实际未读数 = 后端返回的待处理数 - 已看过数（最小 0）
const unreadTickets = computed(() => Math.max(0, ticketsCount.value - seenTickets.value))
const unreadApproval = computed(() => Math.max(0, approvalCount.value - seenApproval.value))
const hasUnread = computed(() => unreadTickets.value > 0 || unreadApproval.value > 0)

async function fetch() {
  try {
    const data = await notificationApi.get()
    if (data) {
      ticketsCount.value = data.tickets || 0
      approvalCount.value = data.approval || 0
    }
  } catch { /* 静默 */ }
}

function markRead(type) {
  if (type === 'tickets' || type === 'all') {
    seenTickets.value = ticketsCount.value
    localStorage.setItem('fp_seen_tickets', String(seenTickets.value))
  }
  if (type === 'approval' || type === 'all') {
    seenApproval.value = approvalCount.value
    localStorage.setItem('fp_seen_approval', String(seenApproval.value))
  }
  notificationApi.markRead(type).catch(() => {})
}

function startPolling(intervalMs = 60000) {
  fetch()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(fetch, intervalMs)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

export function useNotificationStore() {
  return {
    ticketsCount,
    approvalCount,
    unreadTickets,
    unreadApproval,
    hasUnread,
    fetch,
    markRead,
    startPolling,
    stopPolling,
  }
}
