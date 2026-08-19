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

// M14 AI 模型单价配置：建供应商 → 在「模型与单价」下挂一个模型（选用途 + 填输入/输出积分单价）
// → 模型表出现该模型与单价。ai-provider 只覆盖建供应商，挂模型与单价此前没测。
test('后台 AI：新建模型与单价并在列表核对', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const provName = `E2E供应商${TAG}`
  const modelName = `e2e-model-${TAG}`

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /AI 模型|AI models/ }).click()

  // 建供应商
  const provCard = page.locator('section.card').filter({ hasText: /AI 供应商|New provider/i })
  await expect(provCard).toBeVisible({ timeout: 10_000 })
  await provCard.locator('input:not([type="password"])').first().fill(provName)
  await provCard.getByRole('button', { name: '创建' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: provName })).toBeVisible({ timeout: 10_000 })

  // 在「模型与单价」下挂模型
  const modelCard = page.locator('section.card').filter({ hasText: '模型与单价' })
  await expect(modelCard).toBeVisible({ timeout: 10_000 })
  await modelCard.locator('label', { hasText: '供应商' }).locator('select').selectOption({ label: provName })
  await modelCard.locator('label', { hasText: '模型' }).locator('input').fill(modelName)
  await modelCard.locator('label.check', { hasText: '翻译' }).locator('input[type="checkbox"]').check()
  await modelCard.locator('label', { hasText: '积分/百万输入' }).locator('input').fill('1000')
  await modelCard.locator('label', { hasText: '积分/百万输出' }).locator('input').fill('2000')
  await modelCard.getByRole('button', { name: '创建' }).click()

  // 模型表出现该模型，输入/输出单价 1000/2000
  const row = page.locator('table tbody tr').filter({ hasText: modelName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('1000')
  await expect(row).toContainText('2000')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-ai-model-create.png`, fullPage: true })
})
