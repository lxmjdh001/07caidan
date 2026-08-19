import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function seedLog(deviceId: string, version: string, message: string): Promise<void> {
  const res = await fetch(`${API}/api/logs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId, appVersion: version, osType: 'darwin', osVersion: '25.5',
      entries: [{ level: 'error', scope: 'e2e', message, at: Date.now() }]
    })
  })
  if (!res.ok) throw new Error(`seed log failed: ${res.status}`)
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// M19 客户端日志设备下钻：点设备概览某行 → 明细表按该设备筛选（其它设备日志消失）。
// client-logs 只验了设备行可见，点击行筛选此前没测。
test('后台客户端日志：点设备行筛选该设备明细', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-6)
  const devA = ('a' + Date.now().toString(16)).padEnd(8, '0').slice(0, 32)
  const devB = ('b' + (Date.now() + 1).toString(16)).padEnd(8, '0').slice(0, 32)
  const verA = `vA-${TAG}`
  const verB = `vB-${TAG}`
  const msgA = `设备A错误${TAG}`
  const msgB = `设备B错误${TAG}`
  await seedLog(devA, verA, msgA)
  await seedLog(devB, verB, msgB)

  await login(page)
  await page.getByRole('button', { name: '客户端日志' }).click()

  // 默认 ≥warn：两台设备的 error 明细都在
  await expect(page.getByText(msgA)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(msgB)).toBeVisible()

  // 点设备 A 概览行（按其唯一版本定位；版本只出现在概览表）→ 行选中，明细只剩 A
  const rowA = page.locator('table.data-table tbody tr').filter({ hasText: verA })
  await expect(rowA).toBeVisible({ timeout: 10_000 })
  await rowA.locator('td').first().click()
  await expect(rowA).toHaveClass(/row-on/, { timeout: 10_000 })

  await expect(page.getByText(msgA)).toBeVisible()
  await expect(page.getByText(msgB)).toHaveCount(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-client-logs-device-filter.png`, fullPage: true })

  // 再点一次取消筛选 → B 的明细回来
  await rowA.locator('td').first().click()
  await expect(rowA).not.toHaveClass(/row-on/, { timeout: 10_000 })
  await expect(page.getByText(msgB)).toBeVisible({ timeout: 10_000 })
})
