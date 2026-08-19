import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const SERVER = 'http://127.0.0.1:8798'

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 客户端日志（M19）：游客免令牌上报一条 error 日志 → 后台设备概览 + 明细表可见
test('后台客户端日志：游客上报的 error 日志在概览与明细里可见', async ({ page }) => {
  const TAG = Date.now().toString(36)
  const deviceId = `e2eda7a${TAG}`.replace(/[^a-f0-9]/gi, '').padEnd(8, '0').slice(0, 32)

  // 游客（无 Bearer）上报：登录前崩溃最需要日志，此路由对游客开放
  const res = await page.request.post(`${SERVER}/api/logs`, {
    data: {
      deviceId,
      appVersion: '9.9.9',
      osType: 'darwin',
      osVersion: '25.5.0',
      entries: [{ level: 'error', scope: 'e2e-probe', message: `客户端崩溃探针 ${TAG}`, at: Date.now() }]
    }
  })
  expect(res.ok()).toBeTruthy()
  expect((await res.json()).added).toBe(1)

  await login(page)
  await page.getByRole('button', { name: '客户端日志' }).click()

  // 设备概览：出现该版本的设备行（游客用户 + errors 计数）
  const deviceRow = page.locator('table.data-table tbody tr').filter({ hasText: '9.9.9' })
  await expect(deviceRow.first()).toBeVisible({ timeout: 10_000 })

  // 明细表（默认 ≥warn，error 命中）：出现探针消息
  await expect(page.getByText(`客户端崩溃探针 ${TAG}`)).toBeVisible({ timeout: 10_000 })
  // 级别标签渲染
  await expect(page.locator('.log-level.error').first()).toBeVisible()

  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/admin-client-logs.png`, fullPage: true })
})
