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

// M11 余额调整负数护栏：从 $0 余额扣 $10 → 服务端 400「余额不足，不能扣成负数」→ 后台提示、不入账。
// balance-adjust 只覆盖成功加款；扣成负数的护栏此前没测（且其可见性依赖上一轮 req() 错误提取修复）。
test('后台计费：余额扣成负数被拒并提示', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_neg_${TAG}@e2e.test`
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
  await card.locator('select').selectOption('deduct') // 减少余额
  await card.locator('input[placeholder="10.00"]').fill('10.00')
  await card.getByRole('button', { name: '保存' }).click()

  // 报「余额不足，不能扣成负数」，且不出现「已调整」成功提示
  await expect(page.locator('.err').filter({ hasText: '不能扣成负数' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/已调整/)).toHaveCount(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-balance-adjust-negative.png`, fullPage: true })
})
