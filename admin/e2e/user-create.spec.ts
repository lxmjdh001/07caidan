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

test('后台用户管理：新建管理员用户并在列表核对', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /用户管理|Users/ }).click()

  // 打开新建用户弹窗
  await page.getByRole('button', { name: /新增用户|Add user/ }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input:not([type="password"])').first().fill('e2euser')
  await modal.locator('input[type="password"]').fill('secret12345')
  // 提交（模态框操作区的非取消按钮）
  await modal.locator('.modal-actions button').last().click()

  // 用户表出现新用户
  const row = page.locator('table tbody tr').filter({ hasText: 'e2euser' })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-user-create.png`, fullPage: true })
})
