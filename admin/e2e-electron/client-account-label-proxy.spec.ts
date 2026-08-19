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

// M6 账号设置：备注名 + 代理 保存并持久化。account-lang 只覆盖默认语言，
// 备注名（会成为侧栏账号显示名）与代理这两个字段的保存/回显此前没测。
test('客户端账号设置：备注名与代理保存并持久化、备注名回显到侧栏', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-acclp-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const label = `销售组A${Date.now().toString(36).slice(-4)}`
  const proxy = 'socks5://127.0.0.1:1080'
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  const accRow = win.locator('.account-row').filter({ has: win.locator('.account-row-gear') }).first()
  await accRow.hover()
  await accRow.locator('.account-row-gear').click()
  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })

  // 填备注名 + 代理
  await modal.locator('label.field', { hasText: '备注名' }).locator('input').fill(label)
  await modal.locator('input[placeholder="socks5://127.0.0.1:1080"]').fill(proxy)

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-87-account-label-proxy.png` })

  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 备注名回显到侧栏账号行（成为账号显示名）
  await expect(win.getByText(label).first()).toBeVisible({ timeout: 10_000 })

  // 重开 → 两字段仍在（落库）
  await accRow.hover()
  await accRow.locator('.account-row-gear').click()
  const modal2 = win.locator('.modal')
  await expect(modal2.locator('label.field', { hasText: '备注名' }).locator('input')).toHaveValue(label)
  await expect(modal2.locator('input[placeholder="socks5://127.0.0.1:1080"]')).toHaveValue(proxy)

  await app.close()
})
