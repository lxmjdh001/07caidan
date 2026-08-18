import { defineConfig } from '@playwright/test'

/**
 * 客户端（Electron）UI 冒烟：真起后台 + 真启动打包后的 Electron 客户端，
 * 走真实注册 → 进入主界面 → 打开「团队管理」→ 截「登录设备」。
 * 前置：先用 BRAND=e2e 构建 client（apiUrl 指向本测试后台 8798）。
 */
const SERVER_PORT = 8798
const DATA_DIR = process.env.E2E_DATA_DIR || '/private/tmp/omnichat-e2e-data'

export default defineConfig({
  testDir: './e2e-electron',
  timeout: 120_000,
  fullyParallel: false,
  reporter: [['list']],
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
        OMNI_ADMIN_PASSWORD: 'admin'
      }
    }
  ]
})
