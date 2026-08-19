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

test('计费套餐：新建带「设备上限」的套餐并在列表核对', async ({ page }) => {
  // 唯一名：共享持久 DB 里固定名会越积越多，触发严格模式多元素命中
  const name = `三设备套餐${Date.now().toString(36).slice(-5)}`
  await login(page)

  // 进入「计费管理」→ 默认「套餐」页签
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()
  await expect(page.getByRole('heading', { name: /新建套餐|New plan/i })).toBeVisible()

  // 填表：套餐名 + 设备上限=3，其余用默认
  const form = page.locator('section.card').filter({ hasText: /新建套餐|New plan/i })
  await form.locator('label').filter({ hasText: /套餐名称|Plan name/i }).locator('input').fill(name)
  await form.locator('label').filter({ hasText: /设备上限|Device limit/i }).locator('input').fill('3')
  await form.getByRole('button', { name: /^创建$|^Create$/ }).click()

  // 列表出现该套餐，且「设备上限」列为 3
  const row = page.locator('table.data-table tbody tr').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  // num 列顺序：价格 / 账号上限 / 设备上限
  await expect(row.locator('td.num').nth(2)).toHaveText('3')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/device-01-plan-with-device-limit.png`, fullPage: true })
})
