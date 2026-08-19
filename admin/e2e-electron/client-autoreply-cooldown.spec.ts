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

// M13 AI 自动回复「同一会话最小间隔」：保存时 Math.max(5, Number(v)||20) 钳制。
// autoreply-config 只覆盖了话术/关键词，间隔字段的持久化与「低于 5 秒钳到 5」此前没测。
test('客户端设置：自动回复最小间隔持久化且低于 5 秒被钳到 5', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-arcd-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  const openCooldown = () =>
    win.locator('label.field', { hasText: '同一会话最小间隔' }).locator('input')
  const gotoSettings = async (): Promise<void> => {
    await win.locator('.rail-nav', { hasText: '设置' }).click()
  }
  const leaveAndReturn = async (): Promise<void> => {
    await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
    await gotoSettings()
  }

  await gotoSettings()
  const field = openCooldown()
  await expect(field).toBeVisible({ timeout: 10_000 })

  // 正常值 45 → 落库并回显 45
  await field.fill('45')
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await leaveAndReturn()
  await expect(openCooldown()).toHaveValue('45', { timeout: 10_000 })

  // 低于下限（2）→ 保存钳到 5，回显 5
  await openCooldown().fill('2')
  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-90-autoreply-cooldown.png` })

  await leaveAndReturn()
  await expect(openCooldown()).toHaveValue('5', { timeout: 10_000 })

  await app.close()
})
