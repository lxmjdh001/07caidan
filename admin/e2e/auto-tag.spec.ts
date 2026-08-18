import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const API = 'http://127.0.0.1:8798'

/** 注册老板并同步一条高意向 + 一条低意向入站会话 */
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
    const convId = `whatsapp:a1:${n}`
    return {
      conversations: [{ id: convId, channel: 'whatsapp', accountId: 'a1', contactId: n, title: n, isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${convId}:in`, conversationId: convId, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text, timestamp: now }]
    }
  }
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('高意向客户', '这个多少钱？怎么买')) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('闲聊客户', '你好呀')) })

  // 自动打标签是同步后 fire-and-forget；用管理员令牌轮询 /api/conversations 直到标签落库
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await expect
    .poll(
      async () => {
        const r = (await fetch(`${API}/api/conversations`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ intentLevel?: string }> }
        return (r.conversations ?? []).filter((c) => c.intentLevel).length
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(2)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台聊天记录：会话列表显示实时意向标签', async ({ page }) => {
  await seed()
  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()

  // 高意向会话带「高意向」标签
  const hi = page.locator('.conv', { hasText: '高意向客户' })
  await expect(hi).toBeVisible({ timeout: 10_000 })
  await expect(hi.locator('.tag.intent-high')).toHaveText('高意向')

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-auto-tag.png`, fullPage: true })
})
