import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 截图落盘目录：默认 e2e/shots（已 gitignore）；CI/调试可用 SHOT_DIR 覆盖 */
const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400) // 等布局与数据渲染稳定
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true })
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('管理后台逐页截图冒烟', async ({ page }) => {
  await login(page)
  await shot(page, 'admin-01-after-login')

  // 侧栏每个页签都点一遍并截图（owner 账号有全部权限）
  const navButtons = page.locator('.sidebar-nav button')
  const count = await navButtons.count()
  for (let i = 0; i < count; i++) {
    const label = (await navButtons.nth(i).innerText()).trim().replace(/\s+/g, '-') || `nav-${i}`
    await navButtons.nth(i).click()
    await shot(page, `admin-page-${String(i + 1).padStart(2, '0')}-${label}`)
  }
})
