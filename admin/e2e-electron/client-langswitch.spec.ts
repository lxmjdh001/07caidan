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

test('客户端设置里切换语言（英→日）实时生效', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'en' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-lang-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 打开设置（英文界面）→ 语言下拉选日本語 → 保存
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  const localeSelect = win.locator('.form-page select').filter({ has: win.locator('option[value="ja"]') })
  await localeSelect.selectOption('ja')
  await win.getByRole('button', { name: 'Save' }).click()

  // 整个界面实时切到日语（无需重启）
  await expect(win.getByTestId('client-nav-trigger')).toContainText('設定', { timeout: 10_000 })
  await win.getByTestId('client-nav-trigger').click()
  await expect(win.getByTestId('client-nav-billing')).toContainText('プランと残高')
  await expect(win.getByTestId('client-nav-settings')).toContainText('設定')
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-15-langswitch-ja.png` })
  await app.close()
})
