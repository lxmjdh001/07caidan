import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const API = 'http://127.0.0.1:8798'

async function permsOf(token: string, username: string): Promise<string[] | undefined> {
  const r = (await fetch(`${API}/api/users`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json())) as { users?: Array<{ username: string; permissions: string[] }> }
  return (r.users ?? []).find((u) => u.username === username)?.permissions
}

async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('input[placeholder="admin"]').fill('admin')
  await page.locator('input[type="password"]').fill('admin')
  await page.getByRole('button', { name: /登录|Sign in|Login/i }).click()
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 15_000 })
}

// 后台 RBAC 直授权限：给「只读」用户在角色预设之外勾一项具体权限 → togglePerm 落库。
// user-create/user-disable/user-role-change 都没碰过权限格的直接勾选。
test('后台用户管理：在角色预设外直授一项权限并持久化', async ({ page }) => {
  const TAG = Date.now().toString(36).slice(-5)
  const username = `permuser${TAG}`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const created = await fetch(`${API}/api/users`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret12345', role: 'viewer' })
  })
  expect(created.ok).toBeTruthy()
  // 只读用户初始无直授权限
  expect(await permsOf(admin.token, username)).toEqual([])

  await login(page)
  await page.getByRole('button', { name: /用户管理|Users/ }).click()

  const row = page.locator('table tbody tr').filter({ hasText: username })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 预设内权限（如「查看聊天记录」）复选框 disabled；预设外的可勾。取第一个可勾的直授。
  const grantable = row.locator('td.perm-cell input:not([disabled])').first()
  await expect(grantable).not.toBeChecked()
  await grantable.click()
  await expect(grantable).toBeChecked({ timeout: 10_000 })

  // 落库：恰好多出一项直授权限
  await expect.poll(async () => (await permsOf(admin.token, username))?.length ?? -1, { timeout: 10_000 }).toBe(1)

  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/admin-user-perm-grant.png`, fullPage: true })
})
