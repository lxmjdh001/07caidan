import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const clientRequire = createRequire(join(CLIENT_DIR, 'package.json'))
const ELECTRON_PATH = clientRequire('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

test('客户端繁中：团队/方案页全繁体，无英文回落', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-TW' }), 'utf8')

  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-zhtw-ignored')}`],
    env: { ...process.env, OMNI_USER_DATA: USER_DATA }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 团队管理页：之前 zh-TW 缺键会回落英文，现应全繁体
  await win.locator('.rail-nav', { hasText: '團隊管理' }).click()
  await expect(win.getByRole('heading', { name: '登入裝置' })).toBeVisible({ timeout: 10_000 })
  await expect(win.getByRole('heading', { name: '成員' })).toBeVisible()
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-05-zhtw-team.png` })

  // 底部导航也应全繁体（此前 Plan & Balance / Help & Feedback 回落英文）
  await expect(win.locator('.rail-nav', { hasText: '方案與餘額' })).toBeVisible()
  await expect(win.locator('.rail-nav', { hasText: '說明與意見回饋' })).toBeVisible()

  await app.close()
})
