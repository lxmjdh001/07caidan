import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function reqStatus(token: string, method: string, path: string, body?: unknown): Promise<number> {
  return (await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })).status
}

// 红线（越权边界）：客户端(老板)令牌绝不能触达管理后台端点，也不能登进后台控制台。
// 否则老板可自行 /api/admin/balance-adjust 给自己加钱、看全租户订单等。此前无 e2e。
test('越权边界：客户端令牌不能进后台、不能调 /api/admin/*', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  expect(reg.token).toBeTruthy()

  // UI：拿客户端账号密码登后台控制台 → 登不进（后台用独立管理员账号体系）
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill(email)
  await page.locator('input[type="password"]').fill('secret123')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  // 不应进入后台（.sidebar-nav 不出现）；停留在登录页
  await page.waitForTimeout(1500)
  await expect(page.locator('.sidebar-nav')).toHaveCount(0)
  await expect(page.locator('input[placeholder="admin"]')).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/admin-client-token-no-admin.png`, fullPage: true })

  // API：客户端令牌打各管理端点 → 全部 403（无 admin principal）
  expect(await reqStatus(reg.token, 'POST', '/api/admin/balance-adjust', { email, deltaCents: 999999, note: 'hack' })).toBe(403)
  expect(await reqStatus(reg.token, 'GET', '/api/admin/channels')).toBe(403)
  expect(await reqStatus(reg.token, 'POST', '/api/admin/plans', { name: 'hack', priceCents: 1, periodUnit: 'month', periodCount: 1, maxAccounts: 1, maxDevices: 0 })).toBe(403)
  expect(await reqStatus(reg.token, 'GET', '/api/users')).toBe(403)

  // 反证：自己加钱没得逞——余额仍为 0
  const me = (await fetch(`${API}/api/billing/me`, { headers: { authorization: `Bearer ${reg.token}` } }).then((r) => r.json())) as { balance?: { balanceCents?: number } }
  expect(me.balance?.balanceCents).toBe(0)
})
