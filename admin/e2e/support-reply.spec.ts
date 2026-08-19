import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'
const TITLE = `后台回复测试_${Date.now().toString(36)}`

async function seedTicket(): Promise<void> {
  const email = `boss_${Date.now().toString(36)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/support/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: TITLE, body: '客户端提交的软件问题，等待后台回复。' })
  })
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台支持工单：打开工单并回复，状态转已回复', async ({ page }) => {
  await seedTicket()
  await login(page)
  await page.getByRole('button', { name: /支持工单|Support/ }).click()

  // 打开该工单
  await page.locator('.cl-name', { hasText: TITLE }).click()
  // 回复
  await page.locator('.sup-reply textarea').fill('已收到，请更新到最新版本后重试。')
  await page.locator('.sup-reply button').click()

  // 回复出现在对话，状态转「已回复」
  await expect(page.getByText('已收到，请更新到最新版本后重试。')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('已回复').first()).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-support-reply.png`, fullPage: true })
})
