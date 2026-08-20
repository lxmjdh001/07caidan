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

// 后台聊天记录里媒体消息以占位「[image] 图注」显示（后台会话视图不内嵌图，只给占位+图注）。
// chat-thread 只覆盖文本消息，媒体占位此前没测。
test('后台聊天记录：媒体消息显示占位与图注', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const title = `媒体会话${TAG}`
  const caption = `产品实拍${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  const cid = `whatsapp:a1:${title}`
  await fetch(`${API}/api/sync`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      conversations: [{ id: cid, channel: 'whatsapp', accountId: 'a1', contactId: `wa:+1888${TAG.replace(/[^0-9]/g, '0')}`, title, isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${cid}:m1`, conversationId: cid, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'media', mediaType: 'image', caption, timestamp: now }]
    })
  })
  // 轮询后台可见
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await expect.poll(async () => {
    const r = (await fetch(`${API}/api/conversations?limit=500`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ title?: string }> }
    return (r.conversations ?? []).some((c) => c.title === title)
  }, { timeout: 10_000 }).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  await page.locator('.list-head input').fill(title)
  await page.locator('.conv', { hasText: title }).click()

  // 媒体消息气泡以「[image] 图注」占位显示
  await expect(page.locator('.bubble-text', { hasText: `[image] ${caption}` })).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-chat-media-placeholder.png`, fullPage: true })
})
