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

// M11 账号配额软门：套餐 maxAccounts 此前只展示不强制（accountQuotaState/canAddMore 零生产调用），
// 10 账号套餐的老板能加任意多个。现把加号接上配额：有套餐且账号数已达上限 → 加号禁用 + 提示升级；
// 升级到更大配额后加号即时恢复。用例预置一个账号，故 maxAccounts=1 即到顶。
test('客户端账号配额：到套餐上限禁用加号并提示，升级后恢复', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN', accounts: { 'whatsapp:main': {} } }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const plan1Name = `单账号套餐${TAG}`
  const plan5Name = `五账号套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const mkPlan = (name: string, maxAccounts: number): Promise<{ plan: { id: string } }> =>
    fetch(`${API}/api/admin/plans`, {
      method: 'POST', headers: aAuth,
      body: JSON.stringify({ name, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts, maxDevices: 0 })
    }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  const plan1 = await mkPlan(plan1Name, 1)
  const plan5 = await mkPlan(plan5Name, 5)

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const bAuth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 10000, note: 'e2e' })
  })
  // 先订 maxAccounts=1 套餐 → 配额 1，预置账号已占满
  await fetch(`${API}/api/billing/subscribe`, { method: 'POST', headers: bAuth, body: JSON.stringify({ planId: plan1.plan.id }) })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-quota-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 已到配额（1/1）：加号禁用 + 升级提示
  const addBtn = win.locator('.account-list-header .icon-btn')
  await expect(addBtn).toBeDisabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveText('已达账号上限，请升级套餐')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-account-quota-gate.png` })

  // 升级到 maxAccounts=5 → 切视图触发 /billing/me 重取配额 → 加号恢复、提示消失
  await fetch(`${API}/api/billing/subscribe`, { method: 'POST', headers: bAuth, body: JSON.stringify({ planId: plan5.plan.id }) })
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-billing').click()
  await expect(addBtn).toBeEnabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveCount(0)

  await app.close()
})
