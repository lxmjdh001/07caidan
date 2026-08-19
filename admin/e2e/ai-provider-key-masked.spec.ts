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

// 红线：AI 供应商 API Key 只回传打码版（apiKeyMasked），原始密钥绝不进前端/接口响应。
// ai-provider 只验建供应商成功，密钥打码此前没测。
test('后台 AI：供应商 API Key 在列表打码、原始密钥不泄露', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const provName = `密钥供应商${TAG}`
  const RAW_KEY = `sk-supersecret-${TAG}-abcdef0123456789`

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /AI 模型|AI models/ }).click()

  const provCard = page.locator('section.card').filter({ hasText: /AI 供应商|New provider/i })
  await expect(provCard).toBeVisible({ timeout: 10_000 })
  await provCard.locator('input:not([type="password"])').first().fill(provName)
  await provCard.locator('input[type="password"]').fill(RAW_KEY)
  await provCard.getByRole('button', { name: '创建' }).click()

  // 该供应商行的 API Key 单元格：打码（非原始串），列表任意处都不含原始密钥
  const row = page.locator('table tbody tr').filter({ hasText: provName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  const keyCell = row.locator('td').nth(2)
  await expect(keyCell).not.toHaveText(RAW_KEY)
  await expect(keyCell).not.toContainText('supersecret')
  // 整页 HTML 不得出现原始密钥
  expect(await page.content()).not.toContain(RAW_KEY)

  // 接口响应也只回打码版，不含原始密钥
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const raw = await fetch(`${API}/api/admin/ai/providers`, { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.text())
  expect(raw).not.toContain(RAW_KEY)
  expect(raw).not.toContain('supersecret')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-ai-provider-key-masked.png`, fullPage: true })
})
