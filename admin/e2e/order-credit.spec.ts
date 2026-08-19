import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function balanceCents(token: string): Promise<number> {
  const r = (await fetch(`${API}/api/billing/me`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { balance?: { balanceCents?: number } }
  return r.balance?.balanceCents ?? -1
}

// M11 支付结算入账：管理员「标记已支付」走与回调相同的 settle 路径 → 充值金额入余额。
// order-flow 只验了订单在列表间的流转，从未验证「入账」这一步——余额是否真的到账。
test('后台订单：标记已支付后充值金额入账到客户余额', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  page.on('dialog', (d) => void d.accept())

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mock', name: `入账通道${TAG}`, currency: 'USD' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  expect(ch.channel?.id).toBeTruthy()

  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 下单前余额为 0
  expect(await balanceCents(reg.token)).toBe(0)
  const orderRes = await fetch(`${API}/api/billing/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'topup', amountCents: 1000, channelId: ch.channel.id })
  })
  expect(orderRes.ok).toBeTruthy()

  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: email })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('$10.00')

  // 标记已支付 → 订单离开待支付列表
  await row.getByRole('button', { name: '标记已支付' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toHaveCount(0, { timeout: 10_000 })

  // 核心断言：$10 已入账到客户余额（1000 分）
  await expect.poll(() => balanceCents(reg.token), { timeout: 10_000 }).toBe(1000)

  // 已支付筛选下该单可见
  await page.locator('.log-toolbar select').selectOption('paid')
  await expect(page.locator('table tbody tr').filter({ hasText: email })).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-order-credit.png`, fullPage: true })
})
