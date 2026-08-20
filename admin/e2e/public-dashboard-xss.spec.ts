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
