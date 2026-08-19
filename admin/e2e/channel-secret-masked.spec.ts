import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 红线：支付通道回调密钥等配置只回传打码版（maskChannelConfig），原始密钥不进前端/接口响应。
// payment-channel 建的是无密钥 mock 通道，通道密钥打码此前没测。
test('后台计费：支付通道回调密钥打码、原始密钥不泄露', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const chName = `密钥通道${TAG}`
  const RAW_SECRET = `chsecret-${TAG}-topsecretvalue`

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await page.getByRole('button', { name: /支付通道|Channels/ }).click()

  const card = page.locator('section.card').filter({ hasText: /新建支付通道|New channel/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('select').first().selectOption('mock')
  await card.locator('label', { hasText: /通道名称|Name/i }).locator('input').fill(chName)
  // mock 通道的配置字段：回调密钥
  await card.locator('label', { hasText: '回调密钥' }).locator('input').fill(RAW_SECRET)
  await card.getByRole('button', { name: '创建' }).click()

  // 通道行出现，整页 HTML 不含原始密钥
  const row = page.locator('table tbody tr').filter({ hasText: chName })
  await expect(row).toBeVisible({ timeout: 10_000 })
  expect(await page.content()).not.toContain(RAW_SECRET)
  expect(await page.content()).not.toContain('topsecretvalue')

  // 接口响应也只回打码版，不含原始密钥
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const raw = await fetch(`${API}/api/admin/channels`, { headers: { authorization: `Bearer ${admin.token}` } }).then((r) => r.text())
  expect(raw).not.toContain(RAW_SECRET)
  expect(raw).not.toContain('topsecretvalue')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-channel-secret-masked.png`, fullPage: true })
})
