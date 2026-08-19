import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M11 余额调整护栏：给不存在的用户调整 → 服务端 400「用户不存在」→ 后台提示、不入账。
// balance-adjust 只覆盖成功加款，错误路径此前没测。
test('后台计费：给不存在用户调整余额被拒并提示', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const ghost = `nobody_${TAG}@nope.test`

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /订单|Orders/ }).click()

  const card = page.locator('section.card').filter({ hasText: '余额调整' })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('input[placeholder="user@example.com"]').fill(ghost)
  await card.locator('input[placeholder="10.00"]').fill('10.00')
  await card.getByRole('button', { name: '保存' }).click()

  // 报错「用户不存在」（在订单区下方的 .err 处渲染，不在卡片内），且不出现「已调整」成功提示
  await expect(page.locator('.err').filter({ hasText: '用户不存在' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/已调整/)).toHaveCount(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-balance-adjust-error.png`, fullPage: true })
})
