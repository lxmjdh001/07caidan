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

// M14 AI 模型运营：停用/启用切换与删除。ai-model-create 只覆盖新建+单价，
// 「停用（钱相关：停用后不参与 AI 选型计费）/启用/删除」这几个运营操作此前没测。
test('后台 AI 模型：停用/启用切换并持久化、删除后从表移除', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const modelName = `e2e-tgl-${TAG}`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const prov = await fetch(`${API}/api/admin/ai/providers`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'openai', name: `供应商${TAG}` })
  }).then((r) => r.json() as Promise<{ provider: { id: string } }>)
  await fetch(`${API}/api/admin/ai/models`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ providerId: prov.provider.id, modelName, purposes: ['translate'], creditsPerMillionInput: 1000, creditsPerMillionOutput: 2000 })
  })

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /AI 模型|AI models/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: modelName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  // 初始启用：无 row-off、按钮为「停用」
  await expect(row).not.toHaveClass(/row-off/)

  // 停用 → 行变灰（row-off）、按钮变「启用」（受控：updateAiModel 后 load 回读）
  await row.getByRole('button', { name: '停用' }).click()
  await expect(row).toHaveClass(/row-off/, { timeout: 10_000 })
  await expect(row.getByRole('button', { name: '启用' })).toBeVisible()

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-ai-model-toggle.png`, fullPage: true })

  // 启用 → 恢复
  await row.getByRole('button', { name: '启用' }).click()
  await expect(row).not.toHaveClass(/row-off/, { timeout: 10_000 })

  // 删除 → 从表移除
  await row.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: modelName })).toHaveCount(0, { timeout: 10_000 })
})
