import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })

// 后台登录错误路径：密码错时给出「账号或密码错误」提示且不进后台；改对后正常进入。
// 所有后台用例都是成功登录，登录失败提示此前没测。也顺带覆盖 req() 把服务端具体错误
// 透传出来（此前 req 吞成「HTTP 401」，已修）。
test('后台登录：密码错误给出提示且不进入后台，改对后可进', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('wrong-password-999')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()

  // 显示错误、且透传服务端「账号或密码错误」，仍停在登录页（无侧栏）
  const err = page.locator('.err')
  await expect(err).toBeVisible({ timeout: 10_000 })
  await expect(err).toContainText('密码错误')
  await expect(page.locator('.sidebar-nav')).toHaveCount(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-login-fail.png`, fullPage: true })

  // 改对密码 → 正常进入后台
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
})
