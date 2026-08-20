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
const API = 'http://127.0.0.1:8798'

// M11 账号配额软门·计数方向：quota-gate 只测了「改套餐→配额变」这个方向，
// 「加账号使账号数触达上限→加号即时禁用」这条计数方向的响应此前没测。
// 这才是老板真实操作路径：不停加账号直到撞上套餐上限。maxAccounts=2、主账号占 1，
// 通过选择器新增一个 Telegram Bot 账号（选中即创建）→ 账号数变 2 = 配额 → 加号禁用。
test('客户端账号配额：加账号触达上限后加号即时禁用（计数方向）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `双账号套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts: 2, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' })
  })
  await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.plan.id })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-quotaadd-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 配额 2、当前 1 个（主账号）→ 加号可点、无提示
  const addBtn = win.locator('.account-list-header .icon-btn')
  await expect(addBtn).toBeEnabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveCount(0)

  // 加一个 Telegram Bot 账号（选择器选中即创建，账号数→2）
  await addBtn.click()
  await win.locator('.picker-item', { hasText: 'Telegram Bot' }).click()
  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.getByRole('button', { name: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 账号数已达配额（2/2）→ 加号即时禁用 + 升级提示
  await expect(addBtn).toBeDisabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveText('已达账号上限，请升级套餐')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-account-quota-onadd.png` })
  await app.close()
})
