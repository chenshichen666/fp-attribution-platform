import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // 生产构建产物使用相对路径，确保部署在平台任意子路径/预览网关前缀下
  // （如 /_w6mhti/ 或根域名）都能正确加载 /assets/* 资源，避免整批 JS/CSS 404。
  // 如需绝对基路径，可通过环境变量 VITE_BASE_PATH 覆盖。
  base: process.env.VITE_BASE_PATH || './',
  server: {
    host: '0.0.0.0',
    port: 36111,
    strictPort: true,
    cors: true,
    origin: process.env.VITE_DEV_ORIGIN || undefined,
    allowedHosts: [
      '.preview.platform.example.com',
      '.devnet-preview.platform.example.com',
      '.test-preview.platform.example.com',
      '.devc.preview.platform.example.com',
      '.example.com',
      'localhost',
      '127.0.0.1',
    ],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // 企业微信统一登录态（tauth）：转发到公司鉴权网关，前端据此拿到当前登录人 EngName
      '/ts:auth': {
        target: process.env.VITE_TAUTH_TARGET || 'https://auth.example.com',
        changeOrigin: true,
        secure: false,
      },
    },
    watch: {
      usePolling: true,
      interval: 100,
    },
    hmr: true,
  },
})