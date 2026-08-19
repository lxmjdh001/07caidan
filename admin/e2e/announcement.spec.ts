import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台运营公告：发布公告并在列表核对', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /运营公告|Announcements/ }).click()

  const card = page.locator('section.card').filter({ hasText: /发布公告|New announcement/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('input').first().fill('E2E 公告测试')
  await card.locator('textarea').first().fill('这是一条端到端测试公告，受众默认全部用户。')
  await card.getByRole('button', { name: '发布' }).click()

  // 已发布列表出现该公告
  const row = page.locator('table tbody tr').filter({ hasText: 'E2E 公告测试' })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-announcement.png`, fullPage: true })
})
