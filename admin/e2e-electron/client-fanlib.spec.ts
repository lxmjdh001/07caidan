import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = join(homedir(), 'Library', 'Application Support', 'OmniChat E2E')

test('客户端重粉库：粘贴名单导入建库并核对条数', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-lib-ignored')}`] })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '重粉库' }).click()

  // 切到「导入名单」模式，填库名 + 粘贴三个号码
  const card = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  await card.getByRole('button', { name: '导入名单' }).click()
  await card.locator('input[type="text"]').first().fill('老粉库E2E')
  await card.locator('textarea').first().fill('+15551110001\n+15551110002\n+15551110003')
  await card.getByRole('button', { name: '导入建库' }).click()

  // 「已有重粉库」出现该库，条数为 3
  const row = win.locator('section.form-card').filter({ hasText: '已有重粉库' }).locator('*', { hasText: '老粉库E2E' }).first()
  await expect(win.getByText('老粉库E2E').first()).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText(/3\s*条/).first()).toBeVisible()
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-20-fanlib.png` })
  await app.close()
})
