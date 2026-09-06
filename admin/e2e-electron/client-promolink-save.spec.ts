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

// M10 推广链接保存：生成带追踪码的入口链接后保存到「已保存的推广链接」列表
test('客户端推广链接：保存到已保存列表', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-plsave-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const TAG = Date.now().toString(36).slice(-5)
  const note = `FB广告组${TAG}`
  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTitle('添加 WhatsApp 账号').click()
  await win.locator('.picker-item', { hasText: 'WhatsApp' }).click()
  await expect(win.locator('.account-platform-group', { hasText: 'WhatsApp' })).toBeVisible()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.locator('.page-tabs button', { hasText: '推广链接' }).click()

  // 填手机号 + 追踪码 + 来源备注 → 保存此链接
  await win.locator('label.field', { hasText: '账号联系方式' }).locator('input').fill('8613800138000')
  await win.locator('label.field', { hasText: '追踪码' }).locator('input').fill('fb0001')
  await win.locator('label.field', { hasText: '来源备注' }).locator('input').fill(note)
  await win.getByRole('button', { name: '保存此链接' }).click()

  // 已保存的推广链接列表出现该备注
  await expect(win.getByText('已保存的推广链接')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText(note).first()).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-75-promolink-save.png` })
  await app.close()
})
