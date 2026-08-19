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

// M2/M6 按账号默认客户语言（覆盖全局）：账号设置里选语言 → 保存 → 重开仍在
test('客户端账号设置：按账号默认客户语言持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-acclang-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 打开默认 whatsapp:main 账号的设置（齿轮默认 display:none，hover 账号行才显示）
  const accRow = win.locator('.account-row').filter({ has: win.locator('.account-row-gear') }).first()
  await accRow.hover()
  await accRow.locator('.account-row-gear').click()
  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })

  // 本账号默认客户语言（覆盖全局）下拉，默认「跟随全局」
  const langSel = modal.locator('label', { hasText: '本账号默认客户语言' }).locator('select')
  await expect(langSel).toHaveValue('')
  await langSel.selectOption({ index: 1 })
  const chosen = await langSel.inputValue()
  expect(chosen).not.toBe('')
  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-45-account-lang.png` })

  // qr 类账号保存仅存配置、不触发连接
  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 重开齿轮 → 该账号默认语言仍是所选值（落库）
  await accRow.hover()
  await accRow.locator('.account-row-gear').click()
  await expect(
    win.locator('.modal').locator('label', { hasText: '本账号默认客户语言' }).locator('select')
  ).toHaveValue(chosen)

  await app.close()
})
