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

// M11 客户端钱包已订阅态：老板订阅套餐后，概览显示当前套餐+账号配额+自动续费开关
test('客户端套餐与余额：已订阅套餐在概览正确显示', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `旗舰套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  // 管理员建套餐
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 990, periodUnit: 'month', periodCount: 1, maxAccounts: 20, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  expect(plan.plan?.id).toBeTruthy()

  // 注册老板 + 给余额 + 订阅
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/balance-adjust`, { method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' }) })
  const sub = await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.plan.id })
  })
  expect(sub.ok, `订阅应成功: ${await sub.clone().text()}`).toBeTruthy()

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-billactive-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-billing').click()

  // 概览：当前套餐显示该套餐名 + 账号配额=20 + 自动续费开关
  await expect(win.getByText('当前套餐')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText(planName)).toBeVisible()
  await expect(win.getByText('到期自动从余额续费')).toBeVisible()
  // 账号配额卡应为套餐上限 20
  await expect(win.locator('.stat-card').filter({ hasText: '账号配额' }).locator('.v')).toHaveText('20')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-49-billing-active.png` })
  await app.close()
})
