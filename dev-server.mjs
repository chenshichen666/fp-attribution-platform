// 开发/预览编排器：同步拉起「后端 Express」与「Vite 前端」两个进程。
// 解决之前预览环境只跑 Vite（端口 36111）而没跑后端，导致 /api 代理到 8787 无进程监听、所有接口 500 的问题。
//
// 端口约定：
//  - Vite 固定监听 36111（平台预览网关 devc.preview.platform.example.com）
//  - Vite 把 /api 代理到 http://127.0.0.1:8787
//  - 后端默认监听 config.port = PORT || 8787，与代理目标一致
//  - 后端在 index.js 里有「双端口监听」逻辑（生产 8000 + 预览 36111），
//    但预览态下 36111 已被 Vite 占用，因此这里显式 PREVIEW_PORT=8787，
//    使 PREVIEW_PORT === config.port，跳过第二监听，避免端口冲突。
//
// DB 凭据：优先从环境变量读取；若平台未注入（如本地/沙箱预览），回退到与 .with/Dockerfile 一致的值，确保预览稳定。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── DB 凭据（与 .with/Dockerfile 保持一致，作为平台未注入时的兜底）──
const DB_ENV = {
  DB_HOST: process.env.DB_HOST || process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT || '3306',
  DB_NAME: process.env.DB_NAME || process.env.DB_NAME,
  DB_USER: process.env.DB_USER || process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD || process.env.DB_PASSWORD,
}

// 合并后的子进程环境变量
const childEnv = {
  ...process.env,
  ...DB_ENV,
  // 后端主端口对齐平台生产探针端口 8000：预览网关把 /api、/ts:auth 这类业务路径
  // 转发到 8000，若不在此端口监听，网关会直接返回 404（本地直连 Vite:36111 能通只是绕过了网关）。
  PORT: process.env.PORT || '8000',
  // 额外监听 8787 作为健康检查/备用端口（≠PORT，触发 index.js 的双端口监听），与 Vite 代理目标一致。
  PREVIEW_PORT: process.env.PREVIEW_PORT || '8787',
  NODE_ENV: process.env.NODE_ENV || 'development',
}

// 复用当前进程环境变量（含上面注入的 DB_*、PORT、PREVIEW_PORT）
function makeEnv(extra = {}) {
  return { ...childEnv, ...extra }
}

// ── 启动后端 ──
const backend = spawn('node', ['server/src/index.js'], {
  cwd: __dirname,
  env: makeEnv(),
  stdio: 'pipe',
})

// ── 启动前端（Vite）──
const frontend = spawn('node', ['node_modules/vite/bin/vite.js'], {
  cwd: __dirname,
  env: makeEnv(),
  stdio: 'pipe',
})

function log(name, stream) {
  stream.on('data', (chunk) => {
    const text = chunk.toString()
    for (const line of text.split('\n')) {
      if (line.trim()) process.stdout.write(`[${name}] ${line}\n`)
    }
  })
}
log('backend', backend.stdout)
log('backend', backend.stderr)
log('frontend', frontend.stdout)
log('frontend', frontend.stderr)

// 任一进程退出都打印提示（便于排查）
backend.on('exit', (code, signal) => {
  console.log(`[backend] 进程退出 code=${code} signal=${signal}`)
})
frontend.on('exit', (code, signal) => {
  console.log(`[frontend] 进程退出 code=${code} signal=${signal}`)
})

// 转发退出信号，确保两个子进程都被正确回收
function shutdown(signal) {
  console.log(`\n[dev-server] 收到 ${signal}，正在关闭子进程...`)
  frontend.kill(signal)
  backend.kill(signal)
  // 给一点时间让子进程回收，然后退出
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
