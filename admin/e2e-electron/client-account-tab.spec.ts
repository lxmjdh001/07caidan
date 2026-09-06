import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

// 设置「账号」页：显示登录邮箱/后台地址 + 同步媒体开关持久化
test('客户端设置账号页：显示账号信息且同步媒体开关持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-acctab-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '账号' }).click()

  // 账号信息：登录邮箱 + 后台地址
  await expect(win.getByText(email)).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.account-key', { hasText: '127.0.0.1:8798' })).toBeVisible()

  // 同步媒体开关（默认开）→ 关掉 → 保存
  const syncMedia = win.locator('label.checkbox', { hasText: '同时上传媒体文件' }).locator('input[type="checkbox"]')
  await expect(syncMedia).toBeChecked()
  await syncMedia.uncheck()
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-58-account-tab.png` })

  // 跳走再回：同步媒体仍为关
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '账号' }).click()
  await expect(
    win.locator('label.checkbox', { hasText: '同时上传媒体文件' }).locator('input[type="checkbox"]')
  ).not.toBeChecked()

  await app.close()
})
