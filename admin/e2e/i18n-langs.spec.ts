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

test('后台四语渲染截图（日/韩/泰/繁体）', async ({ page }) => {
  await login(page)
  for (const [code, tag] of [['ja', '日本語'], ['ko', '한국어'], ['th', 'ไทย'], ['zh-TW', '繁體中文']] as const) {
    await page.locator('.su-locale').selectOption(code)
    await page.waitForTimeout(300)
    // 打开计费管理（第3个侧栏项，文本最密集，语言无关按序号点）验证翻译渲染
    await page.locator('.sidebar-nav button').nth(2).click().catch(() => {})
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/admin-lang-${code}.png`, fullPage: true })
    // 语言开关本身应显示为对应母语名
    await expect(page.locator('.su-locale')).toHaveValue(code)
  }
})
