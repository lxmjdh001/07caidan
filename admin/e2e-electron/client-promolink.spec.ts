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

test('客户端推广链接：填手机号+追踪码实时生成带 ref 的入口链接', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-promo-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '推广链接' }).click()

  // 默认账号无自动手机号 → 手填联系方式 + 追踪码
  await win.locator('input[placeholder="手机号 / 用户名 / LINE ID"]').fill('15550001234')
  await win.locator('input[placeholder="fb01 / tiktok_a"]').fill('fb01')

  // 实时预览出带 ref 追踪码的入口链接
  const preview = win.locator('.link-preview code')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  const url = (await preview.textContent()) ?? ''
  expect(url).toContain('fb01')
  expect(url).toContain('15550001234')
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-21-promolink.png` })
  await app.close()
})
