import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const clientRequire = createRequire(join(CLIENT_DIR, 'package.json'))
const ELECTRON_PATH = clientRequire('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

test('客户端：账号设置不暴露云同步内部配置', async () => {
  // 复位共享 userData 的 locale（前面的 RTL 用例留下了 locale=ar），保证英文界面可用结构选择器
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'en' }), 'utf8')
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-cloudsync-ignored')}`],
    env: { ...process.env, OMNI_USER_DATA: USER_DATA }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 打开「设置」→ 最后一个页签（账号）。
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await expect(win.locator('.page-tabs button')).not.toHaveCount(0)
  await win.locator('.page-tabs button').last().click()

  await expect(win.getByText('Account information', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(win.getByRole('heading', { name: 'Change password', exact: true })).toBeVisible()
  await expect(win.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
  await expect(win.getByText(/Roam preferences|云端漫游偏好/)).toHaveCount(0)
  await expect(win.getByText(/Upload media files|同时上传媒体文件/)).toHaveCount(0)
  await expect(win.getByText('127.0.0.1:8798')).toHaveCount(0)

  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-04-cloudsync.png` })
  await app.close()
})
