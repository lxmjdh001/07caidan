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

// 后台出站消息译文双显：坐席发出的消息(客户语言) + 坐席原文(translationText) 都显示。
// chat-thread 只验了入站译文，出站消息的 .tr 双显此前没测。
test('后台聊天记录：出站消息显示发送文本与坐席原文双显', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const title = `出站译文会话${TAG}`
  const sent = `Yes, in stock! ${TAG}` // 发给客户（英文）
  const original = `有货的坐席原文${TAG}` // 坐席中文原文
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
      conversations: [{ id: cid, channel: 'whatsapp', accountId: 'a1', contactId: `wa:+1877${TAG.replace(/[^0-9]/g, '0')}`, title, isGroup: false, lastMessageAt: now }],
      messages: [
        { externalId: `${cid}:in`, conversationId: cid, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: 'still available?', timestamp: now - 1000 },
        // 出站：发出的英文 + 坐席中文原文
        { externalId: `${cid}:out`, conversationId: cid, channel: 'whatsapp', accountId: 'a1', direction: 'out', bodyType: 'text', text: sent, translationText: original, translationLang: 'zh', timestamp: now }
      ]
    })
  })
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

  // 出站气泡：发送文本 + 坐席原文（.tr）双显
  const outRow = page.locator('.row.out').filter({ hasText: sent })
  await expect(outRow).toBeVisible({ timeout: 10_000 })
  await expect(outRow.locator('.tr')).toHaveText(original)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-chat-outbound-translation.png`, fullPage: true })
})
