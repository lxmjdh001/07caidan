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

// M11 降级后超限：3 个账号在用时把套餐从 5 账号降到 2 账号 → 账号数(3) > 配额(2)。
// 契约「只禁止新增，不强制踢下线」（accountQuotaState 单测有，UI 端到端此前没测）：
// 加号禁用+提示，但已有 3 个账号一个不少地保留（降级不丢账号，老板的核心顾虑）。
test('客户端账号配额：降级到低于在用数——禁新增但不踢已有账号', async () => {
  const TAG = Date.now().toString(36).slice(-5)
  const keyA = `telegram_bot:ta${TAG}`
  const keyB = `telegram_bot:tb${TAG}`
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({ locale: 'zh-CN', accounts: { 'whatsapp:main': {}, [keyA]: { label: `账号甲${TAG}` }, [keyB]: { label: `账号乙${TAG}` } } }),
    'utf8'
  )

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
  const plan5 = await mkPlan(`五账号${TAG}`, 5)
  const plan2 = await mkPlan(`两账号${TAG}`, 2)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const bAuth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 8000, note: 'e2e' })
  })
  await fetch(`${API}/api/billing/subscribe`, { method: 'POST', headers: bAuth, body: JSON.stringify({ planId: plan5.plan.id }) })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-qdown-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 5 账号配额、在用 3 个 → 加号可点、无提示；甲乙两账号在列
  const addBtn = win.locator('.account-list-header .icon-btn')
  await expect(addBtn).toBeEnabled({ timeout: 10_000 })
  await expect(win.locator('.account-row', { hasText: `账号甲${TAG}` })).toBeVisible()
  await expect(win.locator('.account-row', { hasText: `账号乙${TAG}` })).toBeVisible()

  // 降级到 2 账号套餐 → 切视图触发配额重取 → 账号数(3) > 配额(2)
  await fetch(`${API}/api/billing/subscribe`, { method: 'POST', headers: bAuth, body: JSON.stringify({ planId: plan2.plan.id }) })
  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()

  // 超限：加号禁用 + 提示；但已有 3 个账号一个不少（不踢下线）
  await expect(addBtn).toBeDisabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveText('已达账号上限，请升级套餐')
  await expect(win.locator('.account-row', { hasText: `账号甲${TAG}` })).toBeVisible()
  await expect(win.locator('.account-row', { hasText: `账号乙${TAG}` })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-account-quota-downgrade-over.png` })
  await app.close()
})
