import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function planDesc(token: string, name: string): Promise<string | undefined> {
  const r = (await fetch(`${API}/api/admin/plans`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { plans?: Array<{ name: string; description?: string }> }
  return (r.plans ?? []).find((p) => p.name === name)?.description
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 后台套餐描述编辑弹窗：plan-create 只验创建，套餐描述的弹窗编辑（DescModal → updatePlan）从未覆盖。
test('后台计费：编辑套餐描述并持久化', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const name = `描述套餐${TAG}`
  const desc = `尊享E2E${TAG}：优先客服 + 更高并发`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 建一个无描述的套餐
  await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, priceCents: 1500, periodUnit: 'month', periodCount: 1, maxAccounts: 10, maxDevices: 0 })
  })
  expect(await planDesc(admin.token, name)).toBeFalsy()

  await login(page)
  await page.getByRole('button', { name: /计费管理|Billing/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })
  // 描述列初始为「—」
  await expect(row.locator('.desc-cell span')).toHaveText('—')

  // 点描述列「编辑」→ 弹窗填描述 → 保存
  await row.locator('.desc-cell').getByRole('button', { name: '编辑' }).click()
  const modal = page.locator('.modal', { hasText: '套餐描述' })
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('textarea').fill(desc)
  await modal.getByRole('button', { name: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 描述列显示（截断）该描述，且落库
  await expect(row.locator('.desc-cell span')).toContainText(`尊享E2E${TAG}`)
  await expect.poll(() => planDesc(admin.token, name), { timeout: 10_000 }).toBe(desc)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-plan-desc-edit.png`, fullPage: true })
})
