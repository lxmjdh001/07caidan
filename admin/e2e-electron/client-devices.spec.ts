import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
// electron 装在 client/，从那里解析出可执行文件路径给 Playwright
const clientRequire = createRequire(join(CLIENT_DIR, 'package.json'))
const ELECTRON_PATH = clientRequire('electron') as string

test('客户端：注册登录 → 团队管理 → 登录设备（远程下线）截图', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-client-e2e-'))
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, OMNI_DISABLE_TRAY: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 唯一邮箱，避免与上次 e2e 数据撞号
  const email = `boss_${Date.now().toString(36)}@e2e.test`

  // AuthGate 默认登录态，先切到注册
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()

  // 进入主界面：侧栏导航出现
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 打开「团队管理」（boss 有 team:manage）
  await win.getByText(/团队管理|Team/).first().click()

  // 「登录设备」区块出现，且至少列出本机（注册时已上报 deviceId）
  await expect(win.getByRole('heading', { name: /登录设备|Devices/ })).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText(/本机|This device/)).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(500)
  await win.screenshot({ path: `${SHOT_DIR}/client-01-devices.png` })

  // 深色校对：模拟系统深色（客户端默认「跟随系统」），同页再截一张
  await win.emulateMedia({ colorScheme: 'dark' })
  await win.waitForTimeout(500)
  await expect(win.getByText(/本机|This device/)).toBeVisible()
  await win.screenshot({ path: `${SHOT_DIR}/client-02-devices-dark.png` })

  await app.close()
})
