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

// 后台会话列表按最近消息时间倒序（server orderBy desc(lastMessageAt)）。
// chat-thread/intent-filter/conv-search 都没断言会话排序，此前没测。
test('后台会话列表：按最近消息时间倒序', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  const mk = (n: string, ago: number) => {
    const id = `whatsapp:a1:${n}${TAG}`
    return {
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId: `wa:+199${n}${TAG.replace(/[^0-9]/g, '0')}`, title: `${n}会话${TAG}`, isGroup: false, lastMessageAt: now - ago }],
      messages: [{ externalId: `${id}:m`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: 'hi', timestamp: now - ago }]
    }
  }
  // 分别 sync（旧最久前 / 中 / 新最近）
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('旧', 3000)) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('中', 2000)) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk('新', 1000)) })

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await expect.poll(async () => {
    const r = (await fetch(`${API}/api/conversations?limit=500`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ title?: string }> }
    return (r.conversations ?? []).filter((c) => (c.title ?? '').includes(`会话${TAG}`)).length
  }, { timeout: 10_000 }).toBe(3)

  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  await page.locator('.list-head input').fill(`会话${TAG}`)

  const convs = page.locator('.conv')
  await expect(convs).toHaveCount(3, { timeout: 10_000 })
  // 最新在最上：新 → 中 → 旧
  await expect(convs.nth(0)).toContainText(`新会话${TAG}`)
  await expect(convs.nth(1)).toContainText(`中会话${TAG}`)
  await expect(convs.nth(2)).toContainText(`旧会话${TAG}`)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-conv-sort.png`, fullPage: true })
})
