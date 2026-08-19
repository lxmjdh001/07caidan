import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// 无 ANTHROPIC_API_KEY 时「分析该会话」应优雅降级：返回 501 → 界面提示未配置 AI，不崩
test('后台意向分析：无 key 时点分析给出友好提示', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const title = `分析客户${TAG}`
  const id = `whatsapp:a1:cust${TAG}`
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  await fetch(`${API}/api/sync`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId: id, title, isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${id}:in`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: '这个多少钱？', timestamp: now }]
    })
  })

  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  // 先搜索定位到该会话再点，避免共享租户会话多时列表拥挤/时序竞态导致找不到
  await page.locator('input[placeholder="搜索客户…"]').fill(title)
  await page.locator('.conv', { hasText: title }).click({ timeout: 15_000 })

  // 点「分析该会话」→ 服务端无 key 返回 501 → 面板提示未配置 AI
  await page.getByRole('button', { name: /分析该会话|重新分析|Analyze/ }).click()
  await expect(page.getByText(/后台未配置 AI|ANTHROPIC_API_KEY/)).toBeVisible({ timeout: 10_000 })
  // 界面未崩：意向面板仍在
  await expect(page.locator('.analysis')).toBeVisible()

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-analyze-nokey.png`, fullPage: true })
})
