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

// M9 重粉库删除：已有库点删除（window.confirm）→ deleteLibrary → 从列表消失。
// fanlib* 用例都只覆盖建库，删除此前没测。库名唯一避免共享 tenant 累积。
test('客户端重粉库：删除已有库从列表消失', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-fld-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  win.on('dialog', (d) => void d.accept())
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const libName = `待删库E2E${Date.now().toString(36).slice(-5)}`
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

  // 建库
  const card = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  await card.getByRole('button', { name: '导入名单' }).click()
  await card.locator('input[type="text"]').first().fill(libName)
  await card.locator('textarea').first().fill('+15559990001\n+15559990002')
  await card.getByRole('button', { name: '导入建库' }).click()

  // 已有重粉库出现该库
  const existing = win.locator('section.form-card').filter({ hasText: '已有重粉库' })
  const row = existing.locator('li', { hasText: libName })
  await expect(row).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-93-fanlib-delete.png` })

  // 点该库的删除（confirm 已自动接受）→ 从列表消失
  await row.getByRole('button', { name: '删除' }).click()
  await expect(existing.locator('li', { hasText: libName })).toHaveCount(0, { timeout: 10_000 })

  await app.close()
})
