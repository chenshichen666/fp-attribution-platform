import { config } from '../db/pool.js'

// 使用 Node 20 内置原生 fetch（全局），不再依赖 node-fetch
const fetch = globalThis.fetch

// 转发到 Knot AGUI 网关，使用调用方自己的 token；解析 SSE 流，聚合为完整文本
export async function generate({ token, userEng, message, model, images = [], background = '' }) {
  if (!config.knotApiUrl) throw new Error('未配置 KNOT_API_URL')
  if (!token) { const e = new Error('NO_TOKEN'); e.code = 'NO_TOKEN'; throw e }

  const body = {
    input: {
      message,
      conversation_id: '',
      model: model || 'deepseek-v4-pro',
      stream: false,
      enable_web_search: false,
      chat_extra: {
        agent_client_uuid: '',
        attached_images: images,
        extra_headers: {},
        background_knowledge: background,
      },
      temperature: 0.5,
    },
  }

  const resp = await fetch(config.knotApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-knot-api-token': token,
      'x-knot-api-user': userEng || '',
    },
    body: JSON.stringify(body),
  })

  const text = await resp.text()
  if (!resp.ok) {
    const e = new Error(`Knot 网关返回 ${resp.status}: ${text.slice(0, 300)}`)
    e.status = resp.status
    throw e
  }

  // 兼容：非流式可能直接返回 JSON；也兼容 SSE 多行 data:
  let content = ''
  let conversationId = ''

  // 先尝试整体解析（非流式 JSON 响应）
  try {
    const full = JSON.parse(text)
    // 尝试多种可能的字段路径
    content = full.output?.content || full.content || full.rawEvent?.content || full.data?.output?.content || full.data?.content || ''
    conversationId = full.rawEvent?.conversation_id || full.conversation_id || full.data?.conversation_id || ''
    if (content) {
      return { content: content.trim(), conversationId }
    }
  } catch { /* 非完整 JSON，继续尝试 SSE 解析 */ }

  // SSE 多行 data: 流式解析
  const lines = text.split('\n')
  let parsedAny = false
  for (let line of lines) {
    line = line.trim()
    if (!line) continue
    if (line.startsWith('data:')) line = line.slice(5).trim()
    if (line === '[DONE]') break
    try {
      const msg = JSON.parse(line)
      parsedAny = true
      if (msg.rawEvent?.conversation_id) conversationId = msg.rawEvent.conversation_id
      if (msg.type === 'TEXT_MESSAGE_CONTENT' && msg.rawEvent?.content) {
        content += msg.rawEvent.content
      } else if (typeof msg.content === 'string') {
        content += msg.content
      } else if (msg.output?.content) {
        content += msg.output.content
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
  if (!parsedAny) content = text // 整体就是纯文本

  return { content: content.trim(), conversationId }
}
