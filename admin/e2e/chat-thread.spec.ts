import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// M5 聊天记录查看核心：归档的会话打开后，收/发气泡与译文都正确渲染
test('后台聊天记录：打开会话显示收发消息气泡与译文', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const title = `跨境客户${TAG}`
  const id = `whatsapp:a1:cust${TAG}`
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId: id, title, isGroup: false, lastMessageAt: now }],
      messages: [
        // 客户入站原文 + 译成坐席语言
        { externalId: `${id}:in`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: '你好，这个还有货吗？', translationText: 'Hi, is this still in stock?', translationLang: 'en', timestamp: now - 60_000 },
        // 坐席出站
        { externalId: `${id}:out`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'out', bodyType: 'text', text: 'Yes, still in stock!', timestamp: now }
      ]
    })
  })

  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  // 先搜索过滤再点，避免共享租户会话多时列表拥挤/时序竞态
  await page.locator('input[placeholder="搜索客户…"]').fill(title)
  await page.locator('.conv', { hasText: title }).click({ timeout: 15_000 })

  // 入站气泡：原文 + 译文都在
  const inRow = page.locator('.row.in').filter({ hasText: '你好，这个还有货吗？' })
  await expect(inRow).toBeVisible({ timeout: 10_000 })
  await expect(inRow.locator('.tr')).toHaveText('Hi, is this still in stock?')
  // 出站气泡：坐席回复，方向为 out
  await expect(page.locator('.row.out').filter({ hasText: 'Yes, still in stock!' })).toBeVisible()

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-chat-thread.png`, fullPage: true })
})
