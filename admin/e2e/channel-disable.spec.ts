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

// M11 支付通道启停：管理员停用一个通道，行变停用态（停用后不再对客户端下单开放）
test('后台计费：停用支付通道并核对', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const chName = `待停通道${TAG}`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mock', name: chName, currency: 'USD' })
  })

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /支付通道|Channels/ }).click()

  // 该通道行默认启用 → 点停用
  const row = page.locator('table tbody tr').filter({ hasText: chName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.getByRole('button', { name: '停用' }).click()

  // 行变停用态：按钮变「启用」+ row-off
  await expect(row.getByRole('button', { name: '启用' })).toBeVisible({ timeout: 10_000 })
  await expect(row).toHaveClass(/row-off/)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-channel-disable.png`, fullPage: true })
})
