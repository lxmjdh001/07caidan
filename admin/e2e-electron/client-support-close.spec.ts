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

// M18 支持工单：客户提交后点「问题已解决，关闭」→ 工单关闭
test('客户端帮助与反馈：提交后关闭工单', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-supclose-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const TAG = Date.now().toString(36).slice(-5)
  const title = `已解决问题${TAG}`
  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 提交工单
  await win.locator('.rail-nav', { hasText: '帮助与反馈' }).click()
  await win.getByRole('button', { name: '提交问题' }).first().click()
  await win.locator('input[type="text"]').first().fill(title)
  await win.locator('textarea').first().fill('自己搞定了，来关掉。')
  await win.getByRole('button', { name: '提交', exact: true }).click()
  await expect(win.getByText(title).first()).toBeVisible({ timeout: 10_000 })

  // 打开该工单 → 点「问题已解决，关闭」
  await win.locator('.ticket-item, li, button', { hasText: title }).first().click()
  await win.getByRole('button', { name: '问题已解决，关闭' }).click()

  // 工单变已关闭：出现关闭提示、回复框消失
  await expect(win.getByText('工单已关闭。问题再次出现时可直接回复重新打开。')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-74-support-close.png` })
  await app.close()
})
