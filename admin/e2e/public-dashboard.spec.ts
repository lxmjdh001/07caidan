import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

const API = 'http://127.0.0.1:8798'

/** 注册老板 → 同步入站会话 → 建工单 → 建分享链接，返回公开 token 与灌入的号码 */
async function seed(): Promise<{ token: string; phone: string; srcCode: string }> {
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }

  const now = Date.now()
  const inAt = now - 3600_000
  // 唯一账号/号码：共享持久库里 a1 等固定账号已累积上百条历史进线，
  // 工单按账号统计会把它们全算进来 → 数字不确定。用当次唯一账号锁定「恰好 1 条进线」。
  const TAG = Date.now().toString(36).slice(-6)
  const acct = `a_${TAG}`
  const phone = `wa:+1555${TAG.replace(/[^0-9]/g, '0')}`
  const convId = `whatsapp:${acct}:${phone}`
  const srcCode = `src${TAG}`
  await fetch(`${API}/api/sync`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      conversations: [
        { id: convId, channel: 'whatsapp', accountId: acct, contactId: phone, title: 'C', isGroup: false, lastMessageAt: inAt, leadSourceCode: srcCode, leadSourceVia: 'code' }
      ],
      messages: [
        { externalId: `${convId}:in`, conversationId: convId, channel: 'whatsapp', accountId: acct, direction: 'in', bodyType: 'text', text: 'hi', timestamp: inAt }
      ]
    })
  })

  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: '公开看板演示', accountIds: [acct], accountLabels: { [acct]: '主号' }, startAt: now - 2 * 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)

  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ label: '演示' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  return { token: link.link.token, phone, srcCode }
}

test('公开看板 /c/:token：免登录聚合统计页渲染', async ({ page }) => {
  const { token, phone, srcCode } = await seed()
  await page.goto(`${API}/c/${token}`)

  // 页面拉 /public/campaign/:token 后渲染工单名与进线数字
  await expect(page.getByText('公开看板演示')).toBeVisible({ timeout: 15_000 })

  // 三张聚合卡：进线总数 1 / 重复 0 / 有效 1（1 条入站、无去重）
  await expect(page.locator('.card', { hasText: '进线总数' }).locator('.v')).toHaveText('1')
  await expect(page.locator('.card', { hasText: '有效' }).locator('.v')).toHaveText('1')

  // 账号明细（老板分享给团队看的按账号拆分）：显示账号备注名「主号」+ 平台 whatsapp + 进线 1
  // accountRows() 此前无任何断言；这是看板核心可分享内容，且必须只出备注名不出号码
  const acctRow = page.locator('section', { hasText: '账号明细' }).locator('table tbody tr', { hasText: '主号' })
  await expect(acctRow).toBeVisible({ timeout: 10_000 })
  await expect(acctRow).toContainText('whatsapp')
  await expect(acctRow.locator('td.num').first()).toHaveText('1')

  // 投放来源拆分（引流入口链接成效）：带 leadSourceCode 的进线要归到该来源。
  // sourceRows() 此前无断言；这条端到端串起 sync(leadSourceCode)→bySource→看板渲染
  const srcRow = page.locator('section', { hasText: '投放来源' }).locator('table tbody tr', { hasText: srcCode })
  await expect(srcRow).toBeVisible({ timeout: 10_000 })
  await expect(srcRow).toContainText('追踪码') // via='code' 渲染为追踪码
  await expect(srcRow.locator('td.num').first()).toHaveText('1')

  // 红线：公开页绝不含粉丝身份（号码/contactId），账号列只出备注名
  const html = await page.content()
  expect(html).not.toContain(phone)
  expect(html).not.toContain(phone.replace('wa:', ''))
  expect(html).not.toContain('wa:+')

  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOT_DIR}/public-dashboard.png`, fullPage: true })
})
