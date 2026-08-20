import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M11 套餐停用的钱相关后果：后台在套餐表点「停用」→ 客户端老板就订不了该套餐
// （changePlan 返回 plan_disabled）。plan-create/desc-edit 没测停用切换，更没测停用的
// 实际后果。把 UI 切换与「能否被订阅」串起来，两个方向都验。
test('后台套餐：停用后客户端订不了、启用后可订（UI 切换×订阅后果）', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const planName = `可停用套餐${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts: 5, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' })
  })
  const bAuth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const subscribe = (): Promise<{ status: number; reason?: string }> =>
    fetch(`${API}/api/billing/subscribe`, { method: 'POST', headers: bAuth, body: JSON.stringify({ planId: plan.plan.id }) })
      .then(async (r) => ({ status: r.status, reason: (await r.json().catch(() => ({}))).reason }))

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  const row = page.locator('table tbody tr').filter({ hasText: planName })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 点「停用」→ 按钮转「启用」（受控回读）
  await row.getByRole('button', { name: '停用' }).click()
  await expect(row.getByRole('button', { name: '启用' })).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-plan-disabled.png`, fullPage: true })

  // 钱相关后果：停用后老板订不了该套餐（400 plan_disabled）
  const blocked = await subscribe()
  expect(blocked.status).toBe(400)
  expect(blocked.reason).toBe('plan_disabled')

  // 点「启用」→ 恢复可订
  await row.getByRole('button', { name: '启用' }).click()
  await expect(row.getByRole('button', { name: '停用' })).toBeVisible({ timeout: 10_000 })
  const ok = await subscribe()
  expect(ok.status).toBe(200)
})
