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

// M11 汇率删除的钱相关后果：删掉某币种汇率后，用该币种通道下单会因「未配置汇率」被拒。
// exchange-rate-update-delete 只验了行消失，没验删除的实际后果。SGD 独立币种避免互扰。
test('后台汇率：删除某币种汇率后，该币种通道下单被拒', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const CUR = 'SGD'
  const chName = `新币通道${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 先保证该币种有汇率 + 一个该币种通道
  await fetch(`${API}/api/admin/rates/${CUR}`, { method: 'PUT', headers: aAuth, body: JSON.stringify({ rate: 1.35 }) })
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'mock', name: chName, currency: CUR })
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

  // 删前：该币种通道可下单（有汇率）
  expect((await order()).status).toBe(200)

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /汇率|Rates/ }).click()
  const row = page.locator('table tbody tr').filter({ hasText: CUR })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 删除该币种汇率 → 行消失
  await row.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: CUR })).toHaveCount(0, { timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-rate-deleted.png`, fullPage: true })

  // 钱相关后果：删汇率后该币种通道下单被拒（未配置汇率）
  const blocked = await order()
  expect(blocked.status).toBe(400)
  expect(blocked.error).toBe(`未配置 ${CUR} 汇率`)
})
