import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// 粉丝身份（号码）与消息正文——公开 JSON 绝不能出现
const PHONE = `15550${String(Date.now()).slice(-6)}`
const CONTACT = `wa:+${PHONE}`
const SECRET_TEXT = `topsecret${Date.now().toString(36)}`

async function seed(): Promise<{ token: string; name: string }> {
  const name = `红线看板${Date.now().toString(36).slice(-5)}`
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }

  const now = Date.now()
  const inAt = now - 3600_000
  const convId = `whatsapp:a1:${CONTACT}`
  await fetch(`${API}/api/sync`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      conversations: [{ id: convId, channel: 'whatsapp', accountId: 'a1', contactId: CONTACT, title: '某客户', isGroup: false, lastMessageAt: inAt }],
      messages: [{ externalId: `${convId}:in`, conversationId: convId, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: SECRET_TEXT, timestamp: inAt }]
    })
  })
  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name, accountIds: ['a1'], accountLabels: { a1: '主号' }, startAt: now - 2 * 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: '演示' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  return { token: link.link.token, name }
}

// 红线：公开分享端点的原始 JSON 只给聚合数字，绝不含任何粉丝身份或消息正文
// （public-dashboard 只查渲染后的 HTML；直连 JSON 的攻击者拿到的才是真正边界）
test('公开分享端点 JSON 红线：只给聚合，绝不泄露粉丝身份/正文', async ({ page }) => {
  const { token, name } = await seed()

  const res = await fetch(`${API}/public/campaign/${token}`)
  expect(res.status).toBe(200)
  const json = (await res.json()) as {
    campaign: { name: string; dedup: { libraries: number } }
    stats: { total: number; duplicate: number; fresh: number; effective: number; byAccount: unknown[]; byDay: unknown[] }
  }

  // 聚合结构齐备
  expect(json.campaign.name).toBe(name)
  expect(typeof json.stats.total).toBe('number')
  expect(typeof json.stats.effective).toBe('number')
  expect(json.stats.total).toBeGreaterThanOrEqual(1)
  expect(Array.isArray(json.stats.byAccount)).toBeTruthy()
  expect(Array.isArray(json.stats.byDay)).toBeTruthy()
  // dedup 只给库数量（number），不给库内容
  expect(typeof json.campaign.dedup.libraries).toBe('number')

  // 红线：整段 JSON 不得出现粉丝号码/contactId 前缀/消息正文/身份字段名
  const raw = JSON.stringify(json)
  expect(raw).not.toContain(PHONE)
  expect(raw).not.toContain('wa:+')
  expect(raw).not.toContain(SECRET_TEXT)
  expect(raw).not.toContain('contactId')

  // 公开页渲染（免登录）+ 截图，页面也不含身份
  await page.goto(`${API}/c/${token}`)
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  const html = await page.content()
  expect(html).not.toContain(PHONE)
  expect(html).not.toContain(SECRET_TEXT)

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/public-api-redline.png`, fullPage: true })
})
