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

// M13 公告定向受众：选「新注册用户」+ 天数 → 列表受众列显示「注册 N 天内」。
// announcement 只覆盖默认「全部用户」，定向受众（new_users/expiring/plan）此前没测。
test('后台运营公告：定向新注册用户受众并核对', async ({ page }) => {
  const title = `定向公告_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('button', { name: /运营公告|Announcements/ }).click()

  const card = page.locator('section.card').filter({ hasText: /发布公告|New announcement/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('input').first().fill(title)
  // 受众选「新注册用户」→ 出现天数输入 → 填 30
  await card.locator('label', { hasText: '受众' }).locator('select').selectOption('new_users')
  await card.locator('input[placeholder="7"]').fill('30')
  await card.locator('textarea').first().fill('仅对近 30 天新注册用户展示的定向公告。')
  await card.getByRole('button', { name: '发布' }).click()

  // 列表出现该公告，受众列显示「注册 30 天内」
  const row = page.locator('table tbody tr').filter({ hasText: title })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).toContainText('注册 30 天内')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-announcement-audience.png`, fullPage: true })

  // 自清理
  await row.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: title })).toHaveCount(0, { timeout: 10_000 })
})
