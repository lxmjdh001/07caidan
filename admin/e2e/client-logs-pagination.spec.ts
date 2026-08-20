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

// M19 客户端日志分页：某关键词命中 >50 条时，明细表分页，点「下一页」看到后续条目。
// client-logs/log-level-filter 只在单页内验展示，翻页交互此前没测。
test('后台客户端日志：命中超一页时翻页', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const KEY = `分页探针${TAG}`
  const now = Date.now()
  // 51 条 error 日志（同一关键词），FIRST 最新(第 1 页)、LAST 最旧(第 2 页)
  const entries = Array.from({ length: 51 }, (_, i) => ({
    level: 'error', scope: 'e2e-page',
    message: `${KEY}-${i === 0 ? 'FIRST' : i === 50 ? 'LAST' : `m${i}`}`,
    at: now - i * 1000
  }))
  const res = await fetch(`${API}/api/logs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: `pg${TAG}`.padEnd(8, '0').replace(/[^a-f0-9]/gi, '0').slice(0, 32), appVersion: '7.7.7', osType: 'darwin', osVersion: '25.5', entries })
  })
  expect(res.ok).toBeTruthy()

  await login(page)
  await page.getByRole('button', { name: '客户端日志' }).click()
  // 搜索该关键词 → 命中 51 条
  await page.getByPlaceholder(/搜索日志内容/).fill(KEY)

  // 排序按 id DESC（批量插入 createdAt 相同）：LAST(最后插入) 在第 1 页、FIRST(最先插入) 在第 2 页
  // 第 1 页：LAST 在、FIRST 不在
  await expect(page.getByText(`${KEY}-LAST`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(`${KEY}-FIRST`)).toHaveCount(0)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-client-logs-pagination.png`, fullPage: true })

  // 下一页：FIRST 在、LAST 不在
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByText(`${KEY}-FIRST`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(`${KEY}-LAST`)).toHaveCount(0)
})
