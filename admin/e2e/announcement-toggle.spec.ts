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

// M13 运营公告：停用切换（行转 row-off、状态列翻转）+ 删除（自清理）——announcement.spec 只覆盖了发布
test('后台运营公告：停用切换与删除', async ({ page }) => {
  const title = `E2E公告切换_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  // 删除有 window.confirm，统一接受
  page.on('dialog', (d) => void d.accept())

  await login(page)
  await page.getByRole('button', { name: /运营公告|Announcements/ }).click()

  const card = page.locator('section.card').filter({ hasText: /发布公告|New announcement/i })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.locator('input').first().fill(title)
  await card.locator('textarea').first().fill('停用切换端到端测试；结束时删除，不污染用户端通知。')
  await card.getByRole('button', { name: '发布' }).click()

  const row = page.locator('table tbody tr').filter({ hasText: title })
  await expect(row).toBeVisible({ timeout: 10_000 })
  // 初始启用：不带 row-off，状态列（第 3 列）显示「启用」
  await expect(row).not.toHaveClass(/row-off/)
  await expect(row.locator('td').nth(2)).toHaveText('启用')

  // 点「停用」→ 行转 row-off，状态列翻为「停用」，按钮变「启用」
  await row.getByRole('button', { name: '停用' }).click()
  await expect(row).toHaveClass(/row-off/, { timeout: 10_000 })
  await expect(row.locator('td').nth(2)).toHaveText('停用')
  await expect(row.getByRole('button', { name: '启用' })).toBeVisible()

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-announcement-toggle.png`, fullPage: true })

  // 自清理：删除该公告，行消失（避免遗留公告污染后续 spec 的通知弹窗）
  await row.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('table tbody tr').filter({ hasText: title })).toHaveCount(0, { timeout: 10_000 })
})
