import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 客户端（Electron）UI 冒烟：真起后台 + 真启动打包后的 Electron 客户端，
 * 走真实注册 → 进入主界面 → 打开「团队管理」→ 截「登录设备」。
 * 前置：先用 BRAND=e2e 构建 client（apiUrl 指向本测试后台 8798）。
 */
const SERVER_PORT = 8798
const DATA_DIR = process.env.E2E_DATA_DIR || '/private/tmp/omnichat-e2e-data'

// Electron 截图同样落到系统临时目录，避免外置工作盘的 AppleDouble/监听抖动。
process.env.SHOT_DIR ||= join(tmpdir(), 'wzzscrm-electron-e2e-shots')

export default defineConfig({
  testDir: './e2e-electron',
  // 外置盘可能生成 AppleDouble `._*` 元数据；它不是源码，禁止 Playwright 当作 spec 解析。
  testIgnore: ['**/._*'],
  // 跑完清掉共享持久库里 E2E 遗留的重粉库/公告，防跨运行累积拖慢或污染后续用例
  globalTeardown: './e2e-electron/global-teardown.ts',
  timeout: 120_000,
  fullyParallel: false,
  // 单 worker 顺序执行：并行启动多个 Electron + 共享后台会剧烈争抢，制造大面积
  // 假性 flaky（各用例单独跑均通过）。顺序执行消除争抢，稳定且总时长可控。
  workers: 1,
  // 顺序下仍偶发启动/注册竞速，重试一次吸收（非产品 bug）
  retries: 1,
  reporter: [['list']],
  webServer: [
    {
      command: 'node --experimental-strip-types src/index.ts',
      cwd: '../server',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        OMNI_DATA_DIR: DATA_DIR,
        OMNI_ADMIN_USER: 'admin',
        OMNI_ADMIN_PASSWORD: 'admin'
      }
    }
  ]
})
