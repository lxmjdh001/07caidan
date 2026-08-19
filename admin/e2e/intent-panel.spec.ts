import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function seed(): Promise<void> {
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  const id = 'whatsapp:a1:高意向客户'
  await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId: '高意向客户', title: '高意向客户', isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${id}:in`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: '这个多少钱？怎么买', timestamp: now }]
    })
  })
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await expect
    .poll(async () => {
      const r = (await fetch(`${API}/api/conversations`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ intentLevel?: string }> }
      return (r.conversations ?? []).some((c) => c.intentLevel === 'high')
    }, { timeout: 10_000 })
    .toBe(true)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('打开会话即显示已存意向分析（无需点分析、无需 key）', async ({ page }) => {
  await seed()
  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  // 先搜索过滤再点，避免共享租户会话多时列表拥挤/时序竞态
  await page.locator('input[placeholder="搜索客户…"]').fill('高意向客户')
  await page.locator('.conv', { hasText: '高意向客户' }).click({ timeout: 15_000 })

  // AnalysisPanel 自动读取并显示已落库意向，无需点「分析」
  await expect(page.locator('.analysis .level.high')).toHaveText('高意向', { timeout: 10_000 })
  await expect(page.locator('.analysis')).toContainText('购买意向强')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-intent-panel.png`, fullPage: true })
})
