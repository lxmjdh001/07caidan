import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'
const TITLE = `后台关闭测试_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

async function seedTicket(): Promise<void> {
  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/support/tickets`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE, body: '客户端提交的问题，处理完后由后台关闭。' })
  })
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M9 后台支持工单：管理员关闭工单 → 状态转「已关闭」，关闭按钮消失（support-reply 只覆盖了回复）
test('后台支持工单：关闭工单，状态转已关闭', async ({ page }) => {
  await seedTicket()
  await login(page)
  await page.getByRole('button', { name: /支持工单|Support/ }).click()

  await page.locator('.cl-name', { hasText: TITLE }).click()

  // 打开时为「待处理」，头部有「关闭工单」按钮
  const closeBtn = page.getByRole('button', { name: '关闭工单' })
  await expect(closeBtn).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('待处理').first()).toBeVisible()

  await closeBtn.click()

  // 关闭后：状态变「已关闭」，关闭按钮消失（status === closed 时不再渲染）
  await expect(page.getByText('已关闭').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '关闭工单' })).toHaveCount(0)

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-support-close.png`, fullPage: true })
})
