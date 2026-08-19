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

// M11 套餐核心：后台新建套餐（价格/账号上限/设备上限）→ 列表核对（此套餐即客户端钱包可购项）
test('后台计费：新建套餐并在列表核对价格与账号上限', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const planName = `尊享套餐${TAG}`
  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()

  // 计费默认落在「套餐」页签
  const form = page.locator('section.card').filter({ hasText: '新建套餐' })
  await expect(form).toBeVisible({ timeout: 10_000 })
  await form.locator('label', { hasText: '套餐名称' }).locator('input').fill(planName)
  await form.locator('label', { hasText: '价格(USD)' }).locator('input').fill('19.90')
  await form.locator('label', { hasText: '账号上限' }).locator('input').fill('5')
  await form.getByRole('button', { name: '创建' }).click()

  // 套餐表出现该套餐 + 价格 + 账号上限
  const row = page.locator('table tbody tr').filter({ hasText: planName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('19.90')
  await expect(row).toContainText('5')

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-plan-create.png`, fullPage: true })
})
