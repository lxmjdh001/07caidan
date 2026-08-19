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

// 后台 RBAC：管理员在用户管理里停用一个控制台用户，状态持久化
test('后台用户管理：停用控制台用户并核对持久化', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const username = `e2edit${TAG}`
  await login(page)
  await page.getByRole('button', { name: /用户管理|Users/ }).click()

  // 新建一个用户
  await page.getByRole('button', { name: /新增用户|Add user/ }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input:not([type="password"])').first().fill(username)
  await modal.locator('input[type="password"]').fill('secret12345')
  await modal.locator('.modal-actions button').last().click()

  // 该用户行出现，状态“启用”→ 点击停用
  const row = page.locator('table tbody tr').filter({ hasText: username })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.getByRole('button', { name: '启用' }).click()
  await expect(row.getByRole('button', { name: '停用' })).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-user-disable.png`, fullPage: true })

  // 离开再回 → 该用户仍是停用态
  await page.getByRole('button', { name: /聊天记录|Chats/ }).click()
  await page.getByRole('button', { name: /用户管理|Users/ }).click()
  await expect(
    page.locator('table tbody tr').filter({ hasText: username }).getByRole('button', { name: '停用' })
  ).toBeVisible({ timeout: 10_000 })
})
