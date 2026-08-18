import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const API = 'http://127.0.0.1:8798'

/** 注册老板 → 同步入站会话 → 建工单 → 建分享链接，返回公开 token */
async function seed(): Promise<string> {
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }

  const now = Date.now()
  const inAt = now - 3600_000
  const convId = 'whatsapp:a1:wa:+15550009'
  await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      conversations: [
        { id: convId, channel: 'whatsapp', accountId: 'a1', contactId: 'wa:+15550009', title: 'C', isGroup: false, lastMessageAt: inAt }
      ],
      messages: [
        { externalId: `${convId}:in`, conversationId: convId, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: 'hi', timestamp: inAt }
      ]
    })
  })

  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: '公开看板演示', accountIds: ['a1'], accountLabels: { a1: '主号' }, startAt: now - 2 * 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)

  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ label: '演示' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  return link.link.token
}

test('公开看板 /c/:token：免登录聚合统计页渲染', async ({ page }) => {
  const token = await seed()
  await page.goto(`${API}/c/${token}`)

  // 页面拉 /public/campaign/:token 后渲染工单名与进线数字
  await expect(page.getByText('公开看板演示')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/1/).first()).toBeVisible()

  // 红线：公开页绝不含粉丝身份（号码/contactId）
  const html = await page.content()
  expect(html).not.toContain('+15550009')
  expect(html).not.toContain('wa:+')

  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOT_DIR}/public-dashboard.png`, fullPage: true })
})
