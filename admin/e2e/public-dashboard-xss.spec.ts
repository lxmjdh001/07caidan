import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// 红线（XSS 安全）：公开看板是原生 HTML(innerHTML) 页，工单名/账号标签等成员可控内容
// 必须经 esc() 转义，绝不执行。恶意工单名会被分享给整个打粉团队查看。
test('公开看板：恶意工单名经转义不执行', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const evil = `<img src=x onerror="window.__DASH_XSS=1">看板注入${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: evil, accountIds: ['a1'], accountLabels: { a1: '主号' }, startAt: Date.now() - 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: 'xss' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)

  await page.goto(`${API}/c/${link.link.token}`)
  // 看板名以转义文本显示，含字面 <img；未注入真实 img、未触发 onerror
  await expect(page.locator('h1')).toContainText(`<img src=x onerror=`, { timeout: 15_000 })
  await expect(page.locator('h1')).toContainText(`看板注入${TAG}`)
  await expect(page.locator('img')).toHaveCount(0)
  const fired = await page.evaluate(() => (window as unknown as { __DASH_XSS?: number }).__DASH_XSS ?? 0)
  expect(fired).toBe(0)
  // 原始 payload 不以可执行 HTML 出现在文档中（转义后应是 &lt;img）
  expect(await page.content()).not.toContain('<img src=x onerror=')

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/public-dashboard-xss.png`, fullPage: true })
})

// 工单名之外，看板还渲染「账号标签」(byAccount) 与「投放来源码」(byCode)——两者也成员可控，
// 但走的是 accountRows/codeRows 另一套渲染路径。名字那条用例保不住这两条路径：谁日后重构
// 时漏掉 esc()，团队看板就有存储型 XSS。这里把这两个向量也钉死（需先灌一条进线，byAccount/
// byCode 才会有行渲染出来）。
test('公开看板：恶意账号标签/来源码同样经转义不执行', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const evilLabel = `<img src=x onerror="window.__LBL_XSS=1">标签${TAG}`
  const evilCode = `<b onmouseover="window.__CODE_XSS=1">码${TAG}`
  const email = `boss_lbl_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }

  // 灌一条 a1 账号、带来源码的进线，落在工单窗口内 → byAccount/byCode 才有行
  const at = Date.now() - 3_600_000
  const convId = `whatsapp:a1:wa:+15550000${TAG.slice(-3).replace(/[^0-9]/g, '0')}`
  await fetch(`${API}/api/sync`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      conversations: [{ id: convId, channel: 'whatsapp', accountId: 'a1', contactId: convId.slice('whatsapp:a1:'.length), title: '客户', isGroup: false, lastMessageAt: at, leadSourceCode: evilCode, leadSourceVia: 'code' }],
      messages: [{ externalId: `${convId}:in:${at}`, conversationId: convId, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text: 'hi', timestamp: at }]
    })
  })

  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: `标签工单${TAG}`, accountIds: ['a1'], accountLabels: { a1: evilLabel }, startAt: Date.now() - 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: 'xss2' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)

  await page.goto(`${API}/c/${link.link.token}`)
  // byAccount 行以转义文本显示恶意标签；未注入真实 img、未触发 onerror
  await expect(page.getByText(`标签${TAG}`).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('img')).toHaveCount(0)
  // byCode 行同样转义显示来源码字面量
  await expect(page.getByText(`码${TAG}`).first()).toBeVisible()
  const fired = await page.evaluate(() => {
    const w = window as unknown as { __LBL_XSS?: number; __CODE_XSS?: number }
    return (w.__LBL_XSS ?? 0) + (w.__CODE_XSS ?? 0)
  })
  expect(fired).toBe(0)
  const html = await page.content()
  expect(html).not.toContain('<img src=x onerror=')
  expect(html).not.toContain('<b onmouseover=')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/public-dashboard-xss-label.png`, fullPage: true })
})
