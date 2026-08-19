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

test('后台计费：设置汇率并在列表核对', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /汇率|Rates/ }).click()

  const card = page.locator('section.card').filter({ hasText: /汇率|rate/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  const inputs = card.locator('.form-row input')
  await inputs.nth(0).fill('CNY') // 币种
  await inputs.nth(1).fill('7.25') // 汇率
  await card.getByRole('button', { name: '保存' }).click()

  // 汇率表出现 CNY 7.25
  const row = page.locator('table tbody tr').filter({ hasText: 'CNY' })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('7.25')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-exchange-rate.png`, fullPage: true })
})
