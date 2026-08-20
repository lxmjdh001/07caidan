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

// M6 账号设备名（deviceLabel）持久化：WhatsApp「已关联的设备」里显示的浏览器名，
// 是防封的按账号设备指纹隔离手段。account-label-proxy 覆盖了备注名/代理，设备名此前没测。
test('客户端账号设置：设备名保存并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-devname-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const devName = `销售专机${Date.now().toString(36).slice(-4)}`
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

  // 设备名字段默认空（占位「自动（各账号不同）」）→ 填入自定义设备名
  const devField = modal.locator('label.field', { hasText: '设备名' }).locator('input')
  await expect(devField).toHaveValue('')
  await devField.fill(devName)

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-117-account-devicename.png` })

  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 重开 → 设备名仍在（落库）
  await accRow.hover()
  await accRow.locator('.account-row-gear').click()
  await expect(win.locator('.modal').locator('label.field', { hasText: '设备名' }).locator('input')).toHaveValue(devName)

  await app.close()
})
