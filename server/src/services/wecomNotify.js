// 使用 Node 20 内置原生 fetch（全局），不再依赖 node-fetch
const fetch = globalThis.fetch

const WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || ''
const PLATFORM_URL = process.env.PLATFORM_URL || ''

function mdEscape(s) {
  return String(s || '').replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, '\\$1')
}

function buildTicketLink(ticketId) {
  if (!PLATFORM_URL) return `工单ID: ${ticketId}`
  return `${PLATFORM_URL}/#/tickets?t=${ticketId}`
}

function urgencyText(u) {
  return u === 3 ? '🔴 高优' : u === 1 ? '⚪ 低' : '🟡 中'
}

function resultTypeText(rt) {
  if (rt === 'real_fp') return '真实误杀'
  if (rt === 'machine_right') return '机审正确'
  return '未选择'
}

function mentionedList(users) {
  if (!users || !users.length) return []
  return users.filter(Boolean)
}

function buildMentionLine(users) {
  const list = mentionedList(users)
  if (!list.length) return ''
  return list.map((u) => `@${u}`).join(' ') + '\n'
}

function buildMentionedList(users) {
  const list = mentionedList(users)
  if (!list.length) return []
  return list
}

function buildContent(parts) {
  return parts.filter(Boolean).join('\n')
}

function sendMarkdown(content, mentionedList = []) {
  if (!WEBHOOK_URL) {
    console.warn('[wecomNotify] WECOM_WEBHOOK_URL 未配置，跳过通知')
    return Promise.resolve({ ok: false, skipped: true })
  }
  const body = {
    msgtype: 'markdown',
    markdown: { content },
  }
  return fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      const text = await r.text()
      if (!r.ok) {
        console.error(`[wecomNotify] 企微通知发送失败 ${r.status}: ${text}`)
        return { ok: false, status: r.status, body: text }
      }
      try {
        const j = JSON.parse(text)
        if (j.errcode && j.errcode !== 0) {
          console.error(`[wecomNotify] 企微返回错误 errcode=${j.errcode}: ${j.errmsg}`)
          return { ok: false, errcode: j.errcode, errmsg: j.errmsg }
        }
      } catch { /* 非 JSON 响应，忽略 */ }
      return { ok: true }
    })
    .catch((e) => {
      console.error(`[wecomNotify] 请求异常: ${e.message}`)
      return { ok: false, error: e.message }
    })
}

function notifyTicketCreated(ticket, notifyUsers) {
  const mentionLine = buildMentionLine(notifyUsers)
  const content = buildContent([
    `### 📋 新工单提需 ${buildTicketLink(ticket.id)}`,
    mentionLine,
    `> **标签**: ${ticket.tagId || '—'} - ${mdEscape(ticket.tag) || '未命名'}`,
    `> **元素类型**: ${mdEscape(ticket.elementType) || '—'}`,
    `> **行业**: ${mdEscape(ticket.industryL1) || '未分类'}/${mdEscape(ticket.industryL2) || '其他'}`,
    `> **紧急程度**: ${urgencyText(ticket.urgency)}`,
    `> **提需人**: ${mdEscape(ticket.submitter)}`,
    `> **样本数**: ${ticket.sampleCount || 0}`,
    '',
    `请处理人尽快受理，提需人可在平台查看进度。`,
  ])
  return sendMarkdown(content, buildMentionedList(notifyUsers))
}

function notifyTicketConcluded(ticket, submitter) {
  const mentionLine = buildMentionLine([submitter])
  const content = buildContent([
    `### ✅ 工单已提交结论 ${buildTicketLink(ticket.id)}`,
    mentionLine,
    `> **标题**: ${mdEscape(ticket.title)}`,
    `> **处理人**: ${mdEscape(ticket.handler) || '—'}`,
    `> **结论**: ${mdEscape(ticket.conclusion) || '—'}`,
    `> **处理原因**: ${mdEscape(ticket.handleReason) || '—'}`,
    `> **是否合格**: ${ticket.isQualified === null || ticket.isQualified === undefined ? '未标注' : (ticket.isQualified ? '合格' : '不合格')}`,
    '',
    `提需人请尽快查看结论并采纳或退回。`,
  ])
  return sendMarkdown(content, buildMentionedList([submitter]))
}

function notifyTicketAdopted(ticket, submitter) {
  const mentionLine = buildMentionLine([submitter])
  const content = buildContent([
    `### 🎉 工单已采纳完结 ${buildTicketLink(ticket.id)}`,
    mentionLine,
    `> **标题**: ${mdEscape(ticket.title)}`,
    `> **问题分类**: ${mdEscape(ticket.category) || '—'}`,
    `> **结果类型**: ${resultTypeText(ticket.resultType)}`,
    `> **处理人**: ${mdEscape(ticket.handler) || '—'}`,
    `> **提需人**: ${mdEscape(ticket.submitter)}`,
    '',
    `归因结论已自动入库结论沉淀库。`,
  ])
  return sendMarkdown(content, buildMentionedList([submitter]))
}

function notifyTicketRejected(ticket, submitter, reason) {
  const mentionLine = buildMentionLine([ticket.handler])
  const content = buildContent([
    `### ↩️ 工单已被退回 ${buildTicketLink(ticket.id)}`,
    mentionLine,
    `> **标题**: ${mdEscape(ticket.title)}`,
    `> **退回原因**: ${mdEscape(reason)}`,
    `> **提需人**: ${mdEscape(ticket.submitter)}`,
    '',
    `处理人请尽快修改结论后重新提交。`,
  ])
  return sendMarkdown(content, buildMentionedList([ticket.handler]))
}

function notifyTicketReopened(ticket, submitter) {
  const mentionLine = buildMentionLine([ticket.handler])
  const content = buildContent([
    `### 🔁 工单已重开 ${buildTicketLink(ticket.id)}`,
    mentionLine,
    `> **标题**: ${mdEscape(ticket.title)}`,
    `> **提需人**: ${mdEscape(ticket.submitter)}`,
    '',
    `工单已重新打开，可修改结论后重新采纳入库。`,
  ])
  return sendMarkdown(content, buildMentionedList([ticket.handler]))
}

export default {
  notifyTicketCreated,
  notifyTicketConcluded,
  notifyTicketAdopted,
  notifyTicketRejected,
  notifyTicketReopened,
}