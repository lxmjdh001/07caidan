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

async function autoRenew(token: string): Promise<boolean | undefined> {
  const r = (await fetch(`${API}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { subscription?: { autoRenew?: boolean } | null }
  return r.subscription?.autoRenew
}

// M11 到期自动续费开关：已订阅老板在概览勾选「到期自动从余额续费」→ setAutoRenew 落库、回勾。
// billing-active 只断言开关可见，从未点它——开关的开合与持久化此前无覆盖。
test('客户端套餐：切换到期自动续费开关并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const planName = `续费套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 990, periodUnit: 'month', periodCount: 1, maxAccounts: 20, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/balance-adjust`, { method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' }) })
  const sub = await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.plan.id })
  })
  expect(sub.ok).toBeTruthy()
  // 订阅默认不自动续费
  expect(await autoRenew(reg.token)).toBe(false)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-arenew-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
  const box = win.locator('label.field.checkbox', { hasText: '到期自动从余额续费' }).locator('input')
  await expect(box).toBeVisible({ timeout: 10_000 })
  await expect(box).not.toBeChecked()

  // 点开关（受控项，值随 me 刷新回来）→ 勾上并落库
  await box.click()
  await expect(box).toBeChecked({ timeout: 10_000 })
  await expect.poll(() => autoRenew(reg.token), { timeout: 10_000 }).toBe(true)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-84-autorenew.png` })

  // 再点一次关掉 → 回到未勾并落库 false（双向验证）
  await box.click()
  await expect(box).not.toBeChecked({ timeout: 10_000 })
  await expect.poll(() => autoRenew(reg.token), { timeout: 10_000 }).toBe(false)

  await app.close()
})
