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

// M11 汇率换算：金额以美元存储，按管理员配置的汇率换算成本地货币展示
test('后台订单：$10 经 CNY(7.25) 通道下单，应付显示 72.50 CNY', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_cur_${TAG}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 设 CNY 汇率 7.25 + 建 CNY mock 通道
  await fetch(`${API}/api/admin/rates/CNY`, { method: 'PUT', headers: aAuth, body: JSON.stringify({ rate: 7.25, decimals: 2 }) })
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'mock', name: `CNY通道${TAG}`, currency: 'CNY' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  expect(ch.channel?.id).toBeTruthy()

  // 客户下 $10 充值单（走 CNY 通道）
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

  // 该客户的订单行：商品金额 $10.00，应付 72.50 CNY（10×7.25）
  const row = page.locator('table tbody tr').filter({ hasText: email })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('$10.00')
  await expect(row).toContainText('72.50 CNY')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-order-currency.png`, fullPage: true })
})
