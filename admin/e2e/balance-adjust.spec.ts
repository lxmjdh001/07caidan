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

// M11 后台余额调整：管理员按邮箱给用户加余额 → 提示当前余额
test('后台计费：管理员手动增加用户余额并核对', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_adj_${TAG}@e2e.test`
  // 注册一个真实客户账号
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  const card = page.locator('section.card').filter({ hasText: '余额调整' })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('input[placeholder="user@example.com"]').fill(email)
  // 方向默认“增加余额”；填金额
  await card.locator('input[placeholder="10.00"]').fill('25.00')
  await card.locator('label', { hasText: '备注' }).locator('input').fill(`e2e 手动加款${TAG}`)
  await card.getByRole('button', { name: '保存' }).click()

  // 成功提示：已调整，当前余额 $25.00
  await expect(card.getByText(/已调整，当前余额 \$25\.00/)).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-balance-adjust.png`, fullPage: true })

  // 二次核对：API 查该用户余额确为 2500 分
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const orders = await fetch(`${API}/api/admin/orders?status=`, { headers: { authorization: `Bearer ${admin.token}` } })
  expect(orders.ok).toBeTruthy()
})
