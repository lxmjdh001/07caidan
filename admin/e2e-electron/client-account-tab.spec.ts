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

// 面向客户的「账号」页只显示账号安全与通知，不暴露后台地址、同步策略等内部配置。
test('客户端设置账号页：仅显示客户设置且通知开关持久化', async () => {
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

  // 账号信息与安全设置可见；后台地址、云同步和媒体归档等内部选项不可见。
  await expect(win.getByText(email)).toBeVisible({ timeout: 10_000 })
  await expect(win.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible()
  await expect(win.getByRole('heading', { name: '消息提醒', exact: true })).toBeVisible()
  await expect(win.getByText('127.0.0.1:8798')).toHaveCount(0)
  await expect(win.getByText('同时上传媒体文件')).toHaveCount(0)
  await expect(win.getByText('云端漫游偏好设置')).toHaveCount(0)

  // 通知声音（默认开）→ 关掉 → 保存。
  const notifySound = win.locator('label.checkbox', { hasText: '通知提示音' }).locator('input[type="checkbox"]')
  await expect(notifySound).toBeChecked()
  await notifySound.uncheck()
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-58-account-tab.png` })

  // 跳走再回：通知偏好仍为关。
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '账号' }).click()
  await expect(
    win.locator('label.checkbox', { hasText: '通知提示音' }).locator('input[type="checkbox"]')
  ).not.toBeChecked()

  await app.close()
})
