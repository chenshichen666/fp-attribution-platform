import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config, getPoolStatus } from './db/pool.js'
import { runMigrations } from './db/init.js'
import { identify } from './middleware/auth.js'
import { dataMode } from './middleware/dataMode.js'

import authRoutes from './routes/auth.js'
import usersRoutes from './routes/users.js'
import ticketsRoutes from './routes/tickets.js'
import sedimentsRoutes from './routes/sediments.js'
import feedbackRoutes from './routes/feedback.js'
import tagsRoutes from './routes/tags.js'
import auditRoutes from './routes/audit.js'
import dashboardRoutes from './routes/dashboard.js'
import overviewRoutes from './routes/overview.js'
import aiRoutes from './routes/ai.js'
import dataMetaRoutes from './routes/dataMeta.js'
import materialsRoutes from './routes/materials.js'
import notificationsRoutes from './routes/notifications.js'
import classifyUploadRoutes from './routes/classifyUpload.js'
import sharesRoutes from './routes/shares.js'
import uiStateRoutes from './routes/uiState.js'
import tragRoutes from './routes/trag.js'
import badcaseRoutes from './routes/badcase.js'

const app = express()
app.use(cors())
// API 响应禁缓存。
// 必须加：mock 数据会反复重建，而 Express 的 JSON 响应默认不带 Cache-Control，
// 浏览器会自由缓存 GET 结果 —— 用户刷新看到的还是几小时前的旧数据
// （实测表象：工单素材 46 条旧的、精度 100%、误杀量 0，而服务端数据早已正确）。
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  next()
})
app.use(express.json({ limit: '1gb' }))
app.use(express.urlencoded({ extended: true, limit: '1gb' }))
app.use(express.raw({ type: '*/*', limit: '1gb' }))
app.use(identify) // 全局身份识别
app.use(dataMode) // 数据模式识别：draft / prod

app.get('/api/health', async (req, res) => {
  const poolStatus = getPoolStatus()
  res.json({
    ok: true,
    db: 'up',
    dbType: 'sqlite',
    pool: poolStatus,
    // TRAG 检索由本地引擎承接（外网无内网向量集群），功能真实可用
    trag: {
      status: 'local',
      mode: 'local',
      available: true,
      note: '本地检索引擎（文本 bigram+TF-IDF 余弦 / 结构化近邻 / 指纹近邻）',
    },
    uptime: process.uptime(),
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/manage', usersRoutes)
app.use('/api/tickets', ticketsRoutes)
app.use('/api/sediments', sedimentsRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/tags', tagsRoutes)
app.use('/api/overview', overviewRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/ai', aiRoutes)
app.use('/api/data-meta', dataMetaRoutes)
app.use('/api/materials', materialsRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/classify-upload', classifyUploadRoutes)
app.use('/api/shares', sharesRoutes)
app.use('/api/ui-state', uiStateRoutes)
app.use('/api/trag', tragRoutes)
app.use('/api/badcase', badcaseRoutes)

// tauth 代理 → 外网不可达，直接返回降级响应
app.use('/ts:auth', async (req, res) => {
  res.json({ error: 'tauth_unavailable', message: 'Demo 模式，tauth 鉴权已禁用' })
})

// 媒体代理 → 外网模式：直接返回占位图或透传原始 URL
app.get('/api/media-proxy', async (req, res) => {
  const targetUrl = req.query.url
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    res.status(200).set('content-type', 'image/svg+xml').send(svg)
    return
  }
  // 外网模式：尝试直接代理；若失败则返回占位图
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const r = await globalThis.fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (r.ok) {
      const ct = r.headers.get('content-type') || 'application/octet-stream'
      const cl = r.headers.get('content-length')
      res.status(200).set('content-type', ct)
      if (cl) res.set('content-length', cl)
      res.set('access-control-allow-origin', '*')
      res.set('cache-control', 'public, max-age=1800')
      const { Readable } = await import('node:stream')
      const nodeBody = r.body ? Readable.fromWeb(r.body) : null
      if (nodeBody) { nodeBody.pipe(res) } else { res.end() }
      return
    }
  } catch { /* 代理失败，返回占位图 */ }
  // 返回占位图
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect fill="#f0f0f0" width="200" height="150"/><text x="100" y="75" text-anchor="middle" fill="#999" font-size="12">媒体不可用</text></svg>'
  res.status(200).set('content-type', 'image/svg+xml').set('cache-control', 'no-store').send(svg)
})

// 媒体签名刷新 → 外网模式直接返回原始 URL
app.get('/api/media-sign', (req, res) => {
  const targetUrl = req.query.url
  if (!targetUrl) return res.status(400).json({ error: 'invalid url' })
  res.json({ url: targetUrl, resigned: false, reason: 'demo-mode' })
})

// 生产环境：托管前端构建产物 + SPA fallback
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../../dist')
const prototypeDir = path.resolve(__dirname, '../../prototype')
// 上传目录：TRAG「以图搜图」上传的图片落盘于此（外网无商数 API）
const uploadsDir = path.resolve(__dirname, '../public/uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '7d',
  setHeaders: (res) => res.set('access-control-allow-origin', '*'),
}))

if (fs.existsSync(prototypeDir)) {
  app.use('/prototype', express.static(prototypeDir, { extensions: ['html'] }))
}
if (fs.existsSync(distDir)) {
  // 所有静态资源强制 no-store：企业代理会无视 max-age/no-cache 缓存旧 JS 包，
  // 导致发版后浏览器仍跑旧 bundle（表现为"改了没生效"）。no-store 可彻底规避。
  app.use(express.static(distDir, {
    setHeaders: (res) => {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.set('Pragma', 'no-cache')
    },
  }))
  // SPA fallback：API 与静态资源目录不拦截。
  app.get(/^\/(?!api\/|ts:auth|prototype\/|uploads\/).*/, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.set('Pragma', 'no-cache')
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

// 错误处理
app.use((err, req, res, next) => {
  console.error('[ERR]', err.message)
  res.status(err.status || 500).json({ error: err.message || '服务器错误' })
})

// 启动
;(async () => {
  // SQLite 无需连通性检测，直接建表
  try {
    await runMigrations()
    console.log('✅ 数据库迁移完成（SQLite）')
  } catch (e) {
    console.error('[迁移] 执行失败:', e.message)
  }

  const port = config.port
  app.listen(port, '0.0.0.0', () => {
    console.log(`✅ 后端已启动 http://0.0.0.0:${port}`)
    console.log(`   数据库类型: SQLite`)
    console.log(`   TRAG 检索: 本地引擎（文本/结构化/指纹近邻，功能可用）`)
  })
})()
