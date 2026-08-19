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

// LINE 凭证账号：Channel Access Token / Channel Secret / Provider ID(判重用) 表单
test('客户端添加 LINE 账号：凭证表单含 Token/Secret/Provider ID', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-line-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.getByTitle('添加 WhatsApp 账号').click()
  await win.locator('.picker-item', { hasText: 'LINE' }).click()

  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  // 三个凭证字段
  await modal.locator('label', { hasText: 'Channel Access Token' }).locator('input').fill('e2e-access-token')
  await modal.locator('label', { hasText: 'Channel Secret' }).locator('input').fill('e2e-channel-secret')
  await modal.locator('label', { hasText: 'Provider ID' }).locator('input').fill('provider-e2e')
  await expect(modal.getByText('Provider ID（判重用，同 Provider 的账号填一样）')).toBeVisible()
  await expect(modal.getByRole('button', { name: '保存并连接' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-43-line-account.png` })
  await app.close()
})
