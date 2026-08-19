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

// M11 手续费 gross-up：客户承担 5% 手续费时，$10 单应付反算为 $10.53（ceil(1000/0.95)/100）
test('后台订单：客户承担 5% 手续费，$10 单应付 $10.53（gross-up）', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_fee_${TAG}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 建 USD 通道：5% 手续费、由客户承担
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ type: 'mock', name: `手续费通道${TAG}`, currency: 'USD', feeRate: 0.05, feeFixedCents: 0, feePaidBy: 'customer' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  expect(ch.channel?.id).toBeTruthy()

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const order = await fetch(`${API}/api/billing/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'topup', amountCents: 1000, channelId: ch.channel.id })
  })
  expect(order.ok).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  // 该订单：商品金额 $10.00，应付 10.53 USD（ceil(1000/0.95)=1053 分）
  const row = page.locator('table tbody tr').filter({ hasText: email })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('$10.00')
  await expect(row).toContainText('10.53 USD')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-order-fee-grossup.png`, fullPage: true })
})
