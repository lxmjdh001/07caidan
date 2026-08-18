import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const clientRequire = createRequire(join(CLIENT_DIR, 'package.json'))
const ELECTRON_PATH = clientRequire('electron') as string
const USER_DATA = join(homedir(), 'Library', 'Application Support', 'OmniChat E2E')

test('客户端：设置里「云端漫游偏好」开关存在且默认开启', async () => {
  // 复位共享 userData 的 locale（前面的 RTL 用例留下了 locale=ar），保证英文界面可用结构选择器
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'en' }), 'utf8')
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-cloudsync-ignored')}`]
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 打开「设置」→ 最后一个页签（后台账号），云同步开关在此
  await win.locator('.rail-nav', { hasText: /设置|Settings/ }).click()
  await expect(win.locator('.page-tabs button')).not.toHaveCount(0)
  await win.locator('.page-tabs button').last().click()

  const label = win.getByText(/云端漫游偏好|Roam preferences/)
  await expect(label).toBeVisible({ timeout: 10_000 })
  // 该项复选框默认勾选
  const checkbox = label.locator('xpath=ancestor::label').locator('input[type="checkbox"]')
  await expect(checkbox).toBeChecked()

  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-04-cloudsync.png` })
  await app.close()
})
