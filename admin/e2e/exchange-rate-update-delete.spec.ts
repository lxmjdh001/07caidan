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

// 汇率的「更新（同币种覆盖）」与「删除」：exchange-rate 只覆盖新建，改值与删除没测。
test('后台计费：汇率更新（同币种覆盖）与删除', async ({ page }) => {
  const CUR = 'THB' // 独立币种，避免与 CNY/USD 用例互扰；末尾删除自清理
  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /汇率|Rates/ }).click()

  const card = page.locator('section.card').filter({ hasText: /汇率|rate/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  const inputs = card.locator('.form-row input')

  // 建 THB = 35.50
  await inputs.nth(0).fill(CUR)
  await inputs.nth(1).fill('35.5')
  await card.getByRole('button', { name: '保存' }).click()
  const row = page.locator('table tbody tr').filter({ hasText: CUR })
  await expect(row).toHaveCount(1, { timeout: 10_000 })
  await expect(row).toContainText('35.5')

  // 同币种再存 36.88 → 覆盖，仍只有一行且值更新（不新增重复行）
  await inputs.nth(0).fill(CUR)
  await inputs.nth(1).fill('36.88')
  await card.getByRole('button', { name: '保存' }).click()
  await expect(row).toHaveCount(1, { timeout: 10_000 })
  await expect(row).toContainText('36.88')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-exchange-rate-update.png`, fullPage: true })

  // 删除该币种 → 行消失
  await row.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: CUR })).toHaveCount(0, { timeout: 10_000 })
})
