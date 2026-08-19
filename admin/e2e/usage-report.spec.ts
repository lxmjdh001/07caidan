import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// M12 用量报表全链路：建供应商+模型 → 给客户余额 → 客户扣费一次 → 后台用量报表可见
test('后台计费：AI 用量在用量报表按模型/用途汇总可见', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const modelLabel = `测试模型${TAG}`
  const adminAuth = async (path: string, body: unknown) => {
    const admin = await fetch(`${API}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    }).then((r) => r.json() as Promise<{ token: string }>)
    return fetch(`${API}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  // 供应商 + 模型（translate 用途，含定价）
  const prov = await adminAuth('/api/admin/ai/providers', { type: 'openai', name: `供应商${TAG}`, apiKey: 'sk-test' })
    .then((r) => r.json() as Promise<{ provider: { id: string } }>)
  expect(prov.provider?.id).toBeTruthy()
  const model = await adminAuth('/api/admin/ai/models', {
    providerId: prov.provider.id, modelName: `gpt-${TAG}`, label: modelLabel,
    purposes: ['translate'], creditsPerMillionInput: 1000, creditsPerMillionOutput: 2000, minCredits: 1
  }).then((r) => r.json() as Promise<{ model: { id: string } }>)
  expect(model.model?.id).toBeTruthy()

  // 客户老板 + 给余额（autoTopUpCredits 默认开，扣费时余额自动换积分）
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await adminAuth('/api/admin/balance-adjust', { email, deltaCents: 500, note: 'e2e 充值' })

  // 客户扣一次翻译用量
  const charge = await fetch(`${API}/api/billing/usage/charge`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: model.model.id, purpose: 'translate', inputTokens: 100_000, outputTokens: 50_000 })
  })
  expect(charge.ok, `扣费应成功: ${await charge.clone().text()}`).toBeTruthy()

  // 后台用量报表
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /用量报表|Usage/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: modelLabel })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('翻译') // 用途

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-usage-report.png`, fullPage: true })
})
