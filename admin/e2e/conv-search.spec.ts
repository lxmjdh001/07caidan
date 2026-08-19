import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

const TAG = Date.now().toString(36).slice(-5)
const NUM = String(Date.now()).slice(-7)
const A_TITLE = `甲客${TAG}`
const B_TITLE = `乙客${TAG}`
const A_PHONE = `1900${NUM}` // 甲的号码尾段（乙用 1800，互不含）
const A_CONTACT = `wa:+${A_PHONE}`
const B_CONTACT = `wa:+1800${NUM}`

async function seed(): Promise<void> {
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const now = Date.now()
  const mk = (title: string, contactId: string) => {
    const id = `whatsapp:a1:${contactId}`
    return {
      conversations: [{ id, channel: 'whatsapp', accountId: 'a1', contactId, title, isGroup: false, lastMessageAt: now }],
      messages: [{ externalId: `${id}:in`, conversationId: id, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: '你好', timestamp: now }]
    }
  }
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk(A_TITLE, A_CONTACT)) })
  await fetch(`${API}/api/sync`, { method: 'POST', headers: auth, body: JSON.stringify(mk(B_TITLE, B_CONTACT)) })

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 轮询直到两条会话都进入后台池
  await expect.poll(async () => {
    const r = (await fetch(`${API}/api/conversations?limit=500`, { headers: { authorization: `Bearer ${admin.token}` } }).then((x) => x.json())) as { conversations?: Array<{ title?: string }> }
    return (r.conversations ?? []).filter((c) => c.title === A_TITLE || c.title === B_TITLE).length
  }, { timeout: 10_000 }).toBe(2)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 后台会话搜索：按标题过滤，并覆盖「按 contactId（号码）过滤」这条 chat-thread 未断言的分支
test('后台会话搜索：标题与号码两种匹配', async ({ page }) => {
  await seed()
  await login(page)
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()

  const search = page.locator('.list-head input')
  await expect(page.locator('.conv', { hasText: A_TITLE })).toBeVisible({ timeout: 10_000 })

  // 按标题搜甲：甲在、乙不在，计数为 1
  await search.fill(A_TITLE)
  await expect(page.locator('.conv', { hasText: A_TITLE })).toBeVisible()
  await expect(page.locator('.conv', { hasText: B_TITLE })).toHaveCount(0)
  await expect(page.locator('.list-head .count')).toHaveText('1')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-conv-search.png`, fullPage: true })

  // 按号码搜甲（乙号码不含此串）：命中 contactId 分支，甲在、乙不在
  await search.fill(A_PHONE)
  await expect(page.locator('.conv', { hasText: A_TITLE })).toBeVisible()
  await expect(page.locator('.conv', { hasText: B_TITLE })).toHaveCount(0)
  await expect(page.locator('.list-head .count')).toHaveText('1')
})
