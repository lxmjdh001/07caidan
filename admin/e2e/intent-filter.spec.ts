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
  const mk = (n: string, text: string) => {
    const id = `whatsapp:a1:${n}`
    return {
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId: n, title: n, isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${id}:in`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text, timestamp: now }]
    }
  }
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('高意向客户', '多少钱怎么买')) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('咨询客户', '有货吗？')) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('闲聊客户', '你好')) })

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await expect
    .poll(async () => {
      const r = (await fetch(`${API}/api/conversations`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ intentLevel?: string }> }
      return (r.conversations ?? []).filter((c) => c.intentLevel && c.intentLevel !== 'unknown').length
    }, { timeout: 10_000 })
    .toBe(3)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台会话按意向筛选：只看高意向', async ({ page }) => {
  await seed()
  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  await expect(page.locator('.conv')).toHaveCount(3)

  // 点「高意向」筛选 → 只剩 1 条
  await page.locator('.intent-filter button', { hasText: '高意向' }).click()
  await expect(page.locator('.conv')).toHaveCount(1)
  await expect(page.locator('.conv')).toContainText('高意向客户')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-intent-filter.png`, fullPage: true })

  // 「全部」恢复
  await page.locator('.intent-filter button', { hasText: '全部' }).click()
  await expect(page.locator('.conv')).toHaveCount(3)
})
