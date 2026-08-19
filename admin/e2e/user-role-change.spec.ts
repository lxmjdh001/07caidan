import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function roleOf(token: string, username: string): Promise<string | undefined> {
  const r = (await fetch(`${API}/api/users`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { users?: Array<{ username: string; role: string }> }
  return (r.users ?? []).find((u) => u.username === username)?.role
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 后台用户管理：修改用户角色（只读 → 客服）落库并回显。user-create/user-disable
// 未覆盖角色下拉这条 changeRole 交互。
test('后台用户管理：修改用户角色并持久化', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const username = `roleuser${TAG}`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 建一个「只读」用户
  const created = await fetch(`${API}/api/users`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret12345', role: 'viewer' })
  })
  expect(created.ok).toBeTruthy()
  expect(await roleOf(admin.token, username)).toBe('viewer')

  await login(page)
  await page.getByRole('button', { name: /用户管理|Users/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: username })
  await expect(row).toBeVisible({ timeout: 10_000 })
  const roleSel = row.locator('select')
  await expect(roleSel).toHaveValue('viewer')

  // 改角色为「客服」(agent)
  await roleSel.selectOption('agent')
  await expect(roleSel).toHaveValue('agent')
  // 落库校验
  await expect.poll(() => roleOf(admin.token, username), { timeout: 10_000 }).toBe('agent')

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-user-role-change.png`, fullPage: true })
})
