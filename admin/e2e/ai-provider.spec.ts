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

test('后台计费：新建 AI 供应商并在列表核对', async ({ page }) => {
  // 唯一名：共享持久 DB 里固定名会越积越多，触发严格模式多元素命中
  const name = `E2E供应商${Date.now().toString(36).slice(-5)}`
  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /AI 模型|AI models/ }).click()

  const card = page.locator('section.card').filter({ hasText: /AI 供应商|AI provider/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  // 类型默认 openai；填名称
  await card.locator('input:not([type="password"])').first().fill(name)
  await card.getByRole('button', { name: '创建' }).click()

  // 供应商表出现 E2E供应商
  const row = page.locator('table tbody tr').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-ai-provider.png`, fullPage: true })
})
