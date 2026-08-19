import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'
const REPO = join(import.meta.dirname, '..', '..')

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M18 后台支持工单看客户上传的贴图：TicketImage → mediaObjectUrl（带鉴权取字节 → blob）→ <img>。
// client-support-image 覆盖的是反方向（客户端看客服回复图），后台渲染客户上传图此前没测。
test('后台支持工单：渲染客户上传的贴图', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const title = `贴图工单${TAG}`
  const mediaId = `cli-img-${TAG}.png`

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `boss_${TAG}@e2e.test`, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}` }
  // 客户上传图片
  const up = await fetch(`${API}/api/media/${mediaId}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'image/png' },
    body: readFileSync(join(REPO, 'branding', 'default', 'icon.png'))
  })
  expect(up.ok).toBeTruthy()
  // 客户带图建工单（首条消息携带 mediaId）
  const tk = await fetch(`${API}/api/support/tickets`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ title, body: '界面异常，附截图一张。', mediaId })
  })
  expect(tk.ok).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: /支持工单|Support/ }).click()
  await page.locator('.cl-name', { hasText: title }).click()

  // 后台工单详情里渲染该客户上传图，且图片真的加载成功（naturalWidth>0）
  const img = page.locator('.ticket-img').first()
  await expect(img).toBeVisible({ timeout: 10_000 })
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-support-ticket-image.png`, fullPage: true })
})
