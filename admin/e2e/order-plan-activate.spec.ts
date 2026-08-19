import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function myPlanId(token: string): Promise<string | null> {
  const r = (await fetch(`${API}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { plan?: { id?: string } | null }
  return r.plan?.id ?? null
}

// M11 套餐单支付结算：settle 对 kind==='plan' 的单在到账后自动完成换购（billing-routes 的
// changePlan 分支）。subscribe-balance 走的是扣已有余额，此处是「直接对套餐下单付款 → 到账自动开通」，
// 这条支付开通路径此前从未覆盖。
test('后台订单：套餐单标记已支付后自动开通该套餐', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const planName = `支付开通套餐${TAG}`
  page.on('dialog', (d) => void d.accept())

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ type: 'mock', name: `开通通道${TAG}`, currency: 'USD' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts: 15, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  expect(ch.channel?.id && plan.plan?.id).toBeTruthy()

  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 未付款前无任何套餐
  expect(await myPlanId(reg.token)).toBeNull()
  const orderRes = await fetch(`${API}/api/billing/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'plan', planId: plan.plan.id, channelId: ch.channel.id })
  })
  expect(orderRes.ok, `套餐单应创建成功: ${await orderRes.clone().text()}`).toBeTruthy()

  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: email })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('$20.00')

  // 标记已支付 → 订单离开待支付列表
  await row.getByRole('button', { name: '标记已支付' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toHaveCount(0, { timeout: 10_000 })

  // 核心断言：套餐已自动开通到该客户
  await expect.poll(() => myPlanId(reg.token), { timeout: 10_000 }).toBe(plan.plan.id)

  await page.locator('.log-toolbar select').selectOption('paid')
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-order-plan-activate.png`, fullPage: true })
})
