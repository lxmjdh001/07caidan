import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

// 深色：模拟系统 prefers-color-scheme: dark（后台跟随系统）
test.use({ colorScheme: 'dark' })

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

test('后台深色：逐页截图人工校对', async ({ page }) => {
  await login(page)
  const navButtons = page.locator('.sidebar-nav button')
  const count = await navButtons.count()
  for (let i = 0; i < count; i++) {
    const label = (await navButtons.nth(i).innerText()).trim().replace(/\s+/g, '-') || `nav-${i}`
    await navButtons.nth(i).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/dark-admin-${String(i + 1).padStart(2, '0')}-${label}.png`, fullPage: true })
  }
})
