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

// M19 远程调级排障：客服后台把某登录用户的设备日志级别调到 debug，
// 该用户客户端下次上报日志时，服务端在响应里回带 level=debug 告诉它按 debug 上报。
// client-logs-pagination 只覆盖游客日志的分页；「按登录用户调级别」这条排障闭环此前没测。
test('后台客户端日志：把登录用户设备调到 debug，其下次上报被告知按 debug 上报', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)

  const deviceId = (TAG + Math.random().toString(16).slice(2)).replace(/[^a-f0-9]/gi, '0').padEnd(16, '0').slice(0, 16)
  const post = (): Promise<{ level?: string }> =>
    fetch(`${API}/api/logs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId, appVersion: '7.7.7', osType: 'darwin', osVersion: '25.5',
        entries: [{ level: 'warn', scope: 'e2e', message: `hb-${TAG}`, at: Date.now() }]
      })
    }).then((r) => r.json() as Promise<{ level?: string }>)

  // 首次带令牌上报 → 设备登记为该登录用户；默认级别 warn
  const first = await post()
  expect(first.level).toBe('warn')

  await login(page)
  await page.getByRole('button', { name: '客户端日志' }).click()

  // 该登录用户的设备行：按唯一 deviceId 定位（同一用户可有多台设备行），邮箱可见、级别下拉默认 warn
  const row = page
    .locator('table.data-table tbody tr', { hasText: email })
    .filter({ has: page.locator(`code:has-text("${deviceId.slice(0, 8)}")`) })
  await expect(row).toBeVisible({ timeout: 10_000 })
  const sel = row.locator('select')
  await expect(sel).toHaveValue('warn')

  // 调到 debug（受控 select 绑定 fetch 回来的 levels，用 selectOption + 轮询确认落库）
  await sel.selectOption('debug')
  await expect(sel).toHaveValue('debug', { timeout: 10_000 })

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-log-level-userdevice.png`, fullPage: true })

  // 排障闭环：该用户客户端下次上报，服务端回带 level=debug（告诉它按 debug 上报）
  const second = await post()
  expect(second.level).toBe('debug')
})
