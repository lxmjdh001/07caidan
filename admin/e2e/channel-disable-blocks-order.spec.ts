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

// M11 支付通道停用的钱相关后果：后台停用通道后，客户端就不能用它下单（400 支付通道不可用）。
// channel-disable 只验了行的停用态(row-off)，没验「停用后下单被拒」这条实际后果。
// 把 UI 停用切换与「能否下单」串起来，两个方向都验。
test('后台支付通道：停用后客户端下单被拒、启用后可下单', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const chName = `后果通道${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'mock', name: chName, currency: 'USD' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const bAuth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const order = (): Promise<{ status: number; error?: string }> =>
    fetch(`${API}/api/billing/orders`, {
      method: 'POST', headers: bAuth,
      body: JSON.stringify({ kind: 'topup', amountCents: 1000, channelId: ch.channel.id })
    }).then(async (r) => ({ status: r.status, error: (await r.json().catch(() => ({}))).error }))

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /支付通道|Channels/ }).click()
  const row = page.locator('table tbody tr').filter({ hasText: chName })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 点「停用」→ 行变停用态
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/api/admin/channels/${ch.channel.id}`) && response.request().method() === 'PATCH'),
    row.getByRole('button', { name: '停用' }).click()
  ])
  await expect(row).toHaveClass(/row-off/, { timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-channel-disabled.png`, fullPage: true })

  // 钱相关后果：停用后客户端用该通道下单被拒
  const blocked = await order()
  expect(blocked.status).toBe(400)
  expect(blocked.error).toBe('支付通道不可用')

  // 点「启用」→ 恢复可下单（生成付款单 200）
  await Promise.all([
    page.waitForResponse((response) => response.url().includes(`/api/admin/channels/${ch.channel.id}`) && response.request().method() === 'PATCH'),
    row.getByRole('button', { name: '启用' }).click()
  ])
  await expect(row.getByRole('button', { name: '停用' })).toBeVisible({ timeout: 10_000 })
  await expect(row).not.toHaveClass(/row-off/, { timeout: 10_000 })
  const ok = await order()
  expect(ok.status).toBe(200)
})
