import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const API = 'http://127.0.0.1:8798'

/**
 * 用后台 API 造一份「有进线的工单」：注册老板 → 同步一条入站会话 → 建工单。
 * 账号/联系人/工单名全部带唯一 TAG —— 后台并行跑多个造会话用例时共享同一租户，
 * 若都用固定 a1 账号会互相污染进线计数，唯一账号让本工单统计稳定 = 1。
 */
async function seedCampaign(): Promise<string> {
  const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const token = reg.token
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const now = Date.now()
  const startAt = now - 2 * 86_400_000
  const inAt = now - 3600_000
  const acc = `sa${TAG}`
  const contact = `wa:+1555${TAG.replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6)}`
  const convId = `whatsapp:${acc}:${contact}`
  const name = `E2E推广${TAG}`
  await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      conversations: [
        {
          id: convId,
          channel: 'whatsapp',
          accountId: acc,
          contactId: contact,
          title: '客户A',
          isGroup: false,
          lastMessageAt: inAt
        }
      ],
      messages: [
        {
          externalId: `${convId}:in:${inAt}`,
          conversationId: convId,
          channel: 'whatsapp',
          accountId: acc,
          direction: 'in',
          bodyType: 'text',
          text: 'مرحبا',
          timestamp: inAt
        }
      ]
    })
  })

  await fetch(`${API}/api/campaigns`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name,
      accountIds: [acc],
      accountLabels: { [acc]: '主号 A' },
      startAt
    })
  })
  return name
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台工单：查看有进线的工单统计并截图', async ({ page }) => {
  const name = await seedCampaign()
  await login(page)

  await page.getByRole('button', { name: /引流工单|Campaigns/ }).click()
  // 左侧工单列表出现我们造的（唯一命名）工单，点开看统计
  const item = page.getByText(name).first()
  await expect(item).toBeVisible({ timeout: 10_000 })
  await item.click()

  // 统计区渲染（进粉/进线标签）
  await expect(page.getByText(/进粉|进线|Leads/).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOT_DIR}/admin-campaign-stats.png`, fullPage: true })
})
