import { defineConfig } from '@playwright/test'

/**
 * 管理后台 UI 冒烟：真实起 server + admin，用浏览器登录并逐页截图。
 * 无外部依赖 —— server 用临时数据目录（内置 admin/admin 账号），admin 走 vite dev。
 */
const SERVER_PORT = 8798
const ADMIN_PORT = 5198
const DATA_DIR = process.env.E2E_DATA_DIR || '/private/tmp/omnichat-e2e-data'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  // 单 worker 顺序执行：并行跑多个浏览器+共享后台会争抢，共享租户会话变多时
  // 聊天列表加载变慢，点会话偶发超时(与 electron 同因)。顺序执行消除争抢，
  // 后台用例轻量，顺序仍很快且稳定。
  workers: 1,
  // 顺序下仍偶发时序竞速(如全局单例到期提醒)，重试一次吸收(非产品 bug)
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${ADMIN_PORT}`,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN'
  },
  webServer: [
    {
      command: 'node --experimental-strip-types src/index.ts',
      cwd: '../server',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        OMNI_DATA_DIR: DATA_DIR,
        OMNI_ADMIN_USER: 'admin',
        OMNI_ADMIN_PASSWORD: 'admin',
        OMNI_AUTO_TAG: 'true'
      }
    },
    {
      command: `npm run dev -- --port ${ADMIN_PORT} --host 127.0.0.1 --strictPort`,
      cwd: '.',
      url: `http://127.0.0.1:${ADMIN_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_BASE: `http://127.0.0.1:${SERVER_PORT}` }
    }
  ]
})
