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

// M9 LINE 重粉库 Provider 隔离：选 LINE 平台时出现 Provider ID 字段与跨 Provider 提示
test('客户端重粉库：LINE 平台需填 Provider ID（隔离约束）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-fll-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '重粉库' }).click()

  const card = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  await card.getByRole('button', { name: '导入名单' }).click()
  // 平台切到 LINE → 出现 Provider ID 字段 + 跨 Provider 提示
  await card.locator('label', { hasText: '平台' }).locator('select').selectOption('line')
  await expect(card.locator('label', { hasText: 'Provider ID' }).locator('input')).toBeVisible({ timeout: 10_000 })
  await expect(card.getByText(/只在同一 Provider 内有效/)).toBeVisible()

  const libName = `LINE库E2E${Date.now().toString(36).slice(-4)}`
  await card.locator('input[type="text"]').first().fill(libName)
  await card.locator('label', { hasText: 'Provider ID' }).locator('input').fill('provider-abc')
  // LINE userId 必须是 U + 32 位十六进制
  await card.locator('textarea').first().fill('U0123456789abcdef0123456789abcdef\nUfedcba9876543210fedcba9876543210')
  await card.getByRole('button', { name: '导入建库' }).click()

  // 结果：已导入 2 个；已有库出现该 LINE 库
  await expect(card.getByText(/已导入 2 个/)).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('section.form-card').filter({ hasText: '已有重粉库' }).getByText(libName).first()).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-77-fanlib-line.png` })
  await app.close()
})
