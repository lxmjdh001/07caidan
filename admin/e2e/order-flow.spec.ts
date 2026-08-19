import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// M11 订单全链路（后台可见）：客户下单(pending) → 后台订单页可见 → 标记已支付 → 转已支付
test('后台计费：客户下单在订单页可见并可标记已支付', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  // 管理员令牌 → 建 mock 支付通道
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mock', name: `测试通道${TAG}`, currency: 'USD' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  expect(ch.channel?.id).toBeTruthy()

  // 注册客户老板(带 billing:manage) → 下一笔 $10 充值订单
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const orderRes = await fetch(`${API}/api/billing/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'topup', amountCents: 1000, channelId: ch.channel.id })
  })
  expect(orderRes.ok).toBeTruthy()

  // confirm 对话框自动接受
  page.on('dialog', (d) => void d.accept())

  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  // 待支付订单行：本客户邮箱 + 充值 + $10.00
  const row = page.locator('table tbody tr').filter({ hasText: email })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('充值')
  await expect(row).toContainText('$10.00')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-order-flow.png`, fullPage: true })

  // 标记已支付 → 该单从「待支付」列表消失
  await row.getByRole('button', { name: '标记已支付' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toHaveCount(0, { timeout: 10_000 })
  // 切到「已支付」筛选 → 该单出现
  await page.locator('.log-toolbar select').selectOption('paid')
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toBeVisible({ timeout: 10_000 })
})
