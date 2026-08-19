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

// 平台凭证：全局 Telegram API ID / API Hash（普通账号 MTProto 登录用）填写并持久化
test('客户端平台凭证：Telegram API ID/Hash 填写并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-plat-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.page-tabs button', { hasText: '平台凭证' }).click()

  const apiId = win.locator('label.field', { hasText: 'Telegram API ID' }).locator('input')
  await expect(apiId).toBeVisible({ timeout: 10_000 })
  await apiId.fill('2040123')
  await win.locator('label.field', { hasText: 'Telegram API Hash' }).locator('input').fill('e2ehashabcdef0123456789')

  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-57-platform-creds.png` })

  // 跳走再回：API ID 持久化
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.page-tabs button', { hasText: '平台凭证' }).click()
  await expect(win.locator('label.field', { hasText: 'Telegram API ID' }).locator('input')).toHaveValue('2040123')

  await app.close()
})
