import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M19 客户端日志级别过滤：默认 ≥warn 隐藏 debug，切到 ≥debug 才显示
test('后台客户端日志：级别过滤（debug 默认隐藏）', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const debugMsg = `调试细节${TAG}`
  const errMsg = `严重错误${TAG}`
  const deviceId = `f11${TAG}`.replace(/[^a-f0-9]/gi, '').padEnd(8, '0').slice(0, 32)
  const res = await fetch(`${API}/api/logs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId, appVersion: '9.9.9', osType: 'darwin', osVersion: '25.5',
      entries: [
        { level: 'debug', scope: 'e2e', message: debugMsg, at: Date.now() },
        { level: 'error', scope: 'e2e', message: errMsg, at: Date.now() }
      ]
    })
  })
  expect(res.ok).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: '客户端日志' }).click()

  // 默认 ≥warn：error 可见，debug 隐藏
  await expect(page.getByText(errMsg)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(debugMsg)).toHaveCount(0)

  // 切到 ≥debug → debug 也显示
  await page.locator('.log-toolbar select').selectOption('debug')
  await expect(page.getByText(debugMsg)).toBeVisible({ timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-log-level-filter.png`, fullPage: true })
})
