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

// M17 到期提醒配置：启用 + 提前天数 + 邮件模板 → 保存 → 离开再回来仍生效
test('后台到期提醒：配置提前天数与模板并核对持久化', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  await login(page)
  await page.getByRole('button', { name: /运营公告|Announcements/ }).click()

  const card = page.locator('section.card').filter({ hasText: '到期提醒' })
  await expect(card).toBeVisible({ timeout: 10_000 })

  // 启用 + 提前天数设为单一值 5（便于无歧义核对）
  await card.locator('label.check', { hasText: '启用到期提醒' }).locator('input[type="checkbox"]').check()
  const daysInput = card.locator('label', { hasText: '提前天数' }).locator('input')
  await daysInput.fill('5')
  const subjInput = card.locator('label', { hasText: '邮件主题模板' }).locator('input')
  await subjInput.fill(`续费提醒${TAG}`)

  await card.getByRole('button', { name: '保存' }).click()
  await expect(card.getByText('✓')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-expiry-reminder.png`, fullPage: true })

  // 离开去聊天记录，再回运营公告 → 强制从服务端重新拉取
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  await page.getByRole('button', { name: /运营公告|Announcements/ }).click()
  const card2 = page.locator('section.card').filter({ hasText: '到期提醒' })
  await expect(card2.locator('label', { hasText: '提前天数' }).locator('input')).toHaveValue('5')
  await expect(card2.locator('label', { hasText: '邮件主题模板' }).locator('input')).toHaveValue(
    `续费提醒${TAG}`
  )
})
