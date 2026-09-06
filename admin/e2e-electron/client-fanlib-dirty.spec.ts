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

// M9 重粉库导入：脏名单(重复+无法识别行)自动归一化并回报问题行
test('客户端重粉库：导入脏名单回报重复与问题行', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-dirty-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.getByRole('button', { name: '重粉库' }).click()

  const card = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  await card.getByRole('button', { name: '导入名单' }).click()
  await card.locator('input[type="text"]').first().fill(`脏名单E2E${Date.now().toString(36).slice(-4)}`)
  // 1 个有效(重复一次) + 2 行无法识别
  await card.locator('textarea').first().fill('+15551119901\ngarbage!!!\n+15551119901\nnot-a-number')
  await card.getByRole('button', { name: '导入建库' }).click()

  // 结果回报：已导入 1 个 · 名单内重复 1 个 · 2 行无法识别
  await expect(card.getByText(/已导入 1 个/)).toBeVisible({ timeout: 10_000 })
  await expect(card.getByText(/名单内重复 1 个/)).toBeVisible()
  await expect(card.getByText(/2 行无法识别/)).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-76-fanlib-dirty.png` })
  await app.close()
})
