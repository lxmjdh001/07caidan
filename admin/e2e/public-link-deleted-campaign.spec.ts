import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

// 红线（数据一致性）：删除工单后其分享链接必须立即失效（404），不能留下对已删工单
// 聚合数据的公开访问。sharelink-revoke/expiry 覆盖了撤销/过期，删工单级联此前没测。
test('公开看板：删除工单后分享链接立即 404', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const name = `待删看板工单${TAG}`
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  const camp = await fetch(`${API}/api/campaigns`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name, accountIds: ['a1'], accountLabels: { a1: '主号' }, startAt: Date.now() - 86_400_000 })
  }).then((r) => r.json() as Promise<{ campaign: { id: string } }>)
  const link = await fetch(`${API}/api/campaigns/${camp.campaign.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ label: 'del' })
  }).then((r) => r.json() as Promise<{ link: { token: string } }>)
  const token = link.link.token

  // 删除前：公开端点 200
  expect((await fetch(`${API}/public/campaign/${token}`)).status).toBe(200)

  // 删除工单
  const del = await fetch(`${API}/api/campaigns/${camp.campaign.id}`, { method: 'DELETE', headers: auth })
  expect(del.ok).toBeTruthy()

  // 删除后：公开端点 404（工单没了，链接失效）
  const after = await fetch(`${API}/public/campaign/${token}`)
  expect(after.status).toBe(404)

  // 公开页显示友好失效态（链接无效 / 工单已被删除），不显示已删工单名
  await page.goto(`${API}/c/${token}`)
  await expect(page.getByText('链接无效')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/工单已被删除/)).toBeVisible()
  await expect(page.getByText(name)).toHaveCount(0)
  await page.screenshot({ path: `${SHOT_DIR}/public-link-deleted-campaign.png`, fullPage: true })
})
